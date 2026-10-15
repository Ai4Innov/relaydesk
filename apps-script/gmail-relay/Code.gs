/**
 * Enable the Advanced Gmail service before running startGmailExport().
 * Edit CONFIG, then run startGmailExport once and approve Google's permissions.
 * Gmail is read-only. Only a new subfolder of the chosen Drive folder is written.
 */
const CONFIG = Object.freeze({
  DRIVE_FOLDER_URL: 'https://drive.google.com/drive/folders/YOUR_FOLDER_ID',
  START_DATE: '2026-01-01', // Inclusive, YYYY-MM-DD.
  END_DATE: '2026-12-31',   // Inclusive, YYYY-MM-DD.
  TIME_ZONE: 'Etc/UTC', // Your IANA time zone, e.g. 'Africa/Lagos' or 'Europe/Paris'.
  INCLUDE_SPAM_AND_TRASH: false,
  // true: after START_DATE..now is exported, keep exporting new mail every 5 minutes
  // (END_DATE is then ignored). Switch a running/finished export with resumeGmailExport.
  CONTINUOUS: true,
  // Relay Desk access token lifetime; run rotateRelayToken() before it expires.
  RELAY_TOKEN_MAX_AGE_DAYS: 90,
  // After rotation the previous token keeps working this long so Relay Desk can be updated.
  RELAY_TOKEN_GRACE_HOURS: 24
});

const EXPORT_KEY = 'GMAIL_TO_DRIVE_EXPORT_V1';
const RESUME_REQUEST_KEY = 'GMAIL_TO_DRIVE_RESUME_REQUEST';
const EXPORT_HANDLER = 'continueGmailExport';
const RUN_BUDGET_MS = 4 * 60 * 1000;
const MAX_AUTOMATIC_FAILURES = 5;
const MAX_SCAN_PASSES = 3;
const OPEN_END_MS = 8640000000000000;
const JOURNAL_CHUNK = 500;
const JOURNAL_MARKER = 'relay-journaled';
const RELAY_MAX_FILE_CHUNK = 4 * 1024 * 1024;

function requireGmailService_() {
  if (typeof Gmail === 'undefined') {
    throw new Error('Advanced Gmail service is not enabled. In the Apps Script editor click ' +
      'Services (+) > Gmail API > Add (identifier must be "Gmail"), save, then run again.');
  }
}

function startGmailExport() {
  requireGmailService_();
  const lock = LockService.getUserLock();
  lock.waitLock(10000);
  try {
    const previous = loadState_();
    if (previous && !['complete', 'cancelled'].includes(previous.status)) {
      throw new Error('An export already exists. Run resumeGmailExport or cancelGmailExport first.');
    }
    const continuous = CONFIG.CONTINUOUS === true;
    const range = dateRange_(CONFIG, continuous);
    const destination = resolveFolder_(CONFIG.DRIVE_FOLDER_URL);
    const profile = Gmail.Users.getProfile('me');
    const name = 'Gmail-export_' + CONFIG.START_DATE + '_to_' +
      (continuous ? 'ongoing' : CONFIG.END_DATE) + '_' + Utilities.getUuid();
    const folder = destination.createFolder(name);
    const messages = folder.createFolder('messages');
    const statusFile = writeJson_(folder, 'export-status.json', {});
    const state = {
      version: 1, status: 'running', mailbox: profile.emailAddress,
      startedAt: new Date().toISOString(), config: Object.assign({}, CONFIG),
      continuous: continuous, phase: 'initial', scanHistoryId: profile.historyId || null,
      startMs: range.startMs, endExclusiveMs: range.endExclusiveMs,
      query: rangeQuery_(range.startMs, range.endExclusiveMs, continuous),
      folderId: folder.getId(), messagesFolderId: messages.getId(),
      statusFileId: statusFile.getId(), pass: 1, scanId: Utilities.getUuid(), pageToken: null,
      pendingIds: [], listingFinished: false,
      processedThisPass: 0, newThisPass: 0, consecutiveFailures: 0
    };
    saveState_(state);
    writeJson_(folder, 'export-info.json', {
      schemaVersion: 1, mailbox: state.mailbox, createdAt: state.startedAt,
      startDateInclusive: CONFIG.START_DATE,
      endDateInclusive: continuous ? null : CONFIG.END_DATE, continuous: continuous,
      timeZone: CONFIG.TIME_ZONE, startUtc: new Date(range.startMs).toISOString(),
      endExclusiveUtc: continuous ? null : new Date(range.endExclusiveMs).toISOString(),
      includesSpamAndTrash: CONFIG.INCLUDE_SPAM_AND_TRASH,
      selection: 'Gmail internalDate, not the sender-controlled Date header',
      layout: 'messages/<gmail-message-id>/{message.eml,message.json,bodies,attachments}',
      warning: 'Private unencrypted Drive copies. Exported HTML may contain remote resources; do not open as trusted web content.'
    });
    publishStatus_(state);
    installTrigger_();
    console.log('Export created: https://drive.google.com/drive/folders/' + folder.getId());
  } finally {
    lock.releaseLock();
  }
  continueGmailExport();
}

