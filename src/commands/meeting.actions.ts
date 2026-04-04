import type { App } from "@slack/bolt";
import { jiraService } from "../services/jira.service";
import { safeJsonParse, escapeSlackMarkdown, withTimeout } from "../utils/helpers";
import type { ExtractedIssue } from "../services/openai.service";

/**
 * Handles button actions from meeting notes issue extraction posts.
 */
export function registerMeetingActions(app: App) {
  app.action("meeting_issue_create", async ({ action, ack, respond }) => {
    await ack();

    const issue = safeJsonParse<Partial<ExtractedIssue>>((action as any).value, {});
    if (!issue.title || !issue.description) {
      await respond("Could not parse issue data. Please create it manually.");
      return;
    }

    try {
      const jiraIssue = await withTimeout(
        jiraService.createIssue({
          title: issue.title,
          description: issue.description,
          priority: issue.priority || "Medium",
          labels: ["from-meeting"],
        }),
        10000,
        "Jira request timed out"
      );

      await respond({
        response_type: "in_channel",
        text: `:white_check_mark: Jira ticket created: <${jiraIssue.url}|${jiraIssue.key}> — *${escapeSlackMarkdown(issue.title)}*`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error("Error creating Jira from meeting issue:", message);
      await respond(`Failed to create Jira ticket: ${message}`);
    }
  });

  app.action("meeting_issue_dismiss", async ({ ack, respond }) => {
    await ack();
    await respond({ response_type: "ephemeral", text: "Issue dismissed." });
  });
}
