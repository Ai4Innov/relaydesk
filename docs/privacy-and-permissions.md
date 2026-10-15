# Privacy, consent and provider permissions

## Before connecting an account

Confirm you are authorized to retain communications locally and, separately, to disclose selected content to GitHub Copilot. Employer, tenant, workspace, provider and Copilot organization policies apply. Personal use or a small number of users does not automatically waive Google restricted-scope verification, Limited Use, Slack policies or workplace governance.

The application ships no Google/Microsoft registration, Slack workspace app, credentials or Copilot entitlement. Provider setup and administrator approval are external prerequisites. If approval is unavailable, leave that connector or its AI use disabled.

Follow the [provider setup guide](provider-setup.md) for registration, redirect configuration, checked scopes and provider-specific history/write limitations.

## What goes where

| Data or operation | Destination and boundary |
| --- | --- |
| Selected account history and attachment metadata | Local encrypted archive, obtained through authorized provider APIs or selected, loaded browser pages. Browser capture is not full-history access. |
| Downloaded attachment originals | Local authenticated encrypted blobs, from provider downloads, automatic native Gmail downloads, or explicitly imported copies; size and processing approval gates apply. Browser Gmail downloads temporarily create a plaintext file in a request-specific RelayDesk subfolder under Windows Downloads before verified encrypted import and cleanup. User-imported/exported copies are not deleted and retain normal local-file privacy protections. |
| Extracted text, full-text index and embeddings | Local encrypted database. Processing uses local parsers/models. |
| Relevant excerpts for an AI draft/question | GitHub Copilot service after account AI opt-in; not the entire archive by default. Citations can include attachment text. |
| Native email draft | Gmail/Outlook only after an explicit Save draft action. |
| Calendar change | Selected provider calendar after exact approval; invitations/updates can notify attendees. |
| Slack response | Local draft and, on request, the Windows clipboard. Posting is done by the user outside Relay Desk. |
| WhatsApp Web | Only loaded messages in explicitly selected chats, after local-ingestion consent and verified own-profile phone identity. AI sharing is a separate opt-in; replies stay local for manual copy/send. |
| Internal document preview | Local PDF/image rendering or extracted text; no executable embedded content or remote document service. |
| Save to Downloads | Explicit export of a retained original through the native save dialog. The resulting ordinary file is outside the encrypted archive and is not erased when an account is forgotten. |
| Optional embedding-model files | Downloaded into a local model cache when semantic search is enabled. Model hosts can observe download requests; archive text is not uploaded to obtain the model. |
| OCR/transcription models and media tools | Supplied manually from trusted sources; no automatic download is implemented. |

Clipboard contents are outside the encrypted archive and can be visible to clipboard history or other applications. Provider links open the default browser, where browser/provider privacy rules apply. Desktop notifications use generic wording instead of message bodies.

Copilot usage, retention, entitlement and organization policy depend on your actual subscription and settings. This project does not promise zero remote retention or unlimited model access. The local attempted-run budget is an additional control, not a billing guarantee.

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

Connecting requires archive-access consent. Enabling AI is a separate per-account action, while source selection determines which folders/channels/calendars are used. Scopes may cover more data than selected sources; source selection is an application policy, not a narrower provider token.

Disabling a source excludes it from ingestion/retrieval/AI; it is not a command to erase provider data or necessarily delete retained local records. Disconnecting disables local use of the account and removes connector credentials. Forgetting additionally removes account-derived local data. These actions cannot retract excerpts already sent to Copilot or data copied to the clipboard. Independently revoke provider authorization in the provider's account/workspace settings when needed.

The UI can show retained local messages even when an account is disconnected. Exclusion from active retrieval is not a promise of an immediate secure wipe. Backups and filesystem/OS backups may still contain older encrypted copies; remove unwanted backups separately. Secure physical deletion on SSDs cannot be guaranteed.

Synchronization can be paused. Background AI and start-at-login are off by default. Closing to tray is on by default; use Quit to stop the application. A revoked permission cannot recall a request already in flight; the service rechecks authorization before accepting generated output and writing drafts.

## Storage and recovery

Database contents, derived indexes, provider credentials and attachment originals are encrypted locally. Windows protects the archive key using Electron `safeStorage`. This protects data at rest, **not** against malware running as your logged-in Windows user, screen capture, process-memory access or a compromised operating system.

Backup files are encrypted with this archive's key and require that same key to restore. `archive-key.dpapi` is tied to Windows protection; copying only a backup to a new machine/user profile is not a supported recovery procedure. Keep appropriately protected system/profile backups and test your recovery process. No cloud backup, password recovery or automatic cross-machine key export is provided.

Restoring replaces the local archive. Sync/background AI are paused afterward, and restored approvals cannot be replayed. Review account access/source selections and provider state before resuming; a backup does not roll back actions already performed in a mailbox/calendar.

## Model and attachment consent

Above-threshold or unknown-size files require approval before download, and OCR/archive/media work requires explicit processing approval. The default maximum automatic threshold is 25 MiB; lowering the setting makes it stricter. Approval does not permit scripts/macros to execute or remove resource constraints.

Optional semantic search can download its model when enabled. The cache-based path resolves and persists an immutable remote revision, but **does not independently verify artifact signatures/hashes or provide accurate pre-download size/disk checks**. OCR/media are different: their local model manifest requires hashes and no silent automatic downloads occur. Review licenses, expected size, disk/RAM needs and provenance yourself until those model-installation release gaps are resolved.

Unsupported, encrypted, unsafe, incomplete or oversized-to-extract material is visibly marked. “Indexed” describes extracted/indexed content, not a guarantee that every attachment page, character, audio segment or visual fact was understood.

## Non-goals

No autonomous email sending, Slack posting, mailbox cleanup, account-permission bypass, event deletion, meeting-response automation, remote shell agent or general-purpose file-access agent is exposed. AI model output is untrusted assistance and cannot itself approve provider writes.