function continueGmailExport() {
  requireGmailService_();
  const lock = LockService.getUserLock();
  if (!lock.tryLock(1000)) {
    console.log('Another export invocation is already running.');
    return;
  }
  let state;
  const deadline = Date.now() + RUN_BUDGET_MS;
  try {
    state = loadState_();
    const props = PropertiesService.getUserProperties();
    if (props.getProperty(RESUME_REQUEST_KEY)) {
      props.deleteProperty(RESUME_REQUEST_KEY);
      try {
        state = applyResume_(state, Gmail.Users.getProfile('me'));
        console.log('Applied the saved resume request.');
      } catch (error) {
        console.log('Saved resume request ignored: ' + (error && error.message || error));
      }
    }
    if (!state || ['complete', 'cancelled', 'paused'].includes(state.status)) {
      console.log('No runnable export. Run startGmailExport or resumeGmailExport.');
      removeTriggers_();
      return;
    }
    const profile = Gmail.Users.getProfile('me');
    if (profile.emailAddress.toLowerCase() !== state.mailbox.toLowerCase()) {
      throw new Error('The authorized Gmail account changed. Resume as the original account.');
    }
    const root = DriveApp.getFolderById(state.messagesFolderId);
    let rescanned = false;
    while (Date.now() < deadline - 15000) {
      if (!state.pendingIds.length) {
        if (state.phase === 'watching') {
          const polled = pollHistory_(state, profile);
          if (polled === 'rescan') {
            if (rescanned) break;
            rescanned = true;
            continue;
          }
          if (!polled) break;
          continue;
        }
        if (state.listingFinished) {
          if (state.pass > 1 && state.newThisPass === 0) {
            if (state.continuous) {
              // Messages added after this pass began are delivered by Gmail history.
              state.phase = 'watching';
              state.status = 'watching';
              state.historyId = state.scanHistoryId || profile.historyId;
              state.historyPageToken = null;
              state.initialCompletedAt = state.initialCompletedAt || new Date().toISOString();
              state.matchingMessagesInFinalPass = state.processedThisPass;
              state.lastError = null;
              saveState_(state);
              console.log('Initial export complete. Now watching for new mail.');
              continue;
            }
            state.status = 'complete';
            state.completedAt = new Date().toISOString();
            state.matchingMessagesInFinalPass = state.processedThisPass;
            state.lastError = null;
            saveState_(state);
            publishStatus_(state);
            removeTriggers_();
            console.log('Export complete. See export-status.json in the export folder.');
            return;
          }
          if (state.pass >= MAX_SCAN_PASSES) {
            state.status = 'paused';
            throw new Error('The mailbox kept changing during reconciliation. Run resumeGmailExport to scan again.');
          }
          resetScan_(state, state.pass + 1, profile.historyId);
          saveState_(state);
        }
        const options = {
          q: state.query, maxResults: 100,
          includeSpamTrash: state.config.INCLUDE_SPAM_AND_TRASH
        };
        if (state.pageToken) options.pageToken = state.pageToken;
        const page = Gmail.Users.Messages.list('me', options);
        state.pendingIds = (page.messages || []).map(function (item) { return item.id; });
        state.pageToken = page.nextPageToken || null;
        state.listingFinished = !page.nextPageToken;
        saveState_(state);
        if (!state.pendingIds.length) continue;
      }
      const outcome = exportMessage_(root, state.pendingIds[0], state, deadline);
      if (!outcome.finished) break;
      state.pendingIds.shift();
      if (outcome.inRange) {
        state.processedThisPass++;
        if (outcome.createdScan === state.scanId) state.newThisPass++;
      }
      state.consecutiveFailures = 0;
      state.lastError = null;
      state.failedMessageId = null;
      state.status = state.phase === 'watching' ? 'watching' : 'running';
      saveState_(state);
    }
    if (state.phase === 'watching') {
      state.status = 'watching';
      state.lastSyncAt = new Date().toISOString();
      saveState_(state);
    }
    publishStatus_(state);
  } catch (error) {
    if (!state) throw error;
    state.consecutiveFailures++;
    state.lastError = String(error && error.message || error);
    state.failedMessageId = state.pendingIds[0] || null;
    state.status = state.status === 'paused' ||
      state.consecutiveFailures >= MAX_AUTOMATIC_FAILURES ? 'paused' : 'retrying';
    saveState_(state);
    publishStatus_(state);
    if (state.status === 'paused') removeTriggers_();
    // Preserve the failing message at the front of the queue; never silently skip it.
    throw error;
  } finally {
    lock.releaseLock();
  }
}

