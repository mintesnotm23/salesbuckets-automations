/**
 * Meeting Notes Automation — Google Apps Script
 *
 * Polls a shared Google Drive folder for new Gemini meeting note docs,
 * reads their content, and POSTs to the SalesBuckets webhook for
 * Slack summarization and issue extraction.
 *
 * Setup: Fill in CONFIG below, then run setupTrigger() once.
 */

// ── Configuration ──────────────────────────────────────────────────────────────

var CONFIG = {
  // Google Drive folder ID where meeting notes are stored
  // Get from URL: drive.google.com/drive/folders/<THIS_IS_THE_ID>
  FOLDER_ID: '',

  // Webhook endpoint on your Render app
  WEBHOOK_URL: 'https://salesbuckets-automations.onrender.com/webhooks/meeting-notes',

  // Must match WEBHOOK_API_KEY env var on Render
  WEBHOOK_API_KEY: '',

  // Slack channel IDs (right-click channel → View channel details → Channel ID)
  SUMMARY_CHANNEL_ID: '',   // #meetings channel
  ISSUES_CHANNEL_ID: '',    // #issues channel

  // Retry webhook POST on failure
  MAX_RETRIES: 2,

  // Purge processed entries older than this many days
  CLEANUP_DAYS: 90,

  // Skip docs with fewer characters than this
  MIN_CONTENT_LENGTH: 50,

  // Max docs to process per run (avoid 6-min Apps Script timeout)
  MAX_DOCS_PER_RUN: 5
};

// ── Main Function ──────────────────────────────────────────────────────────────

/**
 * Checks the configured Drive folder for new Google Doc meeting notes.
 * Called automatically by the 5-minute time-driven trigger.
 */
function checkForNewMeetingNotes() {
  // Validate config on every run
  if (!CONFIG.FOLDER_ID || !CONFIG.WEBHOOK_URL || !CONFIG.WEBHOOK_API_KEY || !CONFIG.SUMMARY_CHANNEL_ID || !CONFIG.ISSUES_CHANNEL_ID) {
    Logger.log('ERROR: CONFIG is incomplete. Fill in all required fields (FOLDER_ID, WEBHOOK_URL, WEBHOOK_API_KEY, SUMMARY_CHANNEL_ID, ISSUES_CHANNEL_ID).');
    return;
  }

  var scriptProperties = PropertiesService.getScriptProperties();
  var folder;

  try {
    folder = DriveApp.getFolderById(CONFIG.FOLDER_ID);
  } catch (e) {
    Logger.log('ERROR: Could not access folder ' + CONFIG.FOLDER_ID + ': ' + e.message);
    return;
  }

  var files = folder.getFiles();
  var processedCount = 0;
  var skippedCount = 0;

  while (files.hasNext()) {
    var file = files.next();

    // Only process Google Docs
    if (file.getMimeType() !== 'application/vnd.google-apps.document') {
      continue;
    }

    var fileId = file.getId();

    // Skip already-processed docs
    if (scriptProperties.getProperty('processed_' + fileId)) {
      skippedCount++;
      continue;
    }

    // Read doc content
    var doc;
    try {
      doc = DocumentApp.openById(fileId);
    } catch (e) {
      Logger.log('WARNING: Could not open doc ' + fileId + ': ' + e.message);
      continue;
    }

    var body = doc.getBody().getText();

    // Skip empty or placeholder docs
    if (!body || body.length < CONFIG.MIN_CONTENT_LENGTH) {
      Logger.log('SKIP: Doc "' + file.getName() + '" too short (' + (body ? body.length : 0) + ' chars)');
      continue;
    }

    // Parse meeting info from doc title
    var meetingInfo = parseMeetingInfo(file.getName(), file.getDateCreated());
    var meetingUrl = 'https://docs.google.com/document/d/' + fileId + '/edit';
    var recordingUrl = findRecordingUrl(body);

    // Build webhook payload
    var payload = {
      notes: body,
      meetingTitle: meetingInfo.title,
      meetingDate: meetingInfo.date,
      meetingUrl: meetingUrl,
      summaryChannelId: CONFIG.SUMMARY_CHANNEL_ID,
      issuesChannelId: CONFIG.ISSUES_CHANNEL_ID
    };

    if (recordingUrl) {
      payload.recordingUrl = recordingUrl;
    }

    // POST to webhook with retry
    var success = postToWebhook(payload);

    if (success) {
      scriptProperties.setProperty('processed_' + fileId, new Date().toISOString());
      processedCount++;
      Logger.log('OK: Processed "' + meetingInfo.title + '"');
    } else {
      Logger.log('FAIL: Could not send "' + meetingInfo.title + '" — will retry next cycle');
    }

    // Guard against Apps Script 6-min execution timeout
    if (processedCount >= CONFIG.MAX_DOCS_PER_RUN) {
      Logger.log('Hit max docs per run (' + CONFIG.MAX_DOCS_PER_RUN + '). Remaining docs will be processed next cycle.');
      break;
    }
  }

  // Run cleanup once per day (not every 5-min cycle)
  var lastCleanup = scriptProperties.getProperty('last_cleanup_date') || '';
  var today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  if (lastCleanup !== today) {
    cleanupOldProperties(scriptProperties);
    scriptProperties.setProperty('last_cleanup_date', today);
  }

  Logger.log('Done. Processed: ' + processedCount + ', Already done: ' + skippedCount);
}

