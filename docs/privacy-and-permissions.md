# Privacy, consent and provider permissions

## Before connecting an account

Confirm you are authorized to retain communications locally and, separately, to disclose selected content to your selected AI provider (GitHub Copilot, OpenAI Codex or Anthropic Claude). Employer, tenant, workspace, provider and Copilot organization policies apply. Personal use or a small number of users does not automatically waive Google restricted-scope verification, Limited Use, Slack policies or workplace governance.

The application ships no Google/Microsoft registration, Slack workspace app, credentials or Copilot entitlement. Provider setup and administrator approval are external prerequisites. If approval is unavailable, leave that connector or its AI use disabled.

Follow the [provider setup guide](provider-setup.md) for registration, redirect configuration, checked scopes and provider-specific history/write limitations.

## What goes where

| Data or operation | Destination and boundary |
| --- | --- |
| Selected account history and attachment metadata | Local encrypted archive, obtained through authorized provider APIs or selected, loaded browser pages. Browser capture is not full-history access. |
| Downloaded attachment originals | Local authenticated encrypted blobs, from provider downloads, automatic native Gmail downloads, or explicitly imported copies; size and processing approval gates apply. Browser Gmail downloads temporarily create a plaintext file in a request-specific RelayDesk subfolder under Windows Downloads before verified encrypted import and cleanup. User-imported/exported copies are not deleted and retain normal local-file privacy protections. |
| Extracted text, full-text index and embeddings | Local encrypted database. Processing uses local parsers/models. |
| Relevant excerpts for an AI draft/question | The selected AI provider (GitHub Copilot, OpenAI via your Codex CLI sign-in, or the Anthropic API) after account AI opt-in; not the entire archive by default. Citations can include attachment text. |
| Native email draft | Gmail/Outlook only after an explicit Save draft action. |
| Calendar change | Selected provider calendar after exact approval; invitations/updates can notify attendees. |
| Slack response | Local draft and, on request, the system clipboard. Posting is done by the user outside Relay Desk. |
| WhatsApp Web | Only loaded messages in explicitly selected chats, after local-ingestion consent and verified own-profile phone identity. AI sharing is a separate opt-in; replies stay local for manual copy/send. |
| Internal document preview | Local PDF/image rendering or extracted text; no executable embedded content or remote document service. |
| Added folders and shared links | Read-only. Files are parsed locally and only the extracted text is stored in the encrypted archive. Shared links are fetched anonymously, with no cookies or account credentials, so only "Anyone with the link" content is reachable, and the link host sees the download requests. Excerpts go to the AI provider only while the source's AI switch is on. |
| Save to Downloads | Explicit export of a retained original through the native save dialog. The resulting ordinary file is outside the encrypted archive and is not erased when an account is forgotten. |
| Optional embedding-model files | Downloaded into a local model cache when semantic search is enabled. Model hosts can observe download requests; archive text is not uploaded to obtain the model. |
| OCR/transcription models and media tools | Supplied manually from trusted sources; no automatic download is implemented. |

Clipboard contents are outside the encrypted archive and can be visible to clipboard history or other applications. Provider links open the default browser, where browser/provider privacy rules apply. Desktop notifications use generic wording instead of message bodies.

AI usage, retention, entitlement and organization policy depend on your actual Copilot, ChatGPT or Anthropic account and settings. This project does not promise zero remote retention or unlimited model access. The local attempted-run budget is an additional control, not a billing guarantee.

## AI providers

- **GitHub Copilot** uses the Copilot CLI sign-in through the official SDK, in an isolated in-memory session with built-in tools disabled.
- **OpenAI Codex** uses your installed Codex CLI and its own `codex login`. Relay Desk removes `OPENAI_API_KEY`/`CODEX_API_KEY` from its environment, and runs each request with `--ephemeral` (no session files), `--ignore-user-config`, `--ignore-rules`, a read-only sandbox in an empty scratch folder, and Codex's shell, web search, plugins, apps, memories and image tools disabled. Relay Desk's tools are exposed only through a 127.0.0.1 MCP endpoint that requires a random per-request bearer token and rejects browser origins.
- **Claude** uses the Anthropic Messages API with your API key. The key is stored in the encrypted archive, never returned to the UI, and only sent to `api.anthropic.com`; ambient `ANTHROPIC_*` environment variables are ignored.
- Account AI consent applies to whichever provider is selected. Switching provider changes which company receives future excerpts; review that provider's data-use terms first.

## Provider scopes are broader than app actions

### Google

The adapter requests:

- `gmail.readonly` for mail/history.
- `gmail.compose` for native drafts.
- `calendar.calendarlist.readonly` for calendar discovery.
- `calendar.events` for calendar reads/writes.

**There is no Gmail OAuth draft-only scope. `gmail.compose` also permits sending.** Relay Desk's no-send rule is enforced by the application command/adapters, not by claiming Google forbids sending with that grant. Calendar write scopes can similarly permit actions that the app does not expose, such as deletion.

Configure an authorized Google desktop/public-client registration and consent screen with the necessary APIs/scopes. The current implementation uses PKCE and a loopback callback. Your registration/organization may impose additional conditions; a client ID alone does not prove the deployed flow is accepted or approved for restricted scopes. No confidential client secret should be embedded in a distributed desktop build.