function resumeGmailExport() {
  requireGmailService_();
  const lock = LockService.getUserLock();
  if (!lock.tryLock(30000)) {
    // A scheduled batch is running (up to ~4 minutes). Validate now, apply on its next run.
    resumableState_(loadState_());
    PropertiesService.getUserProperties().setProperty(RESUME_REQUEST_KEY, new Date().toISOString());
    installTrigger_();
    console.log('An export batch is running right now. Your resume request is saved and will be ' +
      'applied automatically within about 5 minutes. Check progress with showGmailExportStatus.');
    return;
  }
  try {
    PropertiesService.getUserProperties().deleteProperty(RESUME_REQUEST_KEY);
    applyResume_(loadState_(), Gmail.Users.getProfile('me'));
  } finally {
    lock.releaseLock();
  }
  continueGmailExport();
}

function resumableState_(state) {
  const upgrade = Boolean(state && CONFIG.CONTINUOUS === true && !state.continuous &&
    state.status !== 'cancelled');
  if (!state || state.status === 'cancelled' || (state.status === 'complete' && !upgrade)) {
    throw new Error('No interrupted export to resume. Run startGmailExport for a new export.');
  }
  return upgrade;
}

// Caller must hold the user lock.
function applyResume_(state, profile) {
  const upgrade = resumableState_(state);
  if (upgrade) {
    // Keep the same folder and start date; drop the end date. Saved messages are skipped.
    state.continuous = true;
    state.config.CONTINUOUS = true;
    state.endExclusiveMs = OPEN_END_MS;
    state.query = rangeQuery_(state.startMs, OPEN_END_MS, true);
    delete state.completedAt;
    console.log('Export switched to continuous mode.');
  }
  // Restart enumeration, not the files. This also recovers an expired page token.
  state.phase = 'initial';
  state.historyPageToken = null;
  resetScan_(state, 1, profile.historyId);
  state.status = 'running';
  state.consecutiveFailures = 0;
  state.lastError = null;
  saveState_(state);
  publishStatus_(state);
  installTrigger_();
  return state;
}

function cancelGmailExport() {
  const lock = LockService.getUserLock();
  lock.waitLock(10000);
  try {
    const state = loadState_();
    if (state && state.status !== 'complete') {
      state.status = 'cancelled';
      saveState_(state);
      publishStatus_(state);
    }
    removeTriggers_();
    console.log('Stopped. Already exported files were kept.');
  } finally {
    lock.releaseLock();
  }
}

function showGmailExportStatus() {
  const state = loadState_();
  console.log(state ? JSON.stringify({
    status: state.status, phase: state.phase || 'initial', continuous: Boolean(state.continuous),
    lastSyncAt: state.lastSyncAt || null, journalSeq: state.journalSeq || 0,
    pass: state.pass, processedThisPass: state.processedThisPass,
    pendingInCurrentPage: state.pendingIds.length, lastError: state.lastError || null,
    folder: 'https://drive.google.com/drive/folders/' + state.folderId
  }, null, 2) : 'No export has been started.');
}

