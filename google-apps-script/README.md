# Meeting Notes Automation — Setup Guide

Automatically posts Gemini meeting note summaries to Slack and extracts actionable issues with Jira ticket creation buttons.

## How It Works

1. Your team has a shared Google Drive folder for meeting notes
2. After a Google Meet call, the organizer moves/copies Gemini's notes doc into this folder
3. A Google Apps Script polls the folder every 5 minutes
4. When a new doc is detected, it reads the content and sends it to your webhook
5. The webhook summarizes the notes → posts to #meetings, extracts issues → posts to #issues

---

## Setup Steps

### 1. Create a Shared Drive Folder

1. Go to [Google Drive](https://drive.google.com)
2. Create a new folder (e.g. **"SalesBuckets Meeting Notes"**)
3. Share the folder with all team members who organize meetings
4. Copy the **folder ID** from the URL: `drive.google.com/drive/folders/<THIS_IS_THE_ID>`

### 2. Get Your Slack Channel IDs

You need two channel IDs:

1. Open Slack desktop app
2. Right-click the **#meetings** channel → **View channel details** → scroll to bottom → copy **Channel ID** (starts with `C`)
3. Do the same for the **#issues** channel

### 3. Create the Apps Script

1. Go to [Google Apps Script](https://script.google.com)
2. Click **New Project**
3. Delete the default `myFunction()` code
4. Copy and paste the entire contents of `Code.gs` into the editor
5. Name the project **"Meeting Notes Automation"** (click "Untitled project" at top)

### 4. Fill In Configuration

At the top of the script, fill in the `CONFIG` object:

```javascript
var CONFIG = {
  FOLDER_ID: 'your-folder-id-here',
  WEBHOOK_URL: 'https://salesbuckets-automations.onrender.com/webhooks/meeting-notes',
  WEBHOOK_API_KEY: 'your-webhook-api-key',
  SUMMARY_CHANNEL_ID: 'C0XXXXXXX',   // #meetings
  ISSUES_CHANNEL_ID: 'C0XXXXXXX',    // #issues
  MAX_RETRIES: 2,
  CLEANUP_DAYS: 90,
  MIN_CONTENT_LENGTH: 50
};
```

- **WEBHOOK_API_KEY**: Same value as the `WEBHOOK_API_KEY` environment variable on Render
- **Channel IDs**: From step 2

### 5. Set Up the Trigger

1. In the Apps Script editor, click the **Run** menu
2. Select **Run function** → **setupTrigger**
3. Google will ask you to grant permissions — click through:
   - **Review permissions** → select your Google account
   - Click **Advanced** → **Go to Meeting Notes Automation (unsafe)** (this is normal for custom scripts)
   - Click **Allow**
4. Check the **Execution log** — you should see: `Trigger created: checkForNewMeetingNotes runs every 5 minutes`

### 6. Test

1. Create or copy a Google Doc with sample meeting notes into your shared folder
2. In the Apps Script editor: **Run** → **checkForNewMeetingNotes**
3. Check the **Execution log** for success/error messages
4. Check Slack — you should see:
   - A meeting summary in **#meetings**
   - Extracted issues in **#issues** (with "Create Jira Ticket" buttons)

---

## Usage

After setup, the automation runs on its own:

1. **Hold a Google Meet** with Gemini note-taking enabled
2. **Move or copy** the Gemini notes doc into the shared Drive folder
3. **Within 5 minutes**, the summary and issues appear in Slack
4. **Click "Create Jira Ticket"** on any extracted issue to create it instantly

### Recording Links

If you paste a Google Drive recording link into the meeting notes doc before it gets processed, it will automatically be included in the Slack post. Otherwise, the recording URL field is simply omitted.

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Nothing happens after 5 min | Check Execution log in Apps Script editor. Verify folder ID and API key are correct. |
| "Could not access folder" error | Make sure the folder ID is correct and the script is running under an account that has access. |
| "Webhook returned 401" | The `WEBHOOK_API_KEY` doesn't match. Check the Render environment variable. |
| "Webhook returned 500" | The webhook server may be sleeping (Render free tier). Try again — UptimeRobot should keep it awake. |
| Doc processed but nothing in Slack | Check channel IDs. Make sure the bot is added to both #meetings and #issues channels. |
| Same doc processed twice | This shouldn't happen. Check ScriptProperties in Apps Script (File → Project properties). |

## Stopping the Automation

Run `removeTrigger()` from the Apps Script editor to stop polling.
