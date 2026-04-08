// Meeting Notes Automation — Google Apps Script

var CONFIG = {
  FOLDER_ID: "1Zsb2Tmx4bGubts8gU48iY-QWn4iSR7Nv",
  WEBHOOK_URL:
    "https://salesbuckets-automations.onrender.com/webhooks/meeting-notes",
  WEBHOOK_API_KEY:
    "3ca7e47a3bdcad3109e9f06b0099a79204c7903d898db1860ef8ea60b91a266b",
  SUMMARY_CHANNEL_ID: "C0AQP1DKMT5",
  ISSUES_CHANNEL_ID: "C0AR89R8ZL1",
  MAX_RETRIES: 2,
  CLEANUP_DAYS: 90,
  MIN_CONTENT_LENGTH: 50,
  MAX_DOCS_PER_RUN: 5,
};

// Main polling function — runs every 4 hours via trigger
function checkForNewMeetingNotes() {
  if (
    !CONFIG.FOLDER_ID ||
    !CONFIG.WEBHOOK_URL ||
    !CONFIG.WEBHOOK_API_KEY ||
    !CONFIG.SUMMARY_CHANNEL_ID ||
    !CONFIG.ISSUES_CHANNEL_ID
  ) {
    Logger.log("ERROR: CONFIG is incomplete.");
    return;
  }

  // Only run Monday through Friday
  var day = new Date().getDay();
  if (day === 0 || day === 6) {
    Logger.log("SKIP: Weekend — no meeting notes expected");
    return;
  }

  var scriptProperties = PropertiesService.getScriptProperties();
  var folder;

  try {
    folder = DriveApp.getFolderById(CONFIG.FOLDER_ID);
  } catch (e) {
    Logger.log("ERROR: Could not access folder: " + e.message);
    return;
  }

  var files = folder.getFiles();
  var processedCount = 0;
  var skippedCount = 0;

  while (files.hasNext()) {
    var file = files.next();

    // Only Google Docs (skips videos, PDFs, etc.)
    if (file.getMimeType() !== "application/vnd.google-apps.document") {
      continue;
    }

    var fileId = file.getId();

    // Skip already-processed docs
    if (scriptProperties.getProperty("processed_" + fileId)) {
      skippedCount++;
      continue;
    }

    // Read doc via Drive API export (works with Gemini notes)
    var body;
    try {
      var url =
        "https://www.googleapis.com/drive/v3/files/" +
        fileId +
        "/export?mimeType=text/plain";
      var response = UrlFetchApp.fetch(url, {
        headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken() },
        muteHttpExceptions: true,
      });
      if (response.getResponseCode() !== 200) {
        throw new Error("Export returned " + response.getResponseCode());
      }
      body = response.getContentText();
    } catch (e) {
      Logger.log(
        'WARNING: Could not read "' + file.getName() + '": ' + e.message,
      );
      scriptProperties.setProperty("processed_" + fileId, "unreadable");
      continue;
    }

    // Skip empty or too-short docs
    if (!body || body.length < CONFIG.MIN_CONTENT_LENGTH) {
      Logger.log(
        'SKIP: "' +
          file.getName() +
          '" too short (' +
          (body ? body.length : 0) +
          " chars)",
      );
      continue;
    }

    var meetingInfo = parseMeetingInfo(file.getName(), file.getDateCreated());
    var meetingUrl = "https://docs.google.com/document/d/" + fileId + "/edit";
    var recordingUrl = findRecordingInFolder(folder, file.getName());

    var payload = {
      notes: body,
      meetingTitle: meetingInfo.title,
      meetingDate: meetingInfo.date,
      meetingUrl: meetingUrl,
      summaryChannelId: CONFIG.SUMMARY_CHANNEL_ID,
      issuesChannelId: CONFIG.ISSUES_CHANNEL_ID,
    };

    if (recordingUrl) {
      payload.recordingUrl = recordingUrl;
    }

    var success = postToWebhook(payload);

    if (success) {
      scriptProperties.setProperty(
        "processed_" + fileId,
        new Date().toISOString(),
      );
      processedCount++;
      Logger.log('OK: Processed "' + meetingInfo.title + '"');
    } else {
      scriptProperties.setProperty("processed_" + fileId, "failed");
      Logger.log(
        'FAIL: "' +
          meetingInfo.title +
          '" — marked as failed, will not retry automatically',
      );
    }

    // Avoid 6-min Apps Script timeout
    if (processedCount >= CONFIG.MAX_DOCS_PER_RUN) {
      Logger.log(
        "Hit max docs per run. Remaining will be processed next cycle.",
      );
      break;
    }
  }

  // Daily cleanup of old entries
  var lastCleanup = scriptProperties.getProperty("last_cleanup_date") || "";
  var today = Utilities.formatDate(
    new Date(),
    Session.getScriptTimeZone(),
    "yyyy-MM-dd",
  );
  if (lastCleanup !== today) {
    cleanupOldProperties(scriptProperties);
    scriptProperties.setProperty("last_cleanup_date", today);
  }

  Logger.log(
    "Done. Processed: " + processedCount + ", Already done: " + skippedCount,
  );
}

// POST payload to webhook with retry
function postToWebhook(payload) {
  var options = {
    method: "post",
    contentType: "application/json",
    headers: { "X-API-Key": CONFIG.WEBHOOK_API_KEY },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  };

  for (var attempt = 0; attempt <= CONFIG.MAX_RETRIES; attempt++) {
    try {
      var response = UrlFetchApp.fetch(CONFIG.WEBHOOK_URL, options);
      if (response.getResponseCode() === 200) return true;
      Logger.log(
        "Webhook returned " +
          response.getResponseCode() +
          " (attempt " +
          (attempt + 1) +
          ")",
      );
    } catch (e) {
      Logger.log(
        "Webhook failed (attempt " + (attempt + 1) + "): " + e.message,
      );
    }
    if (attempt < CONFIG.MAX_RETRIES) Utilities.sleep(2000);
  }

  return false;
}