function exportMessage_(root, id, state, deadline) {
  const folder = uniqueFolder_(root, id);
  const files = filesByName_(folder);
  if (files['message.json']) {
    const completed = JSON.parse(files['message.json'].getBlob().getDataAsString('UTF-8'));
    if (completed.gmailMessageId !== id || completed.status !== 'complete') {
      throw new Error('Invalid completion manifest for message ' + id);
    }
    if (!files[JOURNAL_MARKER]) journalMessage_(state, folder, files['message.json'], completed);
    return { finished: true, inRange: true, createdScan: completed.createdScan };
  }
  let message;
  try {
    message = Gmail.Users.Messages.get('me', id, { format: 'full' });
  } catch (error) {
    // Deleted before it could be exported; nothing is left to save.
    if (/not ?found|404/i.test(String(error && error.message || error))) {
      return { finished: true, inRange: false };
    }
    throw error;
  }
  const received = Number(message.internalDate);
  if (!Number.isFinite(received)) throw new Error('Missing Gmail internalDate for ' + id);
  if (received < state.startMs || received >= state.endExclusiveMs) {
    return { finished: true, inRange: false };
  }
  if (!message.payload) throw new Error('Gmail did not return the full MIME payload for ' + id);
  if (!files['message.eml']) {
    if (Date.now() >= deadline - 15000) return { finished: false };
    const raw = Gmail.Users.Messages.get('me', id, { format: 'raw' });
    const rawBytes = gmailBytes_(raw && raw.raw);
    if (!rawBytes || !rawBytes.length) {
      throw new Error('Gmail did not return the raw MIME message for ' + id);
    }
    files['message.eml'] = folder.createFile(Utilities.newBlob(
      rawBytes, 'message/rfc822', 'message.eml'));
  }
  if (files['message.eml'].getSize() === 0) throw new Error('Empty raw MIME file for ' + id);
  const bodies = uniqueFolder_(folder, 'bodies');
  const attachments = uniqueFolder_(folder, 'attachments');
  const bodyFiles = filesByName_(bodies);
  const attachmentFiles = filesByName_(attachments);
  const entries = [];
  collectParts_(message.payload, '0', entries);
  const exported = [];
  for (const entry of entries) {
    if (Date.now() >= deadline - 15000) return { finished: false };
    const part = entry.part;
    const attachment = isAttachment_(part);
    const directory = attachment ? attachments : bodies;
    const known = attachment ? attachmentFiles : bodyFiles;
    const mime = part.mimeType || 'application/octet-stream';
    const extension = mime === 'text/plain' ? '.txt' : mime === 'text/html' ? '.html' : '.bin';
    const filename = entry.path + '__' + safeName_(part.filename || ('part' + extension));
    let file = known[filename];
    if (!file) {
      const bytes = partBytes_(id, part);
      file = directory.createFile(Utilities.newBlob(bytes, mime, filename));
      known[filename] = file;
    }
    // Gmail's body.size is approximate (charset/line-ending normalisation), so a
    // mismatch is recorded instead of failing. message.eml is the authoritative copy.
    const reportedSize = typeof part.body.size === 'number' ? part.body.size : null;
    const sizeMatchesGmail = reportedSize === null || file.getSize() === reportedSize;
    exported.push({
      mimePath: entry.path, partId: part.partId || '',
      kind: attachment ? 'attachment' : 'body',
      originalFilename: part.filename || '', filename: filename,
      relativePath: (attachment ? 'attachments/' : 'bodies/') + filename,
      mimeType: mime, headers: part.headers || [],
      contentId: header_(part, 'Content-ID'), sizeBytes: file.getSize(),
      gmailReportedSizeBytes: reportedSize, sizeMatchesGmail: sizeMatchesGmail,
      driveFileId: file.getId()
    });
  }
  if (Date.now() >= deadline - 15000) return { finished: false };
  // Written last: this is the per-message completion marker, not an inbox preview.
  const manifest = {
    schemaVersion: 1, status: 'complete', createdScan: state.scanId,
    gmailMessageId: id, gmailThreadId: message.threadId, mailbox: state.mailbox,
    internalDateMs: received, receivedAt: new Date(received).toISOString(),
    headers: message.payload.headers || [], labelIds: message.labelIds || [],
    historyId: message.historyId || null, sizeEstimate: message.sizeEstimate,
    exportedAt: new Date().toISOString(),
    raw: { filename: 'message.eml', driveFileId: files['message.eml'].getId(),
      sizeBytes: files['message.eml'].getSize() },
    parts: exported, mimeStructure: mimeStructure_(message.payload)
  };
  const manifestFile = writeJson_(folder, 'message.json', manifest);
  journalMessage_(state, folder, manifestFile, manifest);
  return { finished: true, inRange: true, createdScan: state.scanId };
}

