import type { App, BlockAction, SlackActionMiddlewareArgs } from "@slack/bolt";
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

      const acList = structured.acceptanceCriteria.map((ac) => `  - ${ac}`).join("\n");

      await respond({
        response_type: "ephemeral",
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*Here's the structured issue:*\n\n*Title:* ${escapeSlackMarkdown(structured.title)}\n*Priority:* ${structured.priority}\n*Labels:* ${structured.labels.join(", ")}\n\n*Description:*\n${escapeSlackMarkdown(structured.description)}\n\n*Acceptance Criteria:*\n${acList}`,
            },
          },
          {
            type: "actions",
            elements: [
              {
                type: "button",
                text: { type: "plain_text", text: "Create in Jira" },
                style: "primary",
                action_id: "issue_confirm",
              },
              {
                type: "button",
                text: { type: "plain_text", text: "Edit with AI" },
                action_id: "issue_edit",
              },
              {
                type: "button",
                text: { type: "plain_text", text: "Cancel" },
                style: "danger",
                action_id: "issue_cancel",
              },
            ],
          },
        ],
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

  // Edit with AI
  app.action("issue_edit", async ({ ack, respond }) => {
    await ack();
    await respond({
      response_type: "ephemeral",
      text: "What would you like to change? Use `/issue` again with the updated description.",
    });
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
