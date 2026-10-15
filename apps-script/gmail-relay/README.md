# Automatic Gmail-to-Drive export

Exports individual Gmail messages, not conversation snippets, for an inclusive
calendar-date range into a Google Drive folder you choose. Runs in Google's cloud:
no browser automation, Relay Desk process, or AI API key is required.

## Setup

1. Sign in to the **Gmail account to export**, then create a project at
   <https://script.google.com>.
2. Paste `Code.gs` from this folder into the project's `Code.gs`.
3. Open **Project Settings**, enable **Show "appsscript.json" manifest file in
   editor**, and replace that manifest with the supplied `appsscript.json`.
   It enables the Advanced Gmail service. If using a manually assigned standard
   Google Cloud project, also enable **Gmail API** in that project's API library.
4. Edit the fields at the top of the script:

   ```javascript
   DRIVE_FOLDER_URL: 'https://drive.google.com/drive/folders/YOUR_FOLDER_ID',
   START_DATE: '2026-09-01',
   END_DATE: '2026-09-30',     // ignored when CONTINUOUS is true
   TIME_ZONE: 'Africa/Lagos',
   CONTINUOUS: true,           // keep exporting new mail after the initial range
   ```

   Both dates are inclusive. Use an IANA timezone, such as `Europe/Paris`,
   `America/New_York`, or `Etc/UTC`. The script uses that timezone for midnight
   boundaries, including daylight-saving changes. The manifest timezone does not
   override this explicit date-range setting.
5. Select **startGmailExport** and click **Run**. Review Google's permissions.
   Your organization must permit Gmail read access and Drive export. You need
   write access to the destination folder; a link alone does not grant access.
6. The first batch runs immediately. An installable trigger resumes unfinished
   work every five minutes, even after you close your browser. The trigger is
   removed when the export finishes, is cancelled, or pauses after repeated errors.

The folder can be supplied as a normal Drive folder URL or its ID. Resource-key
folder links are supported. Prefer a My Drive folder: this uses `DriveApp`, whose
support for shared drives is limited.

## Troubleshooting

`ReferenceError: Gmail is not defined` means that this Apps Script project has not enabled the Advanced Gmail service. In the editor's left sidebar, click **Services (+)**, choose **Gmail API**, set version `v1`, keep the identifier `Gmail`, and click **Add**. Save the project, then run `startGmailExport` again and approve the permissions.

If you use a standard Google Cloud project instead of the default project, also enable the Gmail API in that project's API Library. A Workspace administrator can also block the service.

`Gmail did not return the raw MIME message` came from an earlier version of the script. In Apps Script, the Advanced Gmail service returns `raw` and attachment `data` as byte arrays, not base64 strings. The current script also records, rather than stops on, `Downloaded MIME body size differs from Gmail metadata`. Gmail's per-part size is approximate for some text parts, so each part in `message.json` records `gmailReportedSizeBytes` and `sizeMatchesGmail`. `message.eml` remains the complete original. The export still stops if Gmail omits the data for a non-empty part.

After updating the code, paste the new `Code.gs`, save it, then run `resumeGmailExport`; do not run `startGmailExport` again. The script continues in the same export folder, and messages that were already saved are not downloaded again.

`Lock timeout: another process was holding the lock` came from an earlier version. It appeared when a scheduled five-minute batch was still running. Now `resumeGmailExport` saves your request when a batch is running, and the next batch applies it within about five minutes.

## Ongoing export (CONTINUOUS)

With `CONTINUOUS: true`, the script first exports everything from `START_DATE` to
now. Its status then changes to **`watching`**, and the five-minute trigger stays
installed. Each run asks Gmail's history API for messages added since the last
run and exports them in the same layout: full `.eml`, bodies and attachments. Drafts
are skipped. Spam and Trash follow `INCLUDE_SPAM_AND_TRASH`. New mail therefore
reaches Drive within about five minutes.