// Append-only change feed for Relay Desk. Written after message.json, so every entry
// points at a complete message; a crash before the marker can only repeat an entry.
function journalMessage_(state, messageFolder, manifestFile, manifest) {
  const exportFolder = DriveApp.getFolderById(state.folderId);
  const journal = uniqueFolder_(exportFolder, 'relay-journal');
  let chunk = state.journalChunk || 1;
  let file = journalChunkFile_(journal, chunk);
  let entries = file ? JSON.parse(file.getBlob().getDataAsString('UTF-8')) : [];
  if (entries.length >= JOURNAL_CHUNK) {
    chunk++;
    file = journalChunkFile_(journal, chunk);
    entries = file ? JSON.parse(file.getBlob().getDataAsString('UTF-8')) : [];
  }
  entries.push({
    seq: (chunk - 1) * JOURNAL_CHUNK + entries.length + 1,
    gmailMessageId: manifest.gmailMessageId, gmailThreadId: manifest.gmailThreadId || null,
    internalDateMs: manifest.internalDateMs, messageFolderId: messageFolder.getId(),
    manifestFileId: manifestFile.getId(), journaledAt: new Date().toISOString()
  });
  const content = JSON.stringify(entries);
  if (file) file.setContent(content);
  else journal.createFile(Utilities.newBlob(content, 'application/json', journalName_(chunk)));
  state.journalChunk = chunk;
  state.journalSeq = (chunk - 1) * JOURNAL_CHUNK + entries.length;
  messageFolder.createFile(Utilities.newBlob('', 'text/plain', JOURNAL_MARKER));
}

function journalName_(chunk) {
  return ('00000' + chunk).slice(-6) + '.json';
}

function journalChunkFile_(journal, chunk) {
  const found = journal.getFilesByName(journalName_(chunk));
  return found.hasNext() ? found.next() : null;
}

function collectParts_(part, path, output) {
  const body = part.body;
  if (body && (body.attachmentId || body.data != null ||
    (!part.parts?.length && (body.size > 0 || part.filename ||
      /^text\/(plain|html)$/i.test(part.mimeType || '') ||
      /^attachment\b/i.test(header_(part, 'Content-Disposition')))))) {
    output.push({ path: path, part: part });
  }
  (part.parts || []).forEach(function (child, index) {
    collectParts_(child, path + '-' + index, output);
  });
}

function partBytes_(messageId, part) {
  const body = part.body;
  const result = body.attachmentId ?
    Gmail.Users.Messages.Attachments.get('me', messageId, body.attachmentId) : body;
  const decoded = gmailBytes_(result && result.data);
  if (!decoded && body.size !== 0) {
    throw new Error('Gmail omitted nonempty MIME body data for message ' + messageId);
  }
  const bytes = decoded || [];
  return bytes;
}

// Apps Script's Advanced Gmail service returns byte fields (raw, data) as byte
// arrays; the REST API returns base64url strings. Accept both.
function gmailBytes_(value) {
  if (value == null) return null;
  if (typeof value === 'string') {
    const padded = value + '='.repeat((4 - value.length % 4) % 4);
    return Utilities.base64DecodeWebSafe(padded);
  }
  if (typeof value.length === 'number') return Array.prototype.slice.call(value);
  return null;
}

function isAttachment_(part) {
  return Boolean(part.filename) || /^attachment\b/i.test(header_(part, 'Content-Disposition')) ||
    !/^text\/(plain|html)$/i.test(part.mimeType || '');
}

function header_(part, name) {
  const found = (part.headers || []).find(function (item) {
    return item.name.toLowerCase() === name.toLowerCase();
  });
  return found ? found.value : '';
}

function mimeStructure_(part) {
  return {
    partId: part.partId || '', mimeType: part.mimeType || '',
    filename: part.filename || '', headers: part.headers || [],
    sizeBytes: part.body ? part.body.size : 0,
    parts: (part.parts || []).map(mimeStructure_)
  };
}

function dateRange_(config, openEnded) {
  function parse(date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Use dates in YYYY-MM-DD format.');
    const value = Utilities.parseDate(date + ' 00:00:00', config.TIME_ZONE, 'yyyy-MM-dd HH:mm:ss');
    if (Utilities.formatDate(value, config.TIME_ZONE, 'yyyy-MM-dd') !== date) {
      throw new Error('Invalid calendar date: ' + date);
    }
    return value.getTime();
  }
  const startMs = parse(config.START_DATE);
  if (openEnded) return { startMs: startMs, endExclusiveMs: OPEN_END_MS };
  const lastMs = parse(config.END_DATE);
  if (lastMs < startMs) throw new Error('END_DATE must not precede START_DATE.');
  const calendar = new Date(config.END_DATE + 'T12:00:00Z');
  calendar.setUTCDate(calendar.getUTCDate() + 1);
  const nextDate = calendar.toISOString().slice(0, 10);
  return { startMs: startMs, endExclusiveMs: parse(nextDate) };
}

function rangeQuery_(startMs, endExclusiveMs, openEnded) {
  const after = 'after:' + (Math.floor(startMs / 1000) - 1);
  return openEnded ? after : after + ' before:' + Math.ceil(endExclusiveMs / 1000);
}

