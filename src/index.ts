import { App, ExpressReceiver } from "@slack/bolt";
import { config } from "./config";
import { registerIssueCommand } from "./commands/issue.command";
import { registerAskCommand } from "./commands/ask.command";
import { registerMeetingActions } from "./commands/meeting.actions";
import { processMeetingNotes } from "./services/meeting-notes.service";
import { jiraService } from "./services/jira.service";

// Use ExpressReceiver so we can add custom routes (webhooks)
const receiver = new ExpressReceiver({
  signingSecret: config.slack.signingSecret,
});

const app = new App({
  token: config.slack.botToken,
  receiver,
});

// Register Slack commands
registerIssueCommand(app);
registerAskCommand(app);
registerMeetingActions(app);

// --- Webhook Routes ---

// Health check
receiver.router.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Webhook auth middleware
function webhookAuth(req: any, res: any, next: any) {
  const apiKey = req.headers["x-api-key"];
  if (apiKey !== config.webhookApiKey) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

// Google Apps Script sends meeting notes here
receiver.router.post("/webhooks/meeting-notes", webhookAuth, async (req, res) => {
  try {
    const { notes, meetingTitle, meetingDate, meetingUrl, recordingUrl, summaryChannelId, issuesChannelId } = req.body;

    if (!notes || !meetingTitle || !summaryChannelId || !issuesChannelId) {
      res.status(400).json({ error: "Missing required fields: notes, meetingTitle, summaryChannelId, issuesChannelId" });
      return;
    }

    const result = await processMeetingNotes({
      notes,
      meetingTitle,
      meetingDate: meetingDate || new Date().toISOString().split("T")[0],
      meetingUrl,
      recordingUrl,
      summaryChannelId,
      issuesChannelId,
    });

    res.json({ success: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("Meeting notes webhook error:", message);
    res.status(500).json({ error: "Failed to process meeting notes" });
  }
});

// Startup
(async () => {
  try {
    // Validate external connections
    await jiraService.validateConnection();
    console.log("Jira connection verified");

    await app.start(config.port);
    console.log(`Automations bot running on port ${config.port}`);
  } catch (error) {
    console.error("Failed to start:", error);
    process.exit(1);
  }
})();

// Graceful shutdown
process.on("SIGTERM", async () => {
  console.log("SIGTERM received, shutting down");
  await app.stop();
  process.exit(0);
});

process.on("SIGINT", async () => {
  console.log("SIGINT received, shutting down");
  await app.stop();
  process.exit(0);
});
