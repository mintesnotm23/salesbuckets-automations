import { WebClient } from "@slack/web-api";
import type { KnownBlock } from "@slack/types";
import { summarizeMeetingNotes, extractIssuesFromMeetingNotes } from "./openai.service";
import { config } from "../config";

const slack = new WebClient(config.slack.botToken);

export interface MeetingNotesInput {
  notes: string;
  meetingTitle: string;
  meetingDate: string;
  meetingUrl?: string;
  recordingUrl?: string;
  summaryChannelId: string;
  issuesChannelId: string;
}

/**
 * Process meeting notes: summarize and post to Slack, extract issues.
 * Called via webhook when a new Google Doc meeting note is created.
 */
export async function processMeetingNotes(params: MeetingNotesInput) {
  const { notes, meetingTitle, meetingDate, meetingUrl, recordingUrl, summaryChannelId, issuesChannelId } = params;

  // 1. Summarize and post to meetings channel
  const summary = await summarizeMeetingNotes(notes);

  const summaryBlocks: KnownBlock[] = [
    {
      type: "header",
      text: { type: "plain_text", text: `Meeting Notes: ${meetingTitle}` },
    },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: `:calendar: ${meetingDate}` }],
    },
    { type: "divider" },
    {
      type: "section",
      text: { type: "mrkdwn", text: summary },
    },
  ];

  // Add links if available
  const links: string[] = [];
  if (meetingUrl) links.push(`<${meetingUrl}|:page_facing_up: Full Notes>`);
  if (recordingUrl) links.push(`<${recordingUrl}|:movie_camera: Recording>`);

  if (links.length > 0) {
    summaryBlocks.push({ type: "divider" });
    summaryBlocks.push({
      type: "section",
      text: { type: "mrkdwn", text: links.join("  |  ") },
    });
  }

  await slack.chat.postMessage({
    channel: summaryChannelId,
    blocks: summaryBlocks,
    text: `Meeting Notes: ${meetingTitle}`,
  });

  // 2. Extract issues and post to issues channel
  const issues = await extractIssuesFromMeetingNotes(notes);
  const errors: string[] = [];

  for (const issue of issues) {
    try {
      // Safely truncate fields to fit Slack's 2000 char value limit
      const safeIssue = {
        title: issue.title.slice(0, 200),
        description: issue.description.slice(0, 500),
        priority: issue.priority,
      };
      const value = JSON.stringify(safeIssue);
      await slack.chat.postMessage({
        channel: issuesChannelId,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `:warning: *Issue from meeting "${meetingTitle}":*\n\n*${issue.title}*\n${issue.description}\n*Priority:* ${issue.priority}`,
            },
          },
          {
            type: "actions",
            elements: [
              {
                type: "button",
                text: { type: "plain_text", text: "Create Jira Ticket" },
                style: "primary",
                action_id: "meeting_issue_create",
                value,
              },
              {
                type: "button",
                text: { type: "plain_text", text: "Dismiss" },
                action_id: "meeting_issue_dismiss",
              },
            ],
          },
        ],
        text: `Issue: ${issue.title}`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Failed to post issue "${issue.title}" to Slack:`, message);
      errors.push(issue.title);
    }
  }

  return { summary, issueCount: issues.length, failedIssues: errors };
}