// Continuous mode: export messages Gmail reports as added since the last history ID.
// Returns false when there is nothing more to do in this run.
function pollHistory_(state, profile) {
  const options = { startHistoryId: state.historyId, historyTypes: ['messageAdded'], maxResults: 100 };
  if (state.historyPageToken) options.pageToken = state.historyPageToken;
  let response;
  try {
    response = Gmail.Users.History.list('me', options);
  } catch (error) {
    if (!/not ?found|404/i.test(String(error && error.message || error))) throw error;
    // History ID too old (Gmail keeps about a week): reconcile with a full rescan.
    state.phase = 'initial';
    state.status = 'running';
    state.historyPageToken = null;
    resetScan_(state, 1, profile.historyId);
    state.lastError = 'Gmail history expired; rescanning to catch up.';
    saveState_(state);
    return 'rescan';
  }
  const ids = [];
  (response.history || []).forEach(function (record) {
    (record.messagesAdded || []).forEach(function (added) {
      const message = added.message;
      if (!message || ids.includes(message.id)) return;
      const labels = message.labelIds || [];
      if (labels.includes('DRAFT')) return;
      if (!state.config.INCLUDE_SPAM_AND_TRASH &&
        (labels.includes('SPAM') || labels.includes('TRASH'))) return;
      ids.push(message.id);
    });
  });
  state.pendingIds = ids;
  if (response.nextPageToken) {
    state.historyPageToken = response.nextPageToken;
  } else {
    state.historyPageToken = null;
    if (response.historyId) state.historyId = String(response.historyId);
  }
  state.lastSyncAt = new Date().toISOString();
  saveState_(state);
  return ids.length > 0 || Boolean(response.nextPageToken);
}

