# Relay Desk

A local-first Windows communications workspace built with Electron, React and TypeScript. It imports selected Gmail, Microsoft and Slack sources, keeps a searchable encrypted archive, and prepares responses using your signed-in GitHub Copilot subscription.

> Relay Desk is an [Ai4Innov](https://github.com/Ai4Innov) open-source project, licensed under [Apache-2.0](LICENSE). It is an independent project and is **not affiliated with, endorsed by or sponsored by GitHub, Microsoft, Google, Slack or Meta**. You are responsible for complying with your employer's policies and each provider's terms, including the [GitHub Copilot terms](https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features#github-copilot).

## Highlights

- **No AI-provider API key.** Generation uses the official [`@github/copilot-sdk`](https://github.com/github/copilot-sdk) with your signed-in Copilot subscription. Pick any entitled model per message.
- **One inbox for many channels.** Gmail (Apps Script relay, Gmail API, browser companion or Playwright fallback), Microsoft 365, Slack, WhatsApp Web and Google/Microsoft calendars.
- **Chat agent with reviewed actions.** It finds what needs attention, cites evidence, drafts replies, creates tasks and reports, and writes DOCX/XLSX/PPTX files. Every write is an action card you confirm, and Relay Desk never sends email.
- **Local-first and encrypted.** The archive uses SQLCipher, encrypted attachments and a Windows DPAPI-protected key, with local keyword and optional semantic (RAG) search.
- **Explicit consent.** Every account has separate controls for data access, source selection and AI sharing.

## Quick start

Requires Windows x64 and official [Node.js 24](https://nodejs.org/) (`^24.13.0`).

```powershell
git clone https://github.com/Ai4Innov/relaydesk.git
cd relaydesk
npm install
npm run doctor     # checks native prerequisites
npm start          # launches the desktop app in development mode
```

Then open **Settings → Connections** to add a mailbox and **Settings → Copilot & assistant** to sign in to Copilot and choose a model. See [Windows setup](#windows-setup) and [First use](#first-use) for details.

## Repository layout

| Path | Contents |
| --- | --- |
| `src/main` | Electron main process: `service.ts` orchestration, `commands/` domain handlers, `chat.ts` agent, connectors, storage, retrieval, attachments, browser bridge. |
| `src/preload` | Narrow, validated IPC bridge. |
| `src/renderer` | React UI (Chat, Inbox, Calendar, Drafts, Settings). |
| `src/shared` | Contracts and schemas shared between processes. |
| `browser-extension` | Chrome/Edge companion (Manifest V3) for browser capture. |
| `apps-script/gmail-relay` | Optional Google Apps Script that exports Gmail to Drive for the relay connector. |
| `tests` | Vitest unit, integration and opt-in browser UI tests. |
| `docs` | Architecture, provider setup, privacy, browser mode and agent documentation. |

## Contributing, security and license

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md). Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md), never in public issues.

Relay Desk is licensed under the [Apache License 2.0](LICENSE). Third-party notices are in [NOTICE](NOTICE).

## Chat-first workspace

Relay Desk opens into **Chat**. Ask Copilot to find important messages, explain your schedule, prepare replies, create or update tasks, generate a focus report, or refresh your inboxes. The agent uses scoped Relay Desk tools to work with your authorized sources, rather than just answering from a fixed prompt. Choose an entitled model directly in the composer; each response records the model actually used.

Attention summaries start with a bounded, account-balanced shortlist of permitted email excerpts, with citations and explicit coverage limits, rather than paging through the entire archive. Chat progress distinguishes working through evidence from writing the answer. Active responses may continue beyond three minutes; three minutes without meaningful activity or the ten-minute overall response deadline stops the request. Cancellation and confirmation requirements still apply.

Conversations persist in the encrypted local archive. Source cards expose supporting evidence, live progress shows what the agent is doing, and **Stop response** cancels its current request. New conversations, conversation deletion, starter prompts and shortcuts to the existing Inbox, Tasks, Calendar and Settings screens are available alongside the chat.

Answers render headings, lists, tables, quotations and code blocks instead of raw Markdown. Action previews show readable fields and calendar before/after cards, with the complete approved payload still available. Raw HTML, scripts, remote images and embedded content are not allowed.

Full Gmail messages are queued **automatically by default** for selected unified inboxes and indexed locally for search and AI retrieval. A resumable serial queue fills older preview-only conversations, with downloaded/queued/failed counts and pause/retry controls. Reads use the same mailbox's Gmail API when authorized, otherwise the explicitly enabled Playwright fallback. Opening a conversation supports an explicit full read. No AI request or AI-provider API key is needed for downloading; AI disclosure still requires consent. Browser reads may mark conversations read; API reads do not. Nothing is sent. Completed threads remain encrypted. A sandboxed formatted view preserves tables, colors, and basic layout while blocking remote images, tracking resources, scripts and embedded documents. API attachment originals download through the encrypted processing pipeline, with approval for unknown-size, large, or costly files; the companion/manual import remains available for browser-only attachments. Inbox reads cover recent/discovered conversations, while API historical backfill is a separate operation.

The browser companion reuses a bounded set of its own mail worker tabs. Its popup shows tab counts and **Close idle agent tabs**; your original tabs and unsaved work are preserved. Existing suitable account views are reused before opening another. Older tabs without recorded agent ownership are not automatically closed.

Attachment rows and Chat document citations open the internal viewer: PDF pages with zoom/navigation, local images, or extracted Office/text content. **Save to Downloads** exports the retained original through a native save dialog without overwriting existing files. Gmail attachments offer **Download and index** and any required approval; **Import downloaded file** remains a fallback and is still required for WhatsApp. Metadata is not file content: only successfully extracted text is usable for local RAG. See [document formats and limits](docs/attachment-support.md).

**WhatsApp Web** is available through the same paired companion. Link your phone normally, verify your own Profile phone, enable local capture, and select individual chats. AI sharing remains separate. This reads loaded chat messages, not invisible history, and never sends a reply. See [WhatsApp setup](docs/browser-mode.md#whatsapp-web-additional-browser-only-channel).

Changes appear as exact action previews. Click **Confirm action** to execute one; a model proposal alone never writes anything. Native draft saves show recipients and complete text, and calendar writes show their exact event details and notification effects. Replies are never sent. Browser-only accounts still need an authorized API connection for native writes, and chatting never enables AI sharing for an excluded account.

Chat uses the existing Copilot subscription and local AI budget, not a separate API key. A previously selected subscription reconnects automatically when Chat opens; sign-in or entitlement failures remain visible without a retry loop or fallback model. Final answers appear when the agent finishes; progress is live but answer text is not token-streamed. See [chat capabilities, approvals and limits](docs/chat-agent.md).

Chat offers **Yes / No** before downloading latest messages for an answer.
**No** uses the newest messages already in the local archive; explicit "no need to
refresh" wording skips the prompt and prevents question-triggered downloads.
**Yes** awaits the selected, AI-permitted inbox refresh and reports actual failures
or partial coverage. Skipping refresh is not shown as a failed download.
Attention summaries include recent arrivals and one newest message per conversation,
so repeated old replies cannot crowd out today's mail. Background sync settings,
account/source permissions and provider-write approvals remain unchanged.

### Assistant tools (files, documents, shell, web)

Chat can also act like a native Copilot agent: it can read and write files in its
workspace folder (default `Documents\Relay Desk`), create real **Word (.docx), Excel
(.xlsx) and PowerPoint (.pptx)** files, run PowerShell commands and fetch web pages.
Created files appear as cards with **Open** and **Show in folder**; **Open** is only offered
for passive document/image formats, so a script-like file (for example `.hta` or `.bat`)
can only be shown in its folder, never launched from the app. Reads outside the
workspace, every shell command and every web request show an approval card first
(**Allow once**, **Allow for this response** for shell/web, or **Deny**). Configure the
workspace folder and shell/web policy (ask / off) in **Settings → Copilot & assistant**.
Email content never triggers these tools on its own, and Relay Desk never sends email.

### Settings and connection priority

Settings has four tabs: **Connections**, **Copilot & assistant**, **Data & app** and
**Advanced**. Connections shows one card per mailbox listing each of its connection
methods. Each method has its own **Remove** button, and **Remove mailbox** removes all of
them. Removing keeps local copies (excluded from AI) unless you tick **Also delete local
copies**. Provider mail is never touched.

Each mailbox is read through its best method: **Apps Script relay → Provider API →
browser companion**. Refreshing a browser-captured Gmail inbox syncs that mailbox's
relay first and only falls back to browser capture if the relay fails. Answers, drafts
and suggested actions are based on full message bodies whenever a relay or API copy
exists. A browser preview newer than the latest relay export stays visible but is
labelled preview-only. How current relay mail is depends on how often the Apps Script
export runs.

## Gmail via Apps Script relay

The relay script and its setup guide live in [`apps-script/gmail-relay`](apps-script/gmail-relay/README.md).

For Gmail mailboxes where OAuth is not configured, Relay Desk can import from a
user-owned Google Apps Script relay that exports complete `message.eml` files and
attachments to Drive. In Apps Script, deploy the script as **Deploy → New
deployment → Web app**, choose **Execute as: Me** and **Who has access: Anyone**,
then run `rotateRelayToken()` and paste the web app URL plus token in **Settings
→ Connections → Add a connection → Gmail via Apps Script relay**. After editing the script, use **Manage
deployments → Edit → New version** so the URL stays the same.

Relay Desk only accepts HTTPS web app URLs on `script.google.com` and follows
Apps Script redirects only to `script.google.com` or
`script.googleusercontent.com`. The relay token is stored in the encrypted local
credential store, is never returned to the renderer, and can be replaced from
Settings. Rotate it at least every 90 days; the previous token keeps working for
24 hours after rotation. Use `revokeRelayAccess()` in Apps Script to revoke
Relay Desk access. Select the relay source before importing; Copilot sharing
still follows the Gmail account's separate AI consent.

## Gmail API, browser companion and Playwright fallback

**Direct browser mode:** in **Settings > Gmail reading method**, select **Direct
browser — signed-in Chrome / Edge companion** to read your selected browser
inboxes through their normally signed-in, paired browser instead of Gmail API or
managed Playwright. This is an explicit choice, not an automatic response to API
or Google sign-in rejection. API-connected accounts remain separate; existing
API-derived content retains its API permission restrictions. No new source or AI
consent is granted, and no cookies or credentials are copied.

The companion waits for the verified account, loaded Inbox, exact conversation
row, navigation, expanded message bodies, and stable complete content. It reuses
owned worker tabs, preserves user edits, and stops at a bounded deadline if the
page never becomes ready. A loading delay is not proof of a completed download;
missing/clipped content remains incomplete and cannot substantiate a latest-mail
answer. After installing an updated desktop build, reload the companion using
its **Reload companion after update** control.

The recommended Gmail setup is **Settings > API connections**: configure a Google desktop OAuth client, connect each mailbox, and select its Inbox. A connected, authorized API Inbox for the same email address is automatically preferred when reading the existing unified browser inbox. Full message MIME bodies (plain text and HTML), original received timestamps, and attachment references come from Gmail API; attachment originals go through the encrypted local download/extraction pipeline. Google OAuth authorization is separate from Copilot: AI still uses your signed-in Copilot subscription and selected model, without an AI-provider API key.

For a mailbox without an API connection, **Settings > Gmail API first, Playwright fallback > Open fallback / sign in** enables actual Playwright browser control, but only where Google permits that browser session. **Google can block automated-browser sign-in even in current Chrome**, displaying "This browser or app may not be secure." Relay Desk detects this rejection, pauses automatic Playwright reads, and directs you to Gmail API OAuth in your normal browser. Repeated login attempts, changing your password, or switching automation frameworks are not a reliable fix. Playwright is not a guaranteed alternative to API authorization. It does not copy cookies, reuse your personal browser profile, disguise automation, or bypass login challenges or workplace policies. Its persistent profile stores its own session outside Relay Desk's encrypted vault. Closing it through Settings pauses fallback; API connections remain available.

The fallback uses bounded owned tabs, native browser clicks, trusted account identity, exact conversation matching, and expanded-message validation. Unsupported, clipped, or incomplete reads fail visibly rather than accepting snippets as full messages. Browser-only attachment retrieval continues through the paired companion/manual import where available; Playwright full-body support is not a guarantee that every attachment can be downloaded. Gmail API is the preferred reliable attachment route.

In API-first mode, an existing API connection with expired/revoked authorization, excluded Inbox, quota, or policy failures produces an actionable error instead of silently switching to browser access. API-derived copies in the browser inbox retain both connections' permission dependencies even in direct browser mode; API source exclusion also excludes those copies, and cloud AI requires consent for both account records. Switching reading methods invalidates old transport-specific full-thread cache proofs. Manual and scheduled inbox refreshes use the same routing; historical backfill and other channels remain separate jobs.

The paired companion remains available for account discovery, Calendar, WhatsApp, and existing browser attachment workflows. Load it as an unpacked Chrome/Edge extension and pair it with the desktop app's short-lived code. Browser-only capture requires no Google OAuth registration.

Each Google email address has its own browser account and separately selected Gmail/Calendar sources. Browser account identities are not numeric `/u/0` slots, which can change when you sign in or out. Opening a saved source uses the account's email routing. API-connected and browser-connected accounts remain distinct.

To manually add an account, use **Settings > Connect your browser > Add account by link** and paste its Gmail or Google Calendar URL. **Open account page in default browser** opens only a safe inbox/calendar root, not the pasted message, event, draft or search. If your default browser differs from the paired Edge/Chrome profile, use the companion's **Add account by link** in that profile instead. Opening a URL does not connect an account: the companion must discover the actual signed-in identity from Google's top header. Source selection and AI sharing remain separate opt-ins.

The companion captures **loaded pages**: inbox previews, expanded conversation text, visible attachment metadata, and Calendar/meeting information. Pages must be visible unless background browser capture is explicitly enabled. Open the relevant account in Gmail or Calendar, select its sources in Relay Desk, then use the companion's capture action. Loaded pages can refresh automatically while open. This is not a full-history import or an invisible mailbox scraper. Calendar captures cover loaded event chips, agenda entries and opened details, not an entire calendar history. Time labels are retained as displayed rather than invented as precise timestamps.

Background browser capture remains read-only. A separate, explicitly confirmed **Move meeting in Google Calendar** action can reschedule a supported single event through the paired browser's visible editor, without a Calendar API registration. It checks the account, event identity, date, time zone and reviewed fields before saving. Unsupported or recurring edits stop for review; guest-confirmation dialogs require the user, and uncertain outcomes are never silently retried. See [browser calendar actions](docs/browser-calendar-actions.md).

When the exact same Gmail address also has an authorized API connection, **Save & open in Gmail** saves your reviewed reply as a native draft and opens Gmail Drafts in one click; it never sends. Other browser accounts retain local drafts until that mailbox is authorized for native writes. Broader calendar writes use optional APIs. Automatic browser Gmail attachment downloads use exact native attachment links and the companion's Downloads permission, temporarily staging files under Windows Downloads before encrypted import and cleanup. They do not need Google API credentials. Browser mode does not read passwords or extract cookies. Captured data goes to the encrypted local archive, not automatically to Copilot.

## Refresh, tasks and focus reports

**Calendar** combines selected browser and API calendars in a date-grouped agenda, with a week overview, account/calendar labels, search, past-event controls and per-calendar filters. Browser event summaries are separated into readable titles and displayed times; the original captured label and full description remain available under **Event details**. Entries without a reliable date stay in **Date not confirmed**, rather than being assigned to today.

Local calendar insights flag exact timed-event conflicts, possible same-account browser overlaps, title-based important-event suggestions and days with five or more visible entries. Browser times without a verified time zone are never presented as confirmed conflicts. Importance is a transparent keyword suggestion, not an AI judgment; busy-day counts are not confirmed occupied hours. All-day entries do not automatically block the working day. Chat can also inspect calendar insights, but only for sources whose accounts have separately enabled AI sharing.

Use the top-bar **Refresh workspace** button, inbox **Refresh inboxes**, or Settings **Refresh now** to refresh selected channels. **Refresh interval** supports manual-only, 30 seconds, one minute, five minutes, fifteen minutes or one hour. Global pause still applies. Enable **Refresh selected browser pages in the background** to keep importing loaded content while Relay Desk is in front; this opt-in is off by default. Without it, the Google page must remain visible. Browser sleep/unloaded pages can still delay capture, and a refresh request is not reported as a completed browser capture.

The unified inbox has explicit inbox buttons and filters labeled with email address, provider, and browser/API connection. Conversations are ordered newest-first by their latest original mailbox date, never by download or capture time. Existing Gmail dates are recovered from captured absolute header/tooltips; unsupported or ambiguous dates remain unknown and sort last. Selection and saved drafts do not change a conversation's date or position. Each inbox shows its own separate capture/sync time. Retained archived messages are not silently deleted when they disappear from a partial browser view.

Use the companion's **Discover signed-in Google accounts** to include other Gmail accounts in the paired browser profile, even when they do not already have an inbox tab open. This optional feature requests access to Google's account-menu widget on `ogs.google.com`, reads its displayed account-switch links, and opens inbox views whose actual Google headers must verify each identity. It does not read passwords or cookies, call private Google account APIs, or treat an expired session as connected. Each browser profile needs its own pairing.

**Discover open Google accounts** remains available without optional account-menu access and reconciles already-loaded Gmail/Calendar tabs. Each newly discovered account still needs source selection and separate AI consent. Hidden tabs are metadata-only unless background browser refresh is enabled. Settings shows browser-client type and last contact as reported by authenticated requests.

**Tasks & focus** combines automatically derived email action suggestions with manual tasks. Edit titles, notes, priorities, due dates and status; manual work remains available offline. The live focus summary ranks next actions and shows workload, overdue/due-soon items, waiting work, upcoming imported meetings and incomplete browser coverage. **Generate focus report** adds a cited Copilot narrative using the currently selected model and permitted email evidence, within the existing daily AI budget.

**Review all local email**, available on Today and Tasks & focus, reviews every currently eligible email already in the local archive, including older/read messages beyond the 500-message inbox snapshot. It does not fetch unloaded provider mail: browser evidence is limited to captured loaded-page previews or opened text. Attachment contents are not included in this scan; importing a user-downloaded attachment copy is a separate local extraction action. Selected mail sources and explicit per-account AI consent are required, and starting review never enables additional accounts.

Choose 1, 5, 10 or 20 sequential batches per start. Each batch submits at most four text segments through the current user-selected Copilot model and existing daily attempted-run budget. Long emails are split without dropping their remaining text. Reviewed segments, batch reports and coverage persist locally across pause, cancellation and restart; resume skips saved segments, while new or changed evidence needs review again. Budget exhaustion, failures and batch limits leave the review visibly partial, not complete. The panel distinguishes eligible, reviewed, remaining, excluded, failed and preview-only coverage. Pause/cancel discards an in-flight result but cannot refund an already attempted AI call. Exact-source-quoted suggestions become editable local tasks/actions, preserve manual edits and completion, and never send mail or schedule calendar events. Batch reports cover only their reviewed evidence; dashboard task metrics combine currently visible tasks.

Choose **Schedule** on a task, review its calendar, time zone, start/end and reminder, then confirm the focus block. **Save calendar block** creates or updates the event directly through the authorized Google/Microsoft calendar connection, with no attendees. The calendar's existing visibility and sharing rules still apply. Choosing an unselected calendar also enables that calendar source. The default reminder is 15 minutes; provider notification permissions still determine how it appears. Task edits mark existing calendar details out of date until you explicitly reschedule. Inferred email dates alone never create events, and uncertain writes are not automatically retried.

**This is a personal-development release, not a production-certified or publicly verified integration.** Sample data works without provider accounts. Browser mode uses your own signed-in Google accounts; optional API connectors require provider registration/approval. Copilot authentication and model entitlement must be checked on your machine; there is no bundled account or separate AI-provider API key.

## Safety boundaries

- Drafts are stored and edited locally; generation uses Copilot's cloud service after AI consent. **Save draft** is a separate, explicit action that writes a Gmail/Outlook draft. Send it in the original mail application. Relay Desk has no send command.
- Slack replies are copy/paste only; the app does not post to Slack.
- Calendar writes require an exact preview and a single-use approval. Attendees may receive invitations or updates. There is no event-delete or meeting-response automation.
- Archiving means making a local copy, not moving, deleting or marking provider messages as archived.
- AI requires separate account consent. Relevant excerpts then leave your computer for Copilot; local-first does **not** mean offline AI.
- Selected sources and provider permissions limit history. Deleted/expired/unavailable history cannot be recovered. No connector can bypass workplace retention rules.

Read [privacy and permissions](docs/privacy-and-permissions.md) before connecting workplace accounts. The [provider registration guide](docs/provider-setup.md) covers Gmail API setup; the [browser setup guide](docs/browser-mode.md) covers the companion and browser-only channels.

## Windows setup

Use **official Windows x64 Node.js 24** satisfying `^24.13.0`, plus npm. The MSYS Node installation tested during development crashes when loading the SDK's native Koffi binding; matching the Node version number alone is not sufficient. Use a terminal in this project:

```powershell
npm install
npm run doctor
npm run typecheck
npm test
npm start
```

`npm run doctor` checks local native dependencies, not account authentication. The official Node runtime and SQLCipher native binding have been exercised in development. Packaged coverage includes startup, encrypted-vault sample/search, signed-in Copilot model discovery, and synthetic multi-account browser capture/persistence. The real unpacked extension has also exercised the HTTP bridge in an isolated fixture browser. These checks do not establish live Gmail/Calendar DOM compatibility, generated responses or optional OCR/media models.

The application pins Electron **42.11.6** with `better-sqlite3-multiple-ciphers` **12.11.1**. This maintained Electron release has the required Windows ABI-146 cipher prebuild. Electron 44 uses ABI 149, for which this cipher release has no prebuild; the development machine has no MSVC toolchain. Do not independently upgrade Electron and assume native compatibility.

Electron and Node use different native-module ABIs. Forge may rebuild the database module for Electron; subsequent Node-based storage tests can then report an ABI mismatch. Close the app and run `npm rebuild better-sqlite3-multiple-ciphers` with official Node before Node tests. Do not rebuild while another instance is using the shared installation.

### Development commands

| Command | Purpose |
| --- | --- |
| `npm start` | Launch the Electron development application. |
| `npm test` | Run Vitest tests; account calls are mocked in service integration tests. |
| `npm run test:ci` | Run the whole suite in memory-safe batches (used by CI). |
| `npm test -- tests\service.test.ts` | Run the orchestration safety tests only. |
| `npm run typecheck` | Check TypeScript without emitting files. |
| `npm run build` | Build the renderer only; not a complete desktop package. |
| `npm run package` | Create an unpackaged desktop distribution under `out`. |
| `npm run make` | Create the configured Windows ZIP artifact under `out\make`. |
| `npm run test:e2e` | Run the configured Playwright desktop smoke tests. |
| `npm run doctor` | Check local native runtime prerequisites. |

Packaging is not an installer-signing, update, notarization or provider-verification service. No signed installer or automatic updater is configured.

Windows ZIP creation uses the built-in `%SystemRoot%\System32\tar.exe` (libarchive), avoiding the legacy PowerShell ZIP tool's long-path limit. The portable build is `out\Relay Desk-win32-x64\RelayDesk.exe`; keep its neighboring files together. The ZIP is written under `out\make\zip\win32\x64`.

## First use

1. Load the synthetic sample workspace to inspect the interface without accessing an account. It includes a labeled synthetic local draft for exploring the editor without AI login. Sample attachments are metadata, not real downloadable files; sample drafts cannot be saved to a real mailbox.
2. Review your organization's local-archival and AI-disclosure rules. For Google, use Settings **Connect your browser** and follow the companion installation/pairing steps. No Google Cloud registration is required.
3. Open each signed-in Google account's Gmail or Calendar tab and select its discovered sources. Account identity follows the email address, not its numeric browser slot. Connections do not grant blanket AI consent.
4. Capture loaded browser pages, then review inbox previews, opened message bodies and displayed meetings. For broader history, native drafts, Microsoft or Slack, use the optional API connection section with your own registration/authorized credentials and sync selected sources.
5. Install/use the supported GitHub Copilot CLI. Run `copilot`, enter `/login`, and complete sign-in. In Relay Desk, connect Copilot and explicitly select a model from the live entitled inventory.
6. Enable AI for the relevant account only after reviewing the disclosure notice. Background AI is a separate opt-in; the default local daily budget is 20 attempted runs. Failed requests can consume this local budget, and it does not replace GitHub's own allowance or billing rules.
7. Review generated text, recipients and citations. Use **Save & open in Gmail** for an API-authorized mailbox, including verified same-email browser replies. Other browser and Slack replies can be copied into the original site. Sending always happens in the original provider.

**CLI signed in but app says sign in:** use the current `out\Relay Desk-win32-x64\RelayDesk.exe` build. The original adapter used SDK `mode: "empty"`, which disables the Windows credential store even with `useLoggedInUser: true`. The adapter now uses `mode: "copilot-cli"` for credential discovery while explicitly retaining session isolation. It does not read/copy stored credentials or fall back to a token/API-key provider. Quit an older app through its tray menu before launching the updated executable and clicking Connect. Older side-by-side builds share the same application-data directory but do not include the browser-first update.

## Archive, attachments and calendars

The archive uses SQLCipher, encrypted attachment blobs and a Windows-protected archive key. Default application data is Electron's `userData` directory, normally `%APPDATA%\relay-desk`; `RELAY_DATA_DIR` can explicitly override it. Preserve `archive-key.dpapi` with the installation's protected user profile. Backups require the **same archive key** and are not portable password-protected exports. They cannot recover the archive after that key/profile is lost.

Keyword retrieval is local. Optional semantic retrieval uses `Xenova/multilingual-e5-small` on the local CPU; enabling it can download model files to the local cache. The resolved immutable model revision is persisted, but this is not independent artifact-signature verification: see the limitations below. Reindex after enabling/changing the local model.

Attachment metadata is visible even when extraction is unavailable. Supported processing paths include TXT/CSV, PDF, DOCX, XLSX, PPTX, common raster images, ZIP and audio/video audio tracks. An approval gate applies above 25 MiB (or a lower configured threshold), for unknown sizes, and for OCR/archive/media work. Approval does not override parser/resource limits. Processing may report `partial`, `blocked`, `unsupported`, `encrypted`, `failed` or `cancelled`; those are not successful full-content indexing.

OCR/media are optional local capabilities, **not bundled turn-key transcription**. They need trusted local models; media also needs explicitly configured ffmpeg and whisper.cpp executables. No automatic OCR/transcription-model downloader is provided. See [attachment support](docs/attachment-support.md) for format/resource limits and full setup, or [architecture](docs/architecture.md#optional-local-models-and-media) for the local manifest and configuration.

Calendar previews show the chosen calendar, time zone, attendees and invitation effects. Approvals expire after 15 minutes. Changed events require a fresh proposal; recurring-event editing remains in the provider. After a network failure, inspect the provider before retrying an uncertain write.

Closing the window can leave Relay Desk in the tray. Quit stops it. Start-at-login is optional. Sync and automation do not run when the app is quit, the machine sleeps or Windows is off.

## Current scope and release gaps

This implementation covers the application's orchestration, connectors, archive, retrieval, attachment pipeline and UI. It is **not evidence that every external integration has passed a live end-to-end release gate**.

- Real Gmail/Microsoft/Slack access, tenant/workspace approval, OAuth registration details and Copilot login remain user/environment prerequisites. Synthetic tests are not substitutes for those acceptance tests.
- Backfill is provider- and scope-dependent. The inbox snapshot is bounded to the newest 500 messages; a local archive may contain more than the UI snapshot.
- Microsoft calendar refresh covers a rolling window from 365 days ago through 730 days ahead, not unlimited calendar history. Gmail draft updates compare the current remote draft before saving, but do not have documented atomic compare-and-swap protection; avoid simultaneous editing in Gmail and Relay Desk.
- Semantic model installation uses Transformers' cache/download mechanism with a persisted immutable revision. Independent artifact verification and accurate pre-download size/disk checks are not yet implemented.
- OCR/media need separately supplied verified models/tools. Scanned PDF OCR also depends on a working local canvas renderer; missing native components produce a blocked/partial status. Video processing transcribes audio, not visual content.
- Safety budgets bound attachment extraction. All supplied extracted text is indexed in bounded batches without a per-document chunk-count cap, but large originals can be retained encrypted without every byte being extracted. Search citations cover selected indexed excerpts, not guaranteed exhaustive document understanding.
- Calendar agenda and reviewed create/update are present, but comprehensive free/busy and scheduling analysis is not a substitute for checking the provider. Recurring-series editing, deletion and automatic meeting responses are excluded.
- Automated background drafts currently use a bounded set of recent eligible messages, not a complete autonomous workflow engine. Manual review remains required.
- No public-distribution compliance audit, external penetration test, signed release, automatic updater or turnkey cross-machine key recovery is included.

For implementation boundaries and test meaning, see [architecture](docs/architecture.md). Provider scopes and sensitive-data handling are documented in [privacy and permissions](docs/privacy-and-permissions.md).
