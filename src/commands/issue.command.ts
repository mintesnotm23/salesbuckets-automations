import type { App, BlockAction } from "@slack/bolt";
import { structureIssue, type StructuredIssue } from "../services/openai.service";
import { jiraService } from "../services/jira.service";
import { validateCommandInput, withTimeout, escapeSlackMarkdown } from "../utils/helpers";

interface PendingIssue {
  data: StructuredIssue;
  expiresAt: number;
}

// Stores pending issues keyed by user+channel for confirmation flow
const pendingIssues = new Map<string, PendingIssue>();

const PENDING_TTL_MS = 10 * 60 * 1000; // 10 minutes

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

function buildIssuePreview(structured: StructuredIssue) {
  const acList = structured.acceptanceCriteria.map((ac) => `  - ${ac}`).join("\n");
  return [
    {
      type: "section" as const,
      text: {
        type: "mrkdwn" as const,
        text: `*Here's the structured issue:*\n\n*Title:* ${escapeSlackMarkdown(structured.title)}\n*Priority:* ${structured.priority}\n*Labels:* ${structured.labels.join(", ")}\n\n*Description:*\n${escapeSlackMarkdown(structured.description)}\n\n*Acceptance Criteria:*\n${acList}`,
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
          type: "button" as const,
          text: { type: "plain_text" as const, text: "Edit" },
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
  app.command("/issue", async ({ command, ack, respond }) => {
    await ack();

    const validationError = validateCommandInput(command.text);
    if (validationError) {
      await respond(`${validationError} Usage: \`/issue <description>\``);
      return;
    }

    await respond({
      text: ":hourglass_flowing_sand: Processing your issue with AI...",
      response_type: "ephemeral",
    });

    try {
      const structured = await withTimeout(structureIssue(command.text), 25000, "AI processing timed out");
      const pendingKey = getPendingKey(command.user_id, command.channel_id);
      pendingIssues.set(pendingKey, { data: structured, expiresAt: Date.now() + PENDING_TTL_MS });

      await respond({
        response_type: "ephemeral",
        blocks: buildIssuePreview(structured),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error("Error processing issue:", message);
      await respond(`Something went wrong: ${message}. Please try again.`);
    }
  });

  // Confirm → create in Jira
  app.action("issue_confirm", async ({ body, ack, respond }) => {
    await ack();
    const actionBody = body as BlockAction;
    const pendingKey = getPendingKey(actionBody.user.id, actionBody.channel?.id);
    const entry = pendingIssues.get(pendingKey);

    if (!entry) {
      await respond("No pending issue found (may have expired). Please use `/issue` again.");
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

      pendingIssues.delete(pendingKey);

      await respond({
        response_type: "in_channel",
        text: `:white_check_mark: Issue created: <${jiraIssue.url}|${jiraIssue.key}> — *${escapeSlackMarkdown(issue.title)}*`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error("Error creating Jira issue:", message);
      await respond(`Failed to create Jira issue: ${message}`);
    }
  });

  // Edit → open modal with pre-filled values
  app.action("issue_edit", async ({ body, ack, client }) => {
    await ack();
    const actionBody = body as BlockAction;
    const pendingKey = getPendingKey(actionBody.user.id, actionBody.channel?.id);
    const entry = pendingIssues.get(pendingKey);

    if (!entry) return;

    const issue = entry.data;

    await client.views.open({
      trigger_id: actionBody.trigger_id,
      view: {
        type: "modal",
        callback_id: "issue_edit_submit",
        private_metadata: JSON.stringify({ channelId: actionBody.channel?.id }),
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

  // Handle modal submission
  app.view("issue_edit_submit", async ({ ack, view, body }) => {
    await ack();

    const values = view.state.values;
    const title = values.title_block.title_input.value || "";
    const description = values.description_block.description_input.value || "";
    const priority = values.priority_block.priority_input.selected_option?.value || "Medium";
    const labels = (values.labels_block.labels_input.value || "")
      .split(",")
      .map((l: string) => l.trim())
      .filter(Boolean);
    const acceptanceCriteria = (values.ac_block.ac_input.value || "")
      .split("\n")
      .map((l: string) => l.trim())
      .filter(Boolean);

    const metadata = JSON.parse(view.private_metadata || "{}");
    const pendingKey = getPendingKey(body.user.id, metadata.channelId);

    const updated: StructuredIssue = {
      title,
      description,
      priority: priority as StructuredIssue["priority"],
      labels,
      acceptanceCriteria,
    };

    pendingIssues.set(pendingKey, { data: updated, expiresAt: Date.now() + PENDING_TTL_MS });

    // Post the updated preview back to the channel
    try {
      await app.client.chat.postEphemeral({
        channel: metadata.channelId,
        user: body.user.id,
        blocks: buildIssuePreview(updated),
        text: "Updated issue preview",
      });
    } catch (error) {
      console.error("Failed to post updated preview:", error);
    }
  });

  // Cancel
  app.action("issue_cancel", async ({ body, ack, respond }) => {
    await ack();
    const actionBody = body as BlockAction;
    const pendingKey = getPendingKey(actionBody.user.id, actionBody.channel?.id);
    pendingIssues.delete(pendingKey);
    await respond({ response_type: "ephemeral", text: "Issue cancelled." });
  });
}