- Gmail keeps history for only about one week. If the script is stopped longer
  than that, it automatically falls back to a full rescan. Messages already saved
  are skipped, not downloaded again.
- **Switch an existing export:** set `CONTINUOUS: true`, paste the code, save,
  and run `resumeGmailExport`. This works even if the export already finished.
  It keeps the same folder and start date, and existing messages are not
  downloaded again.
- `cancelGmailExport` stops watching. Apps Script triggers have a daily runtime
  quota; on consumer accounts, a five-minute trigger on a quiet mailbox uses
  only a small part of it.

## Relay Desk access (web app + rotatable token)

Do **not** share the Drive folder with "Anyone with the link". A Drive link
cannot be rotated because the folder ID is permanent, and anyone holding it can
read all your mail. Instead, the script contains a small read-only endpoint that
Relay Desk calls with a secret token:

1. In Apps Script: **Deploy → New deployment → Web app**, set **Execute as: Me** and
   **Who has access: Anyone**, then click **Deploy**. Copy the `/exec` URL. "Anyone"
   lets Relay Desk call the URL without a Google sign-in. Every request is
   rejected unless it contains a valid token, and only files inside this export
   can be read.
2. Run **`rotateRelayToken`**. Copy the token from the execution log. Only its
   SHA-256 hash is stored, so it is not shown again.
3. In Relay Desk, add an **Apps Script relay** with the URL and token.

**Rotation:** tokens expire after `RELAY_TOKEN_MAX_AGE_DAYS`, which defaults to 90.
Rotate before that, or immediately if a token may have leaked: run
`rotateRelayToken` and paste the new token into Relay Desk. The previous token
keeps working for `RELAY_TOKEN_GRACE_HOURS`, which defaults to 24, so syncing is
not interrupted. Run **`revokeRelayAccess`** to cut off all access instantly. The
URL itself never needs rotating; delete the deployment only if you want the
endpoint gone.

After changing the script code, use **Deploy → Manage deployments → Edit →
Version: New version**. A web app serves the version that was deployed, and
editing it this way keeps the same URL.

Workspace domains can forbid "Anyone" web apps. In that case, Relay Desk cannot
use this route for that account. Use the Gmail API connection or browser
fallback instead.

## Files produced

Each run creates a **new**, uniquely named subfolder. Existing destination files
are not overwritten, and Gmail messages are never sent, marked read, or changed.

```text
Gmail-export_<start>_to_<end>_<unique-id>/
  export-info.json
  export-status.json
  relay-journal/
    000001.json        # append-only change feed read by Relay Desk (500 entries per file)
  messages/
    <gmail-message-id>/
      message.eml
      message.json
      relay-journaled  # marker: message is listed in relay-journal
      bodies/
        0-0__part.txt
        0-1__part.html
      attachments/
        0-2__invoice.pdf
        0-3__image.png
```

- **message.eml**: Gmail's complete raw RFC 2822/MIME representation, including
  headers, body alternatives, MIME boundaries, and encoded attachments.
- **message.json**: written only after the raw message and all exposed MIME body
  parts/attachments have been saved. Includes Gmail message/thread IDs, original
  headers and filenames, receipt timestamp, labels, MIME structure, and relative
  paths plus Drive IDs for files. This is the completion marker.