If Google requires the native desktop registration's client secret, the adapter accepts a user-supplied registration credential, sends it only to Google's token endpoint, and stores refresh credentials inside the encrypted vault. This is a provider-registration requirement, not an AI API key or a claim that a desktop executable can keep a distributed secret confidential.

### Microsoft

The delegated scope list is `offline_access`, `User.Read`, `Mail.ReadWrite` and `Calendars.ReadWrite`. **`Mail.Send` is not requested.** Register an appropriate public-client application/redirect configuration in the correct tenant and obtain any required admin consent.

`Mail.ReadWrite` and calendar scopes are broader than the local draft/review controls. The app does not offer mailbox cleanup, automatic sends, event deletion or meeting-response automation merely because a token could support other operations.

### Slack

Use an authorized workspace-owned internal Slack app and import its authorized `xoxp-` user token through account setup. The current adapter checks the full read-scope list: `channels:read`, `channels:history`, `groups:read`, `groups:history`, `im:read`, `im:history`, `mpim:read`, `mpim:history`, `users:read` and `files:read`. These cover public/private channels, direct/group conversations, user identity and files; do not imply that selecting one channel narrows the grant. Do not grant posting scopes for this app's copy/paste workflow. The adapter rejects bot tokens and incomplete checked scope sets.

Tokens are not read from the Slack desktop client or browser cookies. There is no hosted Slack OAuth broker, generic confidential-secret desktop OAuth workaround, or Slack message-posting feature. Workspace membership, channel access, retention and rate limits constrain history; “all history” cannot include messages the authenticated user cannot access.

## Local controls and their limits

Connecting requires archive-access consent. With **Full access by default** (on unless you turn it off in Settings → AI & assistant), a newly connected account is also shared with AI and all of its discovered folders/channels/calendars are selected; turn the setting off to make AI and source selection explicit per-account actions. Per-account **Allow AI** and source toggles always win, and WhatsApp chats stay opt-in. Scopes may cover more data than selected sources; source selection is an application policy, not a narrower provider token.

Disabling a source excludes it from ingestion/retrieval/AI; it is not a command to erase provider data or necessarily delete retained local records. Disconnecting disables local use of the account and removes connector credentials. Forgetting additionally removes account-derived local data. These actions cannot retract excerpts already sent to Copilot or data copied to the clipboard. Independently revoke provider authorization in the provider's account/workspace settings when needed.

The UI can show retained local messages even when an account is disconnected. Exclusion from active retrieval is not a promise of an immediate secure wipe. Backups and filesystem/OS backups may still contain older encrypted copies; remove unwanted backups separately. Secure physical deletion on SSDs cannot be guaranteed.

Synchronization can be paused. Background AI (capped by the local daily budget) and background browser refresh are on by default. **Approve automatically** (Activity & approvals) is also on: attachment downloads/processing above the size threshold or of unknown size, and calendar changes with no attendees, proceed without a separate click, while size, parser and sandbox limits still apply and changes that notify attendees still wait for approval; start-at-login is off by default. Closing to tray is on by default; use Quit to stop the application. A revoked permission cannot recall a request already in flight; the service rechecks authorization before accepting generated output and writing drafts.

## Storage and recovery

Database contents, derived indexes, provider credentials and attachment originals are encrypted locally. The operating system protects the archive key through Electron `safeStorage`: DPAPI on Windows, Keychain on macOS and Secret Service (GNOME Keyring/KWallet) on Linux. This protects data at rest, **not** against malware running as your logged-in user, screen capture, process-memory access or a compromised operating system.

Backup files are encrypted with this archive's key and require that same key to restore. The key file (`archive-key.dpapi` or `archive-key.safestorage`) is tied to the OS user's protection; copying only a backup to a new machine/user profile is not a supported recovery procedure. Keep appropriately protected system/profile backups and test your recovery process. No cloud backup, password recovery or automatic cross-machine key export is provided.

Restoring replaces the local archive. Sync/background AI are paused afterward, and restored approvals cannot be replayed. Review account access/source selections and provider state before resuming; a backup does not roll back actions already performed in a mailbox/calendar.

## Model and attachment consent

Above-threshold or unknown-size files require approval before download, and OCR/archive/media work requires explicit processing approval. The default maximum automatic threshold is 25 MiB; lowering the setting makes it stricter. Approval does not permit scripts/macros to execute or remove resource constraints.

Optional semantic search can download its model when enabled. The cache-based path resolves and persists an immutable remote revision, but **does not independently verify artifact signatures/hashes or provide accurate pre-download size/disk checks**. OCR/media are different: their local model manifest requires hashes and no silent automatic downloads occur. Review licenses, expected size, disk/RAM needs and provenance yourself until those model-installation release gaps are resolved.

Unsupported, encrypted, unsafe, incomplete or oversized-to-extract material is visibly marked. “Indexed” describes extracted/indexed content, not a guarantee that every attachment page, character, audio segment or visual fact was understood.

## Non-goals

No autonomous email sending, Slack posting, mailbox cleanup, account-permission bypass, event deletion, meeting-response automation, remote shell agent or general-purpose file-access agent is exposed. AI model output is untrusted assistance and cannot itself approve provider writes.
