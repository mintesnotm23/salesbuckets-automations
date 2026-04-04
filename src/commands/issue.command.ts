import type { App, BlockAction } from "@slack/bolt";
import axios from "axios";
import { structureIssue, applyConversationalEdit, type StructuredIssue } from "../services/openai.service";
import { jiraService } from "../services/jira.service";
import { validateCommandInput, withTimeout, escapeSlackMarkdown, truncateForSlack } from "../utils/helpers";
import { config } from "../config";

interface FileAttachment {
  url: string;
  name: string;
  mimetype: string;
}

interface PendingIssue {
  data: StructuredIssue;
  expiresAt: number;
  userId: string;
  channelId: string;
  messageTs: string;
  attachments: FileAttachment[];
}

// Stores pending issues keyed by userId-channelId
const pendingIssues = new Map<string, PendingIssue>();

const PENDING_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

// Cleanup expired entries every minute
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of pendingIssues.entries()) {
    if (entry.expiresAt < now) pendingIssues.delete(key);
  }
}, 60_000);

function getPendingKey(userId: string, channelId?: string): string {
  return `${userId}-${channelId || "dm"}`;
}

function findPendingByThreadTs(threadTs: string): [string, PendingIssue] | undefined {
  for (const [key, entry] of pendingIssues.entries()) {
    if (entry.messageTs === threadTs) return [key, entry];
  }
  return undefined;
}

function buildIssuePreview(structured: StructuredIssue, attachmentCount = 0) {
  const acList = structured.acceptanceCriteria.length > 0
    ? structured.acceptanceCriteria.map((ac) => `  - ${ac}`).join("\n")
    : "  _(none specified)_";

  let previewText = `*Here's the structured issue:*\n\n*Title:* ${escapeSlackMarkdown(structured.title)}\n*Priority:* ${structured.priority}\n*Labels:* ${structured.labels.join(", ") || "_(none)_"}\n\n*Description:*\n${escapeSlackMarkdown(structured.description)}\n\n*Acceptance Criteria:*\n${acList}`;

  if (attachmentCount > 0) {
    previewText += `\n\n:paperclip: ${attachmentCount} file${attachmentCount > 1 ? "s" : ""} attached`;
  }

  previewText += "\n\n_Reply in this thread to edit (e.g. \"change priority to low\"), or use the buttons below._";

  return [
    {
      type: "section" as const,
      text: {
        type: "mrkdwn" as const,
        text: truncateForSlack(previewText),
      },
    },
    {
      type: "actions" as const,
      elements: [
        {
          type: "button" as const,
          text: { type: "plain_text" as const, text: "Create in Jira" },
          style: "primary" as const,
          action_id: "issue_confirm",
        },
        {
          type: "static_select" as const,
          action_id: "issue_quick_priority",
          placeholder: { type: "plain_text" as const, text: `Priority: ${structured.priority}` },
          options: (["Highest", "High", "Medium", "Low", "Lowest"] as const).map((p) => ({
            text: { type: "plain_text" as const, text: p },
            value: p,
          })),
        },
        {
          type: "button" as const,
          text: { type: "plain_text" as const, text: "Edit All" },
          action_id: "issue_edit",
        },
        {
          type: "button" as const,
          text: { type: "plain_text" as const, text: "Cancel" },
          style: "danger" as const,
          action_id: "issue_cancel",
        },
      ],
    },
  ];
}