// Extract title and date from doc name
function parseMeetingInfo(docTitle, fileCreatedDate) {
  var title = docTitle;
  var date = Utilities.formatDate(
    fileCreatedDate,
    Session.getScriptTimeZone(),
    "yyyy-MM-dd",
  );

  // Gemini format: "Meeting started 2026/03/17 12:40 ADT - Notes by Gemini"
  var match = docTitle.match(
    /^Meeting started (\d{4}\/\d{2}\/\d{2})\s+\d{2}:\d{2}\s+\w+\s*[-–—]\s*Notes by Gemini$/i,
  );
  if (match) {
    return { title: "Team Meeting", date: match[1].replace(/\//g, "-") };
  }

  // "Title - Month Day, Year"
  match = docTitle.match(
    /^(?:Meeting notes?\s*[-–—]\s*)?(.+?)\s*[-–—]\s*(\w+ \d{1,2},?\s*\d{4})$/i,
  );
  if (match) {
    return { title: match[1].trim(), date: formatDateString(match[2]) || date };
  }

  // "Title - YYYY-MM-DD"
  match = docTitle.match(
    /^(?:Meeting notes?\s*[-–—]\s*)?(.+?)\s*[-–—]\s*(\d{4}-\d{2}-\d{2})$/i,
  );
  if (match) {
    return { title: match[1].trim(), date: match[2] };
  }

  // Strip "Meeting notes - " prefix
  match = docTitle.match(/^Meeting notes?\s*[-–—]\s*(.+)$/i);
  if (match) title = match[1].trim();

  return { title: title, date: date };
}

// Convert "April 3, 2026" to "2026-04-03"
function formatDateString(dateStr) {
  try {
    var d = new Date(dateStr);
    if (isNaN(d.getTime())) return null;
    return Utilities.formatDate(d, Session.getScriptTimeZone(), "yyyy-MM-dd");
  } catch (e) {
    return null;
  }
}

// Find matching recording video in the same folder by date and closest time (within 30 min)
function findRecordingInFolder(folder, notesFileName) {
  var notesMatch = notesFileName.match(
    /(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})/,
  );
  if (!notesMatch) return "";

  var notesTime = new Date(
    notesMatch[1],
    notesMatch[2] - 1,
    notesMatch[3],
    notesMatch[4],
    notesMatch[5],
  );
  var bestMatch = null;
  var bestDiff = 30 * 60 * 1000; // 30 min max

  var files = folder.getFiles();
  while (files.hasNext()) {
    var file = files.next();
    if (file.getMimeType().indexOf("video/") !== 0) continue;

    var videoMatch = file
      .getName()
      .match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/);
    if (!videoMatch) continue;

    var videoTime = new Date(
      videoMatch[1],
      videoMatch[2] - 1,
      videoMatch[3],
      videoMatch[4],
      videoMatch[5],
    );
    var diff = Math.abs(notesTime - videoTime);

    if (diff < bestDiff) {
      bestDiff = diff;
      bestMatch = file.getId();
    }
  }

  if (bestMatch) {
    try {
      DriveApp.getFileById(bestMatch).setSharing(
        DriveApp.Access.ANYONE_WITH_LINK,
        DriveApp.Permission.VIEW,
      );
    } catch (e) {
      Logger.log("WARNING: Could not set sharing on recording: " + e.message);
    }
    return "https://drive.google.com/file/d/" + bestMatch + "/view";
  }
  return "";
}

// Create the 4-hour polling trigger (run once)
function setupTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === "checkForNewMeetingNotes") {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  ScriptApp.newTrigger("checkForNewMeetingNotes")
    .timeBased()
    .everyHours(4)
    .create();
  Logger.log("Trigger created: runs every 4 hours");
}

// Remove the polling trigger
function removeTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  var removed = 0;
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === "checkForNewMeetingNotes") {
      ScriptApp.deleteTrigger(triggers[i]);
      removed++;
    }
  }
  Logger.log("Removed " + removed + " trigger(s)");
}

// Clear all processed entries (reprocess everything on next run)
function clearProcessed() {
  PropertiesService.getScriptProperties().deleteAllProperties();
  Logger.log("All properties cleared");
}

// Purge processed entries older than CLEANUP_DAYS
function cleanupOldProperties(scriptProperties) {
  var allProps = scriptProperties.getProperties();
  var cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - CONFIG.CLEANUP_DAYS);
  var removed = 0;

  for (var key in allProps) {
    if (key.indexOf("processed_") !== 0) continue;
    var timestamp = new Date(allProps[key]);
    if (isNaN(timestamp.getTime())) continue;
    if (timestamp < cutoff) {
      scriptProperties.deleteProperty(key);
      removed++;
    }
  }

  if (removed > 0) Logger.log("Cleanup: removed " + removed + " old entries");
}

// Clear only 'failed' entries so they can be reprocessed on next run
function retryFailed() {
  var scriptProperties = PropertiesService.getScriptProperties();
  var allProps = scriptProperties.getProperties();
  var cleared = 0;

  for (var key in allProps) {
    if (key.indexOf("processed_") !== 0) continue;
    if (allProps[key] === "failed") {
      scriptProperties.deleteProperty(key);
      cleared++;
    }
  }

  Logger.log(
    "Cleared " +
      cleared +
      " failed entries — they will be reprocessed on next run",
  );
}
