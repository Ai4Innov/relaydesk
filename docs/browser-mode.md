# Browser mode

The Relay Desk Browser Companion uses your existing signed-in **Chrome or Edge**
profile. It does not ask for Google credentials, read cookies, call private
provider APIs, send email, or delete messages. Opening a full conversation from
Relay Desk uses Gmail's normal message view and can mark that conversation read.

## Install and connect

1. Start and unlock Relay Desk, enable browser access, and generate a pairing code in its browser settings.
2. Open `chrome://extensions` or `edge://extensions`, enable Developer mode, choose **Load unpacked**, and select the folder opened by **Open companion folder** in Relay Desk (a copy kept in Relay Desk's data folder, refreshed on every start, so moving or rebuilding the app does not break the extension).
3. Open the extension popup from any tab, including a new tab. No Gmail/Calendar page or account link is required to pair.
4. Enter the desktop pairing code and choose **Pair**. This connects the browser profile, not one account. Existing Gmail/Calendar tabs are discovered in the background; having none open does not prevent pairing. Reload older provider tabs after installing/updating the companion if they cannot respond.
5. Use **Discover open Google accounts** to repeat discovery across open tabs. Open Gmail or Calendar once for any account not yet loaded in this browser profile. Hidden tabs discover metadata only; **Connect current tab** retries an individual tab. Discovery sends only the signed-in account's email/name, page URL, and source kind.
6. Select that account's Gmail and/or Calendar source in Relay Desk. Only selected sources can send message or event content. Use **Capture now**, or leave the tab visible for automatic capture.
7. To include Google accounts without existing inbox tabs, choose **Discover signed-in Google accounts** in the companion. Approve optional account-menu access, then let the companion inspect Google's displayed account-switch links. Each signed-in candidate opens an inbox view and must pass the normal Google-header identity check before appearing in Relay Desk. Expired sessions need Google sign-in; they are not silently connected. Gmail and Calendar for the same email share a desktop account; `/u/0`, `/u/1`, etc. are never identities.

This optional flow reads only the Google account-menu widget on `ogs.google.com`
using the fixed `accounts.js` reader injected into the isolated world through
`scripting.executeScript`, with an exact OGS location guard. It does not reload
the account iframe or execute model-generated code. Account-menu
metadata is only a discovery hint: message capture still requires a verified
top-level account, source selection and local consent, with independent AI consent.
Browser profiles do not share extension storage or pairing, so pair each profile
separately. Loaded-tab discovery continues to work without these optional grants.

**Add account by link (optional)** is a separate, collapsed navigation helper.
Its empty or invalid URL field never blocks generating or submitting a pairing
code. Use it only to open a particular account, not to connect the browser.

Install the companion separately in Chrome and Edge if you use both. Generate
a fresh code for each browser; pairing Edge preserves Chrome's connection.
Up to eight browser clients can remain paired. Desktop **Disconnect all browser
companions** revokes all of them; **Forget pairing** in a popup removes only that
browser's locally stored token.

Desktop Settings shows each paired client's inferred Edge/Chrome type and last
authenticated contact. This label is informational, not an authentication factor.
After an update, **Reload companion after update** reloads the worker without
deleting its pairing. If existing Google tabs still cannot respond, **Open fresh
account views** reuses responsive matching account views and safe companion-owned
tabs before opening a background view for an existing account route.
It does not reload original tabs, discard unsaved forms,
or open individual messages. Sign-in and source-selection requirements still
apply; activate a selected fresh view to capture content.
Use **Refresh workspace** or **Refresh now** for an immediate capture request.
**Refresh interval** controls both API sync and selected browser-tab capture:
manual-only or 30-3600 seconds. Discovery heartbeats remain independent of capture
cadence. Global sync pause always prevents content ingestion.

**Refresh selected browser pages in the background** is a separate desktop
opt-in, off by default. It permits selected loaded pages to be read while their
tabs are hidden, including when Relay Desk is foreground. Without it, hidden tabs
remain metadata-only. This does not navigate, reload or expand messages, bypass
source selection, or enable AI. Sleeping/unloaded browser tabs can still delay
updates. The inbox shows each mail source's actual last capture time, rather than
claiming that clicking refresh means a capture has completed.

The popup and a page-corner status show whether content was captured, which
coverage was available, whether selection is needed, or why extraction failed.
The extension refuses to guess the active account: it requires a Google Account
control in the top-level Google header/banner and the account email in its
accessible label. A strictly scoped `role="button"` control without an `href`
is also valid; an anchor to `accounts.google.com` is not required. English and
French account labels and bidirectional text formatting are supported.
Message bodies, event descriptions, account switcher choices, and cross-origin
account iframes are not identity
sources. If this header is unavailable or localized markup is unsupported, no
content is captured.

## WhatsApp Web (additional browser-only channel)

Use **Open WhatsApp Web** in the companion to open `https://web.whatsapp.com/`
in that same paired Edge/Chrome profile. The desktop button uses the default
browser instead. Reload an updated unpacked companion and the WhatsApp tab;
the existing pairing is retained. Link your phone using WhatsApp's normal
QR-code flow if needed. There is no WhatsApp API credential integration.

Once WhatsApp Web has loaded, the companion identifies the account from
WhatsApp's own record of the linked phone (the `last-wid-md` login entry in
web.whatsapp.com's storage), re-read on every discovery/capture. If that entry
is missing, it falls back to your **own Profile** panel's **Phone number**
(English/French layouts). It never derives the account from a contact, display
name, avatar, cookie, page script or private API, and a mismatch between the
two fails closed. Different numbers never collapse into a shared account.

Open a conversation yourself. With **Full access by default** (the default),
the WhatsApp account and every chat you open are captured and shared with AI
automatically; exclude the account or any chat in desktop Settings. With it
off, new WhatsApp accounts have ingestion and AI off until you enable them and
select chats. Conversation/message identifiers come only from the rendered
message DOM (`data-id`); chats with no loaded stable IDs are not guessed.
Received times are parsed from WhatsApp's displayed `[time, date]` header;
day/month ambiguity follows the browser language.
Coverage is the last 200 supported **currently loaded visible message bubbles**
of the selected open chat, never the entire account/history. “Full” means the
captured bubble text, not a complete conversation. Original displayed timestamps
are retained; ambiguous localized dates are not converted into fabricated UTC
times. Older/unloaded/collapsed messages, view-once media, voice messages and
unsupported layouts are omitted. Supported document tiles contribute names
only, not file bytes: download the file yourself in WhatsApp and import that
copy against its captured metadata in Relay Desk. Provenance validation still
applies. Local drafts can be copied and WhatsApp opened; the companion never
opens a composer, inserts text, clicks Send or sends a message.

## Add account by link

In desktop **Settings > Connect your browser > Add account by link**, paste a
signed-in account's Gmail or Google Calendar URL, then explicitly choose
**Open account page in default browser**. This uses the normal system browser;
it does not choose a paired browser/profile. If your default browser differs,
use the companion's **Add account by link** in the paired Edge/Chrome profile.

The desktop accepts only HTTPS links on exact `mail.google.com` `/mail/` or
`calendar.google.com` `/calendar/` routes, without credentials or non-default
ports. Numeric `/u/N` routes and `authuser` email hints are retained (numeric
`authuser` becomes `/u/N`); duplicate or conflicting selectors are rejected.
Message/event identifiers, drafts, searches, other query parameters and original
fragments are discarded, opening only the inbox or calendar root. Encoded
ordinary route characters are accepted, but encoded separators and traversal
are rejected. Numeric slots are profile-specific and may change.

Links are navigation hints, never identity or authorization. Opening a page
does not register or connect an account. Sign in through Google's normal page
if necessary; only the companion's existing signed-in top-header discovery
registers the actual identity. Pairing, source selection, background capture
and independent AI consent requirements remain unchanged. This flow adds no
OAuth exchange, private Google API calls or cookie access.

## Full email in the unified inbox

Full-email downloading is **on by default** for selected, locally consented Gmail
browser sources. A serial background queue fetches discovered conversations,
including older previews already in the archive. Complete plain text and
body-only HTML are stored in the encrypted archive, and full text is indexed
locally for search and RAG. This does not require an AI run or account AI consent;
sharing retrieved evidence with Copilot still requires its separate consent.

The **Full emails, stored locally** panel in Unified inbox and Settings shows
downloaded, queued, and failed conversation counts. Use **Pause email downloads**
to stop background downloads or **Download pending / retry failed** to retry.
Global sync pause and account/source exclusions also stop downloading.
Failures use bounded backoff; progress survives restart. Files attached to an
email are queued separately for automatic file download and indexing, with approval gates.

Selecting a Gmail conversation can also request its complete loaded
messages through the paired companion. The desktop supplies the archived
account and stable thread identity, not an arbitrary URL or instruction.
The companion uses a separate Gmail read tab in that browser profile, verifies
the signed-in account and exact thread, and reads expanded message bodies,
body-only HTML, and attachment metadata. Existing tabs and unsaved forms are
not navigated. Gmail may mark the conversation read as a normal consequence
of opening it.

### Browser tab reuse

Mail downloads reuse a bounded set of companion-owned worker tabs instead of
creating a fresh tab for every conversation. Ownership is recorded for the current
browser session and survives service-worker suspension. Reuse still requires fresh
page/account checks; a numeric account route alone never establishes identity.
The bounds are three readers, three separate bootstrap tabs, and 24 account views.
Verified idle tabs expire after 15 minutes. Mail workers open in the background
instead of repeatedly stealing the selected tab.
Tabs used by you, tabs with unsaved work, and unrelated tabs are not repurposed.
If a worker tab cannot be safely inspected, the companion does not treat that as
permission to close it or keep opening unlimited replacements.

The companion popup shows **Agent browser tabs** counts and a **Close idle agent
tabs** control. Cleanup is limited to recorded, safely idle agent tabs; active jobs
and your own work are retained. Repeating account discovery or opening account
views prefers existing suitable tabs. Tabs from older versions without an ownership
record cannot safely be identified as agent-created and must be closed manually.
Protected, loading, busy, and unresponsive counts explain why tabs may be retained.
The last recorded issue is historical diagnostic information, not proof of an
ongoing browser failure. Inspection and popup operations have deadlines; a timeout
retains the tab rather than allowing a late response to close it.

The reader shows loading, an explicit failure with **Retry full email**, or the
complete messages inside Relay Desk. **Reload full conversation** requests a
fresh read. A completed thread is retained in the encrypted archive; an
unchanged cached thread can be opened without a fresh browser request.
Conversation rows are grouped so captured full messages do not duplicate their
earlier inbox preview. Existing local drafts retain their original references.

These local reads need the account's local-access consent and selected Gmail
source, not AI consent, a Copilot run, or an API key. Global pause, account/source
revocation, an unavailable companion, unsupported layouts, and expired sign-ins
produce an error rather than labeling a preview complete. Switching the reader
to another conversation ignores late results for the previous selection.
Remote images and executable content remain blocked in formatted email.
Attachment metadata is not a downloaded file. The attachment queue below must
finish downloading and extracting each file before its text is usable for retrieval.

Full-email dispatch does not depend on a Gmail tab staying awake. The paired
companion checks pending reads from its background worker, including a
30-second browser alarm. If needed, it opens a separate account inbox and
verifies Google's signed-in header before claiming the read. Existing sleeping
tabs and unsaved forms are left untouched. Dispatch ownership survives worker
restarts; interrupted reads are reported rather than silently replayed.
The browser must still be running and the account signed in.

An uncached conversation must be identifiable by its exact captured thread ID
in the loaded Gmail inbox. Moved or unloaded rows, clipped message bodies,
unsupported layouts, threads over 200 messages, and oversized captures are not
reported as complete. The reader shows a failure instead of silently presenting
an inbox snippet as the full email.

## Coverage and privacy

- Gmail inboxes provide **loaded row previews**, not complete message bodies.
  Background capture of open conversations provides **expanded, loaded message
  text** only and does not expand or paginate. Explicit full-email requests from
  the unified inbox use the separate, bounded conversation-read workflow above.
  Expanded Gmail bodies also retain up to 1 MB of their body-only HTML for
  sanitized presentation, never the surrounding account UI. AI and message
  revisions still use plain text; markup-only changes do not stale drafts,
  and later inbox previews do not erase the captured body markup.
  Validated Google Meet destinations of visible links are preserved as plain
  text, even when Gmail displays a label such as "Join" instead of the URL.
- Google Calendar supports recognizable loaded event chips (including nested
  chips with accessible labels), agenda/event cards and opened event details.
  This is the loaded view, not a full calendar history or a promise of complete
  event details. Descriptions, locations, and Meet links are available only when
  their detail elements are loaded and visible. Only HTTPS `meet.google.com`
  meeting-code links are accepted, not lookalike hosts or redirect links.
- Email attachment capture records metadata from attachment tiles in loaded,
  expanded Gmail messages, not inbox previews or unloaded messages. A separate,
  default-on queue downloads permitted files using the exact native attachment
  link in a verified account/message through the browser Downloads API. Install
  the updated companion and allow its Downloads permission. Downloads temporarily
  use a request-specific `RelayDesk` subdirectory under the user's `Downloads` folder
  (Windows, macOS or Linux), then
  the exact verified file is encrypted and that temporary copy removed.
  Custom or localized download directories not named `Downloads` require the manual
  import fallback. Cookies, credentials and arbitrary cloud links are not extracted.
  Unknown-size, large and costly files require approval; browser safety warnings
  are never bypassed. **Download and index** retries an individual file, while
  **Import downloaded file** remains available for a matching user-downloaded copy.
  Source permission, processing approval and extraction limits remain enforced.
  The attachment panel distinguishes retained files from indexed text. Successfully
  indexed attachment text is searchable, but comprehensive AI archive review
  currently excludes attachment contents. AI disclosure requires separate
  account consent. Downloaded copies
  outside Relay Desk remain subject to your normal local-file privacy rules.
- Displayed date/time text is preserved. Missing exact timestamps are not
  invented. Calendar display text is not converted into guessed dates.
- Unread previews can produce local action suggestions, with a warning when
  their date is uncertain. Drafts can be generated manually after account AI
  consent. When the same Gmail address is also connected through the official
  Gmail API, manual generation verifies and uses the full native thread context
  for that explicitly selected browser message, and **Save draft to Gmail**
  creates or updates a Gmail draft only after that verification. Other browser
  accounts remain local-only until you optionally connect that exact same email
  through the API. Background drafting for browser Gmail is bounded: only
  newly observed unread browser messages after AI/background opt-in are
  considered, Relay Desk verifies them against the same-email Gmail API account,
  skips anything without a recent verified `receivedAt`, and then uses the
  existing AI budget/checkpoint protections. Existing archived previews are not
  retroactively hydrated into a bulk draft backlog.
  **Save & open in Gmail** saves exactly the edited body, subject and recipients
  before opening Gmail Drafts. If saving fails, it does not open Gmail or claim
  the reply was saved. Nothing is sent.
- This is **not a full-history sync**. Offscreen-but-rendered rows may be captured,
  but unloaded/virtualized history is not. Hidden tabs pause capture unless the
  background-browser opt-in is enabled. No capture
  occurs while the browser is closed. Metadata heartbeats run about every eight
  seconds; content capture follows the configured interval and skips unchanged
  loaded content. Manual refresh can recapture the same view. Hidden tabs remain
  metadata-only until activated unless background browser refresh is enabled.
- Unknown DOM or ambiguous identity produces an explicit error, not an empty
  successful capture. Recognized provider empty-state markup is required for an
  empty result. Partial supported views explicitly report skipped items.
- Each attempt rechecks source selection before reading content and again in
  the background before upload. The desktop remains the final consent authority.
  A capture is limited to 200 messages or 100 events and 1 MB of serialized data;
  oversized views fail visibly rather than silently truncating.
- Content goes only to Relay Desk's local desktop encrypted archive through
  `http://127.0.0.1:43891`. The companion never calls a model, analytics service,
  or remote relay, and never stores captured content in extension storage.
  Desktop AI disclosure controls remain separate and are not enabled by pairing.
- **Forget pairing** deletes the extension's local token. Desktop revocation is
  enforced on subsequent requests. A revoked/invalid token (HTTP 401) is removed;
  network failures, startup/lock errors, and source-selection errors preserve
  pairing so you can restart/unlock Relay Desk without repairing.

Google changes its UI frequently. Some layouts, languages, collapsed events, or
account headers may be unsupported. Use the existing **API connectors** when
broader history or reliable unattended sync is needed; browser mode does not
replace or disable that fallback.

## Integration

The unpacked Chromium extension ID is
`haiiamalgpmpjeaaldpdopnaogallplh`; its pinned origin is
`chrome-extension://haiiamalgpmpjeaaldpdopnaogallplh`.
`manifest.json` contains a stable base64 DER SPKI public key. Its private key
was not persisted. Keep this public key unchanged: the desktop computes its
allowed extension origin from it.

The Manifest V3 worker is the only HTTP client. The popup cannot submit content.
Top-frame content messages must come from an allowed HTTPS Google page, with
`pageUrl` matching both the message sender and the tab's current URL, and with
the matching `mail`/`calendar` kind. The bearer token is stored only in extension
local storage restricted to trusted extension contexts, not in content scripts.
Basic loaded-tab capture needs no `tabs`, `cookies`, `debugger`, `scripting`, or
`webRequest` permission. Optional signed-in account discovery requests `scripting`
and account-widget host access explicitly. It never requests cookies, debugger,
or webRequest access.

| Endpoint | Payload / result |
| --- | --- |
| `POST /pair` | `{ code }` -> `{ token }` |
| `POST /discover` | `BrowserRegistration` -> `BrowserAccess { accountId, enabled, refreshIntervalSeconds, refreshRequestedAt }` |
| `POST /capture` | `BrowserCapture` -> `{ accepted: true }` |

After pairing, requests include `Authorization: Bearer <token>`. Payloads follow
`src/shared/browser.ts`. Extraction helpers are plain JS, exported via CommonJS
for tests and exposed only in the content script's isolated world in Chromium.
No web-accessible resources or externally-connectable message API are declared.

## Fixture tests

Run `npm.cmd test -- tests/browser-extension.test.ts` with the project's supported
Node version. DOM tests use the existing Playwright dependency and bundled
Chromium if present. To explicitly opt into an installed Edge when bundled
Chromium is absent, set `$env:RELAY_EXTENSION_TEST_EDGE='1'` first. This launches
a fresh, isolated, headless fixture browser, never your signed-in profile or
live Gmail. Edge opt-in also exercises the actual unpacked worker, popup, and
isolated content script under the pinned extension ID. Without an available opted-in browser, the DOM group is skipped;
background, manifest, and URL-boundary tests still run.

For an actual extension-to-bridge HTTP round trip, also set
`$env:RELAY_EXTENSION_TEST_BRIDGE='1'`. This opt-in requires the fixed port
`127.0.0.1:43891` to be free; it fails rather than reusing or stopping an existing
desktop service. It pairs the real unpacked extension with an isolated,
in-memory instance of the production bridge, discovers a synthetic account,
captures a synthetic Gmail row only after selection, and exercises revocation.
It never opens a signed-in profile or contacts live Google pages.

Fixture coverage is not live Google validation. The desktop integration owner
must validate actual signed-in Google layouts separately.