- **bodies/**: full plain-text and HTML MIME body bytes, not inbox previews.
  Original encodings are preserved; use the recorded Content-Type charset when
  decoding. Multipart alternatives can contain equivalent content.
- **attachments/**: attachment bytes and inline non-text parts, including inline
  images. Traverses nested MIME structures; duplicate filenames get unique MIME
  path prefixes. A large text body stored by Gmail through an attachment ID is
  still classified as a body, not automatically mislabeled as an attachment.
- **export-status.json**: live state (`running`, `watching`, `retrying`, `paused`,
  `complete`, or `cancelled`), current scan counts, last sync and last error.
  Counts are per scan, not cumulative unique totals across retries.

Relay Desk imports through the web app described above. It reads the journal,
downloads each `message.eml` and its attachments, and stores them in its encrypted
archive and local RAG index. To use the files elsewhere, read completed
`message.json` records. Keep Gmail IDs and MIME paths as citations, and parse
`.eml` with a MIME parser rather than indexing raw base64 as text.

## Scope and completeness

- Selection uses Gmail's **internalDate**, normally the mailbox receipt time,
  rather than the sender-controlled `Date` header. Imported/migrated mail can have
  a different internalDate. The timestamp is checked again on every downloaded
  message; date filtering never includes an entire thread just because one reply
  matched.
- Includes all matching messages across folders/labels, including sent mail,
  drafts, Spam and Trash by default. Set `INCLUDE_SPAM_AND_TRASH` to `false` to
  exclude those two locations. This is not limited to Inbox or unread mail.
- Exports what Gmail exposes to the authorized account. Deleted/purged messages,
  confidential-mode restrictions, unavailable content and organizational policies
  cannot be bypassed. Google Drive links in a message are **not MIME attachments**
  and are not followed. Unsupported nested formats remain preserved in raw MIME.
- With `CONTINUOUS: false`, the fixed timeframe is evaluated during the run and the
  export ends when complete. With `CONTINUOUS: true`, see *Ongoing export* above.
- A second scan checks for newly discovered messages. Up to three scans are
  performed; an unstable mailbox pauses rather than silently declaring success.
  Gmail does not provide an atomic mailbox snapshot. Avoid changing matching
  mail during the export; continuously arriving, changed drafts, moved or deleted
  messages can affect a scan. Previously completed files are not refreshed.
- Do not rename, alter or remove export files while the job runs or is paused.
  Resumption reuses them; the final scan checks coverage, not cryptographic
  integrity or subsequent edits to Drive files.

## Resume, status and cancellation

Run **showGmailExportStatus** to see the export folder link and current state.
Check **Executions** in Apps Script for trigger failures.

Run **resumeGmailExport** after correcting an error. It keeps completed files,
restarts enumeration (also recovering expired page tokens), and reinstalls the
trigger. Partial message folders are resumed using existing files; the same
message is not marked complete until every required part is present.

Run **cancelGmailExport** to stop the trigger and keep existing files. To use
different configuration after starting, cancel, edit CONFIG and start a new run.
Resume uses the original saved configuration, except that `CONTINUOUS: true`
switches an existing export to ongoing mode. One active export per user
per script project is supported; use a separate signed-in project per mailbox.

## Quotas, privacy and practical limits

The script yields after about four minutes, saves progress and continues later.
This is below Apps Script's normal six-minute execution limit, but any single
Google service call or very large message can still exceed platform limits.
There is no artificial attachment-size filter; **Apps Script is not unlimited**:
Gmail/Drive requests, memory, conversion, Drive storage, daily trigger runtime and
account-specific quotas all apply. Five consecutive caught failures pause the
export with the failing message still queued. Nothing is silently skipped.
Hard runtime terminations may not execute error handlers; inspect Executions and
resume after quota reset. Repeatedly unexportable messages require addressing the
reported cause or using a more suitable Gmail API client, not a larger timeout.

Saving raw MIME **and** extracted attachments duplicates data and consumes extra
Drive space. The Drive scope is broad because `DriveApp` must access an arbitrary
existing folder: review it before authorizing. The code writes only inside the
new export subfolder and does not change sharing permissions. Copies inherit the
destination's sharing rules and are **not encrypted by Relay Desk**. Choose a
private folder permitted by your workplace's retention and privacy rules.

Exported messages and files are untrusted input. Do not execute attachments or
open exported HTML as trusted web content: it can contain remote tracking URLs.
Encrypt and sanitize content appropriately when importing locally.

References:
- <https://developers.google.com/apps-script/advanced/gmail>
- <https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/get>
- <https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list>
- <https://developers.google.com/apps-script/guides/services/quotas>
