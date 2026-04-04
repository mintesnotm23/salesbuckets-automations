import type { App, BlockAction } from "@slack/bolt";
import { answerCodebaseQuestion } from "../services/openai.service";
import { searchCodebase } from "../services/codebase.service";
import { validateCommandInput, withTimeout, safeJsonParse, escapeSlackMarkdown } from "../utils/helpers";

export function registerAskCommand(app: App) {
  app.command("/ask", async ({ command, ack, respond }) => {
    await ack();

    const validationError = validateCommandInput(command.text);
    if (validationError) {
      await respond(`${validationError} Usage: \`/ask <question about the codebase>\``);
      return;
    }

    await respond({
      text: ":mag: Searching the codebase...",
      response_type: "ephemeral",
    });

    try {
      const codeContext = await withTimeout(searchCodebase(command.text), 8000, "Search timed out");
      const answer = await withTimeout(answerCodebaseQuestion(command.text, codeContext), 20000, "AI response timed out");

      // Ensure the value fits within Slack's 2000 char limit
      const valuePayload = JSON.stringify({ question: command.text, answer });
      const safeValue = valuePayload.length <= 2000
        ? valuePayload
        : JSON.stringify({ question: command.text, answer: answer.slice(0, 800) + "\n\n_(truncated)_" });

      await respond({
        response_type: "ephemeral",
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*Q:* ${escapeSlackMarkdown(command.text)}\n\n${answer}`,
            },
          },
          {
            type: "actions",
            elements: [
              {
                type: "button",
                text: { type: "plain_text", text: "Share to Channel" },
                action_id: "ask_share",
                value: safeValue,
              },
            ],
          },
        ],
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error("Error answering question:", message);
      await respond(`Sorry, something went wrong: ${message}`);
    }
  });

  app.action("ask_share", async ({ action, ack, respond }) => {
    await ack();
    const data = safeJsonParse<{ question?: string; answer?: string }>((action as any).value, {});
    if (!data.question || !data.answer) {
      await respond("Could not share the answer — data was missing.");
      return;
    }
    await respond({
      response_type: "in_channel",
      text: `*Q:* ${escapeSlackMarkdown(data.question)}\n\n${data.answer}`,
    });
  });
}