// ── Webhook ────────────────────────────────────────────────────────────────────

/**
 * POSTs payload to the webhook with retry logic.
 * Returns true on success (HTTP 200), false otherwise.
 */
function postToWebhook(payload) {
  var options = {
    method: 'post',
    contentType: 'application/json',
    headers: { 'X-API-Key': CONFIG.WEBHOOK_API_KEY },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  for (var attempt = 0; attempt <= CONFIG.MAX_RETRIES; attempt++) {
    try {
      var response = UrlFetchApp.fetch(CONFIG.WEBHOOK_URL, options);
      var code = response.getResponseCode();

      if (code === 200) {
        return true;
      }

      Logger.log('Webhook returned ' + code + ' (attempt ' + (attempt + 1) + '): ' + response.getContentText().substring(0, 200));
    } catch (e) {
      Logger.log('Webhook request failed (attempt ' + (attempt + 1) + '): ' + e.message);
    }

    // Brief pause before retry
    if (attempt < CONFIG.MAX_RETRIES) {
      Utilities.sleep(2000);
    }
  }

  return false;
}

// ── Parsing Helpers ────────────────────────────────────────────────────────────

/**
 * Extracts meeting title and date from the doc title.
 * Gemini typically names docs like "Meeting notes - Weekly Standup - April 3, 2026"
 * but the format can vary.
 */
function parseMeetingInfo(docTitle, fileCreatedDate) {
  var title = docTitle;
  var date = Utilities.formatDate(fileCreatedDate, Session.getScriptTimeZone(), 'yyyy-MM-dd');

  // Try: "Something - Title - Month Day, Year"
  var match = docTitle.match(/^(?:Meeting notes?\s*[-–—]\s*)?(.+?)\s*[-–—]\s*(\w+ \d{1,2},?\s*\d{4})$/i);
  if (match) {
    title = match[1].trim();
    date = formatDateString(match[2]) || date;
    return { title: title, date: date };
  }

  // Try: "Something - Title - YYYY-MM-DD"
  match = docTitle.match(/^(?:Meeting notes?\s*[-–—]\s*)?(.+?)\s*[-–—]\s*(\d{4}-\d{2}-\d{2})$/i);
  if (match) {
    title = match[1].trim();
    date = match[2];
    return { title: title, date: date };
  }

  // Try: Strip "Meeting notes - " prefix if present
  match = docTitle.match(/^Meeting notes?\s*[-–—]\s*(.+)$/i);
  if (match) {
    title = match[1].trim();
  }

  return { title: title, date: date };
}

/**
 * Converts "April 3, 2026" or "April 3 2026" to "2026-04-03".
 * Returns null if parsing fails.
 */
function formatDateString(dateStr) {
  try {
    var d = new Date(dateStr);
    if (isNaN(d.getTime())) return null;
    return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  } catch (e) {
    return null;
  }
}

/**
 * Searches doc body for Google Drive recording/video links.
 * Returns the first match or empty string.
 */
function findRecordingUrl(text) {
  var patterns = [
    /https:\/\/drive\.google\.com\/file\/d\/[a-zA-Z0-9_-]+(?:\/[a-z]*)?/,
    /https:\/\/meet\.google\.com\/[a-z]+-[a-z]+-[a-z]+/
  ];

  for (var i = 0; i < patterns.length; i++) {
    var match = text.match(patterns[i]);
    if (match) return match[0];
  }

  return '';
}

// ── Trigger Management ─────────────────────────────────────────────────────────

/**
 * Run this ONCE to set up the automatic 5-minute polling trigger.
 * Go to Run menu → Run function → setupTrigger
 */
function setupTrigger() {
  // Remove any existing triggers for this function first
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'checkForNewMeetingNotes') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }

  ScriptApp.newTrigger('checkForNewMeetingNotes')
    .timeBased()
    .everyMinutes(5)
    .create();

  Logger.log('Trigger created: checkForNewMeetingNotes runs every 5 minutes');
}

/**
 * Removes the automatic trigger. Run this to stop polling.
 */
function removeTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  var removed = 0;
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'checkForNewMeetingNotes') {
      ScriptApp.deleteTrigger(triggers[i]);
      removed++;
    }
  }
  Logger.log('Removed ' + removed + ' trigger(s)');
}

// ── Cleanup ────────────────────────────────────────────────────────────────────

/**
 * Purges processed entries older than CLEANUP_DAYS to stay within
 * the 500KB ScriptProperties limit.
 */
function cleanupOldProperties(scriptProperties) {
  var allProps = scriptProperties.getProperties();
  var cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - CONFIG.CLEANUP_DAYS);
  var removed = 0;

  for (var key in allProps) {
    if (key.indexOf('processed_') !== 0) continue;

    var timestamp = new Date(allProps[key]);
    if (isNaN(timestamp.getTime()) || timestamp < cutoff) {
      scriptProperties.deleteProperty(key);
      removed++;
    }
  }

  if (removed > 0) {
    Logger.log('Cleanup: removed ' + removed + ' old entries');
  }
}