export function registerIssueCommand(app: App) {
  // --- /issue command ---
  app.command("/issue", async ({ command, ack, client }) => {
    await ack();

    const validationError = validateCommandInput(command.text);
    if (validationError) {
      await client.chat.postEphemeral({
        channel: command.channel_id,
        user: command.user_id,
        text: `${validationError} Usage: \`/issue <description>\``,
      });
      return;
    }

    // Post a loading message
    const loadingMsg = await client.chat.postMessage({
      channel: command.channel_id,
      text: ":hourglass_flowing_sand: Processing your issue with AI...",
    });

    try {
      const structured = await withTimeout(structureIssue(command.text), 25000, "AI processing timed out");
      const pendingKey = getPendingKey(command.user_id, command.channel_id);

      // Post the preview as a regular message (enables threading)
      const previewMsg = await client.chat.update({
        channel: command.channel_id,
        ts: loadingMsg.ts!,
        blocks: buildIssuePreview(structured),
        text: `Issue preview: ${structured.title}`,
      });

      pendingIssues.set(pendingKey, {
        data: structured,
        expiresAt: Date.now() + PENDING_TTL_MS,
        userId: command.user_id,
        channelId: command.channel_id,
        messageTs: previewMsg.ts!,
        attachments: [],
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error("Error processing issue:", message);
      await client.chat.update({
        channel: command.channel_id,
        ts: loadingMsg.ts!,
        text: `Something went wrong: ${message}. Please try again.`,
      });
    }
  });

  // --- Thread-based conversational editing ---
  app.message(async ({ message, client }) => {
    const msg = message as any;

    // Only process threaded replies
    if (!msg.thread_ts || msg.bot_id || msg.subtype) return;

    // Find the pending issue for this thread
    const found = findPendingByThreadTs(msg.thread_ts);
    if (!found) return;

    const [pendingKey, entry] = found;

    // Only the creator can edit
    if (msg.user !== entry.userId) return;

    // Handle file attachments
    if (msg.files && msg.files.length > 0) {
      for (const file of msg.files) {
        if (file.size && file.size > MAX_FILE_SIZE) {
          await client.chat.postMessage({
            channel: entry.channelId,
            thread_ts: entry.messageTs,
            text: `:warning: File \`${file.name}\` is too large (max 10MB). Skipped.`,
          });
          continue;
        }

        entry.attachments.push({
          url: file.url_private_download || file.url_private || "",
          name: file.name || "unnamed",
          mimetype: file.mimetype || "application/octet-stream",
        });

        await client.chat.postMessage({
          channel: entry.channelId,
          thread_ts: entry.messageTs,
          text: `:paperclip: Attached \`${file.name}\` — will be uploaded to Jira when you confirm.`,
        });
      }

      // Update preview to show attachment count
      await client.chat.update({
        channel: entry.channelId,
        ts: entry.messageTs,
        blocks: buildIssuePreview(entry.data, entry.attachments.length),
        text: `Issue preview: ${entry.data.title}`,
      });

      entry.expiresAt = Date.now() + PENDING_TTL_MS;
      return;
    }

    // Handle text edits
    const userText = msg.text;
    if (!userText || !userText.trim()) return;

    try {
      await client.chat.postMessage({
        channel: entry.channelId,
        thread_ts: entry.messageTs,
        text: ":hourglass_flowing_sand: Applying your changes...",
      });

      const updated = await withTimeout(
        applyConversationalEdit(entry.data, userText),
        20000,
        "AI edit timed out"
      );

      entry.data = updated;
      entry.expiresAt = Date.now() + PENDING_TTL_MS;
      pendingIssues.set(pendingKey, entry);

      // Update the preview in-place
      await client.chat.update({
        channel: entry.channelId,
        ts: entry.messageTs,
        blocks: buildIssuePreview(updated, entry.attachments.length),
        text: `Issue preview: ${updated.title}`,
      });

      await client.chat.postMessage({
        channel: entry.channelId,
        thread_ts: entry.messageTs,
        text: ":white_check_mark: Updated! Review the changes above.",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error("Error applying conversational edit:", message);
      await client.chat.postMessage({
        channel: entry.channelId,
        thread_ts: entry.messageTs,
        text: `Sorry, couldn't apply that change: ${message}`,
      });
    }
  });

  // --- Quick priority change ---
  app.action("issue_quick_priority", async ({ body, ack, client }) => {
    await ack();
    const actionBody = body as BlockAction;
    const pendingKey = getPendingKey(actionBody.user.id, actionBody.channel?.id);
    const entry = pendingIssues.get(pendingKey);

    if (!entry) return;

    const selected = (actionBody.actions[0] as any).selected_option?.value;
    if (!selected) return;

    entry.data.priority = selected as StructuredIssue["priority"];
    entry.expiresAt = Date.now() + PENDING_TTL_MS;

    await client.chat.update({
      channel: entry.channelId,
      ts: entry.messageTs,
      blocks: buildIssuePreview(entry.data, entry.attachments.length),
      text: `Issue preview: ${entry.data.title}`,
    });
  });

  // --- Confirm → create in Jira ---
  app.action("issue_confirm", async ({ body, ack, client }) => {
    await ack();
    const actionBody = body as BlockAction;
    const pendingKey = getPendingKey(actionBody.user.id, actionBody.channel?.id);
    const entry = pendingIssues.get(pendingKey);

    if (!entry) {
      if (actionBody.channel?.id) {
        await client.chat.postEphemeral({
          channel: actionBody.channel.id,
          user: actionBody.user.id,
          text: "No pending issue found (may have expired). Please use `/issue` again.",
        });
      }
      return;
    }

    const issue = entry.data;

    try {
      const fullDescription = `${issue.description}\n\nAcceptance Criteria:\n${issue.acceptanceCriteria.map((ac) => `- ${ac}`).join("\n")}`;

      const jiraIssue = await withTimeout(
        jiraService.createIssue({
          title: issue.title,
          description: fullDescription,
          priority: issue.priority,
          labels: issue.labels,
        }),
        10000,
        "Jira request timed out"
      );

      // Upload attachments
      for (const attachment of entry.attachments) {
        try {
          const fileResponse = await axios.get(attachment.url, {
            headers: { Authorization: `Bearer ${config.slack.botToken}` },
            responseType: "arraybuffer",
            timeout: 30000,
          });
          await jiraService.addAttachment(jiraIssue.key, Buffer.from(fileResponse.data), attachment.name);
        } catch (error) {
          console.error(`Failed to upload attachment ${attachment.name}:`, error);
        }
      }

      pendingIssues.delete(pendingKey);

      const attachmentNote = entry.attachments.length > 0
        ? ` (${entry.attachments.length} file${entry.attachments.length > 1 ? "s" : ""} attached)`
        : "";

      // Update the preview message to show success
      await client.chat.update({
        channel: entry.channelId,
        ts: entry.messageTs,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `:white_check_mark: Issue created: <${jiraIssue.url}|${jiraIssue.key}> — *${escapeSlackMarkdown(issue.title)}*${attachmentNote}`,
            },
          },
        ],
        text: `Issue created: ${jiraIssue.key}`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error("Error creating Jira issue:", message);
      if (actionBody.channel?.id) {
        await client.chat.postEphemeral({
          channel: actionBody.channel.id,
          user: actionBody.user.id,
          text: `Failed to create Jira issue: ${message}`,
        });
      }
    }
  });

  // --- Edit All → open modal with pre-filled values ---
  app.action("issue_edit", async ({ body, ack, client, respond }) => {
    await ack();
    const actionBody = body as BlockAction;
    const pendingKey = getPendingKey(actionBody.user.id, actionBody.channel?.id);
    const entry = pendingIssues.get(pendingKey);

    if (!entry) {
      await respond({
        response_type: "ephemeral",
        text: "This issue has expired (10 minutes). Please use `/issue` again.",
      });
      return;
    }

    if (!actionBody.channel?.id) {
      await respond({ response_type: "ephemeral", text: "Cannot edit in this context." });
      return;
    }

    const issue = entry.data;

    await client.views.open({
      trigger_id: actionBody.trigger_id,
      view: {
        type: "modal",
        callback_id: "issue_edit_submit",
        private_metadata: JSON.stringify({
          channelId: actionBody.channel.id,
          messageTs: entry.messageTs,
        }),
        title: { type: "plain_text", text: "Edit Issue" },
        submit: { type: "plain_text", text: "Update" },
        close: { type: "plain_text", text: "Cancel" },
        blocks: [
          {
            type: "input",
            block_id: "title_block",
            label: { type: "plain_text", text: "Title" },
            element: {
              type: "plain_text_input",
              action_id: "title_input",
              initial_value: issue.title,
            },
          },
          {
            type: "input",
            block_id: "description_block",
            label: { type: "plain_text", text: "Description" },
            element: {
              type: "plain_text_input",
              action_id: "description_input",
              multiline: true,
              initial_value: issue.description,
            },
          },
          {
            type: "input",
            block_id: "priority_block",
            label: { type: "plain_text", text: "Priority" },
            element: {
              type: "static_select",
              action_id: "priority_input",
              initial_option: {
                text: { type: "plain_text", text: issue.priority },
                value: issue.priority,
              },
              options: ["Highest", "High", "Medium", "Low", "Lowest"].map((p) => ({
                text: { type: "plain_text", text: p },
                value: p,
              })),
            },
          },
          {
            type: "input",
            block_id: "labels_block",
            label: { type: "plain_text", text: "Labels (comma-separated)" },
            element: {
              type: "plain_text_input",
              action_id: "labels_input",
              initial_value: issue.labels.join(", "),
            },
          },
          {
            type: "input",
            block_id: "ac_block",
            label: { type: "plain_text", text: "Acceptance Criteria (one per line)" },
            element: {
              type: "plain_text_input",
              action_id: "ac_input",
              multiline: true,
              initial_value: issue.acceptanceCriteria.join("\n"),
            },
          },
        ],
      },
    });
  });

  // --- Handle modal submission ---
  app.view("issue_edit_submit", async ({ ack, view, body }) => {
    await ack();

    const values = view.state.values;
    const title = values.title_block?.title_input?.value || "";
    const description = values.description_block?.description_input?.value || "";
    const priority = values.priority_block?.priority_input?.selected_option?.value || "Medium";
    const labels = (values.labels_block?.labels_input?.value || "")
      .split(",")
      .map((l: string) => l.trim())
      .filter(Boolean);
    const acceptanceCriteria = (values.ac_block?.ac_input?.value || "")
      .split("\n")
      .map((l: string) => l.trim())
      .filter(Boolean);

    const metadata = JSON.parse(view.private_metadata || "{}");
    if (!metadata.channelId) return;

    const pendingKey = getPendingKey(body.user.id, metadata.channelId);
    const entry = pendingIssues.get(pendingKey);

    const updated: StructuredIssue = {
      title,
      description,
      priority: priority as StructuredIssue["priority"],
      labels,
      acceptanceCriteria,
    };

    const attachments = entry?.attachments || [];
    const messageTs = metadata.messageTs || entry?.messageTs;

    pendingIssues.set(pendingKey, {
      data: updated,
      expiresAt: Date.now() + PENDING_TTL_MS,
      userId: body.user.id,
      channelId: metadata.channelId,
      messageTs: messageTs || "",
      attachments,
    });

    // Update the preview message in-place
    if (messageTs) {
      try {
        await app.client.chat.update({
          channel: metadata.channelId,
          ts: messageTs,
          blocks: buildIssuePreview(updated, attachments.length),
          text: `Issue preview: ${updated.title}`,
        });
      } catch (error) {
        console.error("Failed to update preview message:", error);
      }
    }
  });

  // --- Cancel ---
  app.action("issue_cancel", async ({ body, ack, client }) => {
    await ack();
    const actionBody = body as BlockAction;
    const pendingKey = getPendingKey(actionBody.user.id, actionBody.channel?.id);
    const entry = pendingIssues.get(pendingKey);

    pendingIssues.delete(pendingKey);

    if (entry) {
      await client.chat.update({
        channel: entry.channelId,
        ts: entry.messageTs,
        blocks: [
          {
            type: "section",
            text: { type: "mrkdwn", text: ":x: Issue cancelled." },
          },
        ],
        text: "Issue cancelled.",
      });
    }
  });
}