function resolveFolder_(input) {
  const value = String(input).trim();
  const match = value.match(/^https:\/\/drive\.google\.com\/(?:drive\/(?:u\/\d+\/)?folders\/|open\?(?:[^#]*&)?id=)([A-Za-z0-9_-]+)/);
  const id = /^[A-Za-z0-9_-]{10,}$/.test(value) ? value : match && match[1];
  if (!id) throw new Error('Provide a Google Drive folder link or folder ID, not a file link.');
  const resource = value.match(/[?&]resourcekey=([^&#]+)/i);
  return resource ? DriveApp.getFolderByIdAndResourceKey(id, decodeURIComponent(resource[1])) :
    DriveApp.getFolderById(id);
}

function safeName_(name) {
  return String(name).replace(/[\u0000-\u001f\u007f\\/:*?"<>|]/g, '_').slice(0, 150) || 'unnamed';
}

function uniqueFolder_(parent, name) {
  const folders = parent.getFoldersByName(name);
  const folder = folders.hasNext() ? folders.next() : parent.createFolder(name);
  if (folders.hasNext()) throw new Error('Duplicate export folder: ' + name);
  return folder;
}

function filesByName_(folder) {
  const map = Object.create(null);
  const files = folder.getFiles();
  while (files.hasNext()) {
    const file = files.next(), name = file.getName();
    if (map[name]) throw new Error('Duplicate export file: ' + name);
    map[name] = file;
  }
  return map;
}

function writeJson_(folder, name, value) {
  return folder.createFile(Utilities.newBlob(JSON.stringify(value, null, 2), 'application/json', name));
}

function loadState_() {
  const value = PropertiesService.getUserProperties().getProperty(EXPORT_KEY);
  return value ? JSON.parse(value) : null;
}

function saveState_(state) {
  state.updatedAt = new Date().toISOString();
  PropertiesService.getUserProperties().setProperty(EXPORT_KEY, JSON.stringify(state));
}

function publishStatus_(state) {
  DriveApp.getFileById(state.statusFileId).setContent(JSON.stringify({
    schemaVersion: 1, status: state.status, mailbox: state.mailbox,
    startedAt: state.startedAt, updatedAt: state.updatedAt,
    completedAt: state.completedAt || null, scanPass: state.pass,
    processedThisPass: state.processedThisPass, newThisPass: state.newThisPass,
    matchingMessagesInFinalPass: state.matchingMessagesInFinalPass ?? null,
    remainingInCurrentPage: state.pendingIds.length,
    lastError: state.lastError || null, failedMessageId: state.failedMessageId || null,
    continuous: Boolean(state.continuous), phase: state.phase || 'initial',
    initialCompletedAt: state.initialCompletedAt || null, lastSyncAt: state.lastSyncAt || null,
    journalSeq: state.journalSeq || 0,
    note: state.continuous ?
      'Continuous: status "watching" means the initial range is done and new mail is exported every 5 minutes.' :
      'Complete means an additional scan found no unexported matching messages. Gmail is not a transactional snapshot. Do not change or delete export files while running.'
  }, null, 2));
}

function resetScan_(state, pass, historyId) {
  state.pass = pass;
  state.scanId = Utilities.getUuid();
  if (historyId) state.scanHistoryId = String(historyId);
  state.pageToken = null;
  state.pendingIds = [];
  state.listingFinished = false;
  state.processedThisPass = 0;
  state.newThisPass = 0;
}

function installTrigger_() {
  removeTriggers_();
  ScriptApp.newTrigger(EXPORT_HANDLER).timeBased().everyMinutes(5).create();
}

function removeTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === EXPORT_HANDLER) ScriptApp.deleteTrigger(trigger);
  });
}

// ---------------------------------------------------------------------------
// Relay Desk endpoint. Deploy > New deployment > Web app, Execute as: Me,
// Who has access: Anyone. Every request must carry a valid token in the POST body;
// the URL alone grants nothing. Only files inside this export can be read.

const RELAY_TOKEN_HASH = 'RELAY_TOKEN_SHA256';
const RELAY_TOKEN_CREATED = 'RELAY_TOKEN_CREATED_MS';
const RELAY_PREVIOUS_HASH = 'RELAY_PREVIOUS_TOKEN_SHA256';
const RELAY_PREVIOUS_UNTIL = 'RELAY_PREVIOUS_TOKEN_UNTIL_MS';

/** Creates a new Relay Desk token. Copy it from the log now: only its hash is kept. */
function rotateRelayToken() {
  const props = PropertiesService.getScriptProperties();
  const current = props.getProperty(RELAY_TOKEN_HASH);
  const graceMs = Math.max(0, Number(CONFIG.RELAY_TOKEN_GRACE_HOURS) || 0) * 3600000;
  if (current && graceMs > 0) {
    props.setProperty(RELAY_PREVIOUS_HASH, current);
    props.setProperty(RELAY_PREVIOUS_UNTIL, String(Date.now() + graceMs));
  } else {
    props.deleteProperty(RELAY_PREVIOUS_HASH);
    props.deleteProperty(RELAY_PREVIOUS_UNTIL);
  }
  const token = 'rdx_' + (Utilities.getUuid() + Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  props.setProperty(RELAY_TOKEN_HASH, sha256Hex_(token));
  props.setProperty(RELAY_TOKEN_CREATED, String(Date.now()));
  const days = Number(CONFIG.RELAY_TOKEN_MAX_AGE_DAYS) || 0;
  console.log('New Relay Desk token (paste it into Relay Desk; it is not shown again):\n' + token +
    (days > 0 ? '\nExpires in ' + days + ' days.' : '') +
    (current && graceMs > 0 ? '\nThe previous token keeps working for ' + CONFIG.RELAY_TOKEN_GRACE_HOURS + ' hours.' : ''));
}

/** Immediately disables every Relay Desk token. */
function revokeRelayAccess() {
  const props = PropertiesService.getScriptProperties();
  [RELAY_TOKEN_HASH, RELAY_TOKEN_CREATED, RELAY_PREVIOUS_HASH, RELAY_PREVIOUS_UNTIL]
    .forEach(function (key) { props.deleteProperty(key); });
  console.log('Relay Desk access revoked. Run rotateRelayToken() to issue a new token.');
}

function doGet() {
  return relayJson_({ ok: false, error: 'Use POST with a Relay Desk token.' });
}

function doPost(e) {
  let request;
  try {
    request = JSON.parse(e && e.postData && e.postData.contents || '{}');
  } catch (error) {
    return relayJson_({ ok: false, error: 'Invalid JSON.' });
  }
  const auth = relayAuthorize_(request.token);
  if (!auth.ok) return relayJson_({ ok: false, error: auth.error });
  try {
    const state = loadState_();
    if (!state) return relayJson_({ ok: false, error: 'No export has been started.' });
    if (request.action === 'status') return relayJson_(relayStatus_(state, auth));
    if (request.action === 'changes') return relayJson_(relayChanges_(state, request));
    if (request.action === 'file') return relayJson_(relayFile_(state, request));
    return relayJson_({ ok: false, error: 'Unknown action.' });
  } catch (error) {
    return relayJson_({ ok: false, error: String(error && error.message || error) });
  }
}

function relayAuthorize_(token) {
  if (typeof token !== 'string' || token.length < 40 || token.length > 200) {
    return { ok: false, error: 'Unauthorized.' };
  }
  const props = PropertiesService.getScriptProperties();
  const hash = sha256Hex_(token);
  const now = Date.now();
  const current = props.getProperty(RELAY_TOKEN_HASH);
  if (current && safeEqual_(hash, current)) {
    const created = Number(props.getProperty(RELAY_TOKEN_CREATED)) || 0;
    const maxAgeMs = (Number(CONFIG.RELAY_TOKEN_MAX_AGE_DAYS) || 0) * 86400000;
    if (maxAgeMs > 0 && now - created >= maxAgeMs) {
      return { ok: false, error: 'Token expired. Run rotateRelayToken() and update Relay Desk.' };
    }
    return { ok: true, expiresAt: maxAgeMs > 0 ? new Date(created + maxAgeMs).toISOString() : null, previous: false };
  }
  const previous = props.getProperty(RELAY_PREVIOUS_HASH);
  const until = Number(props.getProperty(RELAY_PREVIOUS_UNTIL)) || 0;
  if (previous && now < until && safeEqual_(hash, previous)) {
    return { ok: true, expiresAt: new Date(until).toISOString(), previous: true };
  }
  return { ok: false, error: 'Unauthorized.' };
}

function relayStatus_(state, auth) {
  return {
    ok: true, schemaVersion: 1, mailbox: state.mailbox, status: state.status,
    continuous: Boolean(state.continuous), phase: state.phase || 'initial',
    lastSyncAt: state.lastSyncAt || null, updatedAt: state.updatedAt || null,
    lastError: state.lastError || null, latestSeq: state.journalSeq || 0,
    tokenExpiresAt: auth.expiresAt, tokenIsPrevious: auth.previous
  };
}

function relayChanges_(state, request) {
  const after = Math.max(0, Math.floor(Number(request.after) || 0));
  const limit = Math.min(50, Math.max(1, Math.floor(Number(request.limit) || 20)));
  const latestSeq = state.journalSeq || 0;
  const entries = [];
  const found = DriveApp.getFolderById(state.folderId).getFoldersByName('relay-journal');
  if (found.hasNext()) {
    const journal = found.next();
    let chunk = Math.floor(after / JOURNAL_CHUNK) + 1;
    while (entries.length < limit) {
      const file = journalChunkFile_(journal, chunk);
      if (!file) break;
      const items = JSON.parse(file.getBlob().getDataAsString('UTF-8'));
      for (const item of items) {
        if (item.seq > after && entries.length < limit) entries.push(item);
      }
      if (items.length < JOURNAL_CHUNK) break;
      chunk++;
    }
  }
  const results = entries.map(function (entry) {
    const manifest = JSON.parse(DriveApp.getFileById(entry.manifestFileId).getBlob().getDataAsString('UTF-8'));
    return Object.assign({}, entry, { manifest: manifest });
  });
  const nextAfter = results.length ? results[results.length - 1].seq : after;
  return {
    ok: true, mailbox: state.mailbox, entries: results, nextAfter: nextAfter,
    latestSeq: Math.max(latestSeq, nextAfter), hasMore: nextAfter < latestSeq
  };
}

function relayFile_(state, request) {
  const id = String(request.fileId || '');
  if (!/^[A-Za-z0-9_-]{10,}$/.test(id)) return { ok: false, error: 'Invalid file ID.' };
  const file = DriveApp.getFileById(id);
  if (!insideFolder_(file, state.messagesFolderId, 4)) {
    return { ok: false, error: 'File is not part of this export.' };
  }
  const bytes = file.getBlob().getBytes();
  const offset = Math.max(0, Math.floor(Number(request.offset) || 0));
  const length = Math.min(RELAY_MAX_FILE_CHUNK, Math.max(1, Math.floor(Number(request.length) || RELAY_MAX_FILE_CHUNK)));
  const slice = bytes.slice(offset, offset + length);
  return {
    ok: true, fileId: id, name: file.getName(), mimeType: file.getMimeType(),
    totalSize: bytes.length, offset: offset, length: slice.length,
    dataBase64: Utilities.base64Encode(slice)
  };
}

function insideFolder_(file, ancestorId, maxDepth) {
  let level = [];
  const parents = file.getParents();
  while (parents.hasNext()) level.push(parents.next());
  for (let depth = 0; depth < maxDepth && level.length; depth++) {
    const next = [];
    for (const folder of level) {
      if (folder.getId() === ancestorId) return true;
      const up = folder.getParents();
      while (up.hasNext()) next.push(up.next());
    }
    level = next;
  }
  return false;
}

function sha256Hex_(text) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8)
    .map(function (b) { return ('0' + (b & 255).toString(16)).slice(-2); }).join('');
}

function safeEqual_(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function relayJson_(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}
