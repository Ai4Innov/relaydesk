# Provider setup and operational boundaries

Relay Desk uses real provider REST APIs. Synthetic tests are not evidence of live
account approval. Each provider requires an authorized account, app registration,
consent and applicable employer/workspace approval. No credentials are extracted
from installed email or Slack clients. AI disclosure consent is separate.

## Google / Gmail

1. Create a Google Cloud project and enable Gmail API and Google Calendar API.
2. Configure the OAuth consent screen, audience, test users and applicable
   restricted-scope verification / Limited Use compliance. Personal/internal use
   does not automatically waive all provider obligations.
3. Create an OAuth **Desktop app** registration. Enter its client ID in settings.
4. Google native registrations can also require the `client_secret` from the
   downloaded registration JSON during code exchange and refresh. Supply that
   value through the Google connection dialog's transient password field
   (`account.connect.token`), not ordinary Settings. The connector sends it only
   to Google's token endpoint and retains it only in the encrypted credential
   vault. A native registration value is not a confidential server-app secret:
   never ship a web application's confidential secret in the desktop executable.
   An ID-only registration that rejects code exchange must not be reported as
   connected; supply the required native registration value and reconnect.
5. Connect. The system browser opens Google consent; a short-lived listener binds
   an ephemeral port on **127.0.0.1**, `/oauth/callback`, for the authorization
   response. PKCE S256 and random state are verified; login expires in 3 minutes.
6. Explicitly select labels and calendars. All discovered sources start
   **unselected**, even though OAuth permissions are broader.

### Apps Script relay alternative

If you run the supplied Gmail-to-Drive Apps Script relay instead of OAuth for a
mailbox, deploy it as **Deploy → New deployment → Web app** with **Execute as:
Me** and **Who has access: Anyone**. Run `rotateRelayToken()` in Apps Script and
paste the generated token plus the stable web app URL into **Settings → Gmail via
Apps Script relay**. After script edits, use **Manage deployments → Edit → New
version** so the URL remains unchanged.

Relay Desk binds the relay to the mailbox returned by the relay status call and
stops importing if that mailbox ever changes. Only HTTPS `script.google.com`
web app URLs are accepted; Apps Script redirects are followed only to
`script.google.com` or `script.googleusercontent.com`. The token is stored only
in the encrypted local credential store and is never shown back to the renderer.
Rotate tokens at least every 90 days; the previous token keeps working for 24
hours after rotation. Use `revokeRelayAccess()` to revoke access.

The relay source is still a normal selected mail source: local archival requires
account consent and source selection, while Copilot use requires the same
per-mailbox AI opt-in as other Gmail routes. Attachments downloaded through the
relay enter the same encrypted attachment approval, extraction and local-RAG
pipeline as API attachments.

Select **Inbox** to make this API connection the preferred reader for the same
mailbox's existing unified browser inbox. Each Gmail account needs its own normal
OAuth grant; authorizing one address does not authorize another. API-derived full
messages and attachments retain the API account's source and consent boundaries.
Enable Copilot separately on both account records if you want those copies used
for AI. No separate AI-provider API key is required.

For Gmail accounts with no API connection, the Settings **Gmail API first,
Playwright fallback** card opens a dedicated visible browser for normal sign-in.
Chrome must be installed, or Edge when Chrome is absent. No bundled browser
download or personal-profile cookie migration occurs. The managed profile persists
browser session data separately from the encrypted mail archive. Closing it with
the card's control pauses automatic browser fallback. Unsupported/clipped full
reads remain explicit failures; configure the API for reliable attachment access.

### Google rejects sign-in in the managed browser

"This browser or app may not be secure" can be Google's rejection of a
software-controlled browser, not an incorrect password. Relay Desk detects this
message on Google's sign-in page and pauses the Playwright fallback. Do not
disable browser protections, import cookies, or disguise automation to get past it.

Use **Connect Gmail** in Relay Desk's API connection form. The official OAuth
consent flow opens in your normal system browser, not the managed Playwright
window. Connect each required mailbox and select **Inbox** for that API account.
If that account is already connected, source selection may be the only missing
step. The companion in a normal browser can still capture loaded pages without
API setup, but full-email and attachment retrieval there remains limited.

See Google's [supported-browser sign-in guidance](https://support.google.com/accounts/answer/7675428).

### Browser authorization succeeded but no account appears

The browser callback only acknowledges receipt of Google's authorization code.
Relay Desk must still exchange it for credentials, read the Gmail profile, and
discover Gmail labels and Google calendars before saving the account. Older
builds incorrectly displayed "Connected" before those steps completed.

In the updated build, Settings displays the latest connection status and error;
the failed `Connect gmail` job also remains in Activity. An OAuth 400 error can
mean that the Google desktop client secret is missing or does not match the
client ID. Use the values from the same downloaded **Desktop app** registration
JSON, save the client ID first, then enter the registration secret and connect
again. Do not reuse the callback URL or post it or the secret in support messages.

A Gmail API or Google Calendar API 403 error means that API access was denied.
Check that **both APIs** are enabled in the project owning the OAuth client,
that the requested permissions were granted, and that Workspace administrator
policy allows the application. Calendar discovery is currently required for a
complete Google connection; a failed discovery does not create a partial account.
The authorization code alone is not evidence that either API is accessible.

If switching builds, save edits and choose **Quit** from Relay Desk's tray menu
before launching the updated executable. Closing the window can leave an older
build running; the single-instance lock then redirects new launches to that build.

Requested scopes:

* `https://www.googleapis.com/auth/gmail.readonly`
* `https://www.googleapis.com/auth/gmail.compose`
* `https://www.googleapis.com/auth/calendar.calendarlist.readonly`
* `https://www.googleapis.com/auth/calendar.events`

**Important:** `gmail.compose` permits sending in Google's authorization model.
Relay Desk does not expose or call send routes. It creates/updates native drafts
only through explicit Save draft. The no-send policy is application-enforced,
not a false promise that this scope cannot send.

Gmail sync fully paginates selected-label historical messages, then consumes
history IDs and paginated changes. The initial history watermark is captured
before backfill to avoid a gap. Expired history cursors schedule a fresh import
through the atomic page callback; retry the visible failed sync job. History
deleted records mark archived messages deleted rather than removing evidence.
Label selection is enforced while fetching content. A message belonging to
multiple selected labels has one account-scoped message identity and the most
recently synchronized selected source mapping (the shared model has only one
`sourceId`).

If the same mailbox is also paired through browser mode, Relay Desk can reuse
that authorized Gmail API account to verify a specifically selected
browser-captured conversation and save a Gmail draft **without enabling API
history sync for that mailbox**. The browser capture remains the authoritative
selection boundary, but Relay Desk does not trust browser thread/message IDs on
their own: it resolves them against the same-email Gmail API account, verifies
the matched remote context, then reuses the ordinary Gmail draft conflict and
idempotency protections. Without that exact same-email API authorization,
browser drafts remain local and the UI explains that optional Gmail
authorization is required for native save.

Native reply drafts use UTF-8 MIME, the original thread, `In-Reply-To` and
`References` when the provider supplies them. The original message revision and
full native draft snapshot are compared immediately before a draft update.
**Gmail's documented draft update API does not provide an atomic compare-and-swap
precondition:** an external editor racing between comparison and PUT can still
win or be overwritten. Avoid simultaneous editing in both apps. No atomic
conflict-proof guarantee is claimed.

Google calendars use paginated events with recurring expansion and incremental
sync tokens. Invalidated tokens cause a visible full-refresh retry. Recurring
events can be read but **cannot be edited** through this release. Open Google
Calendar to change an occurrence or series.

## Microsoft / Outlook

1. Register a Microsoft Entra application with the intended supported account
   type: personal Microsoft accounts, organizational accounts, or both.
2. Configure it as a mobile/desktop **public client** with HTTP loopback redirect
   support. Register `http://127.0.0.1/oauth/callback` using a provider-supported
   loopback configuration (the native app uses an ephemeral port). Some portal
   workflows require editing the public-client redirect URI list in the manifest.
   Do not use a confidential web application or embed a client secret.
3. Set client ID and tenant (`common`, `organizations`, `consumers`, or the
   authorized tenant identifier) in Settings.
4. Grant delegated `User.Read`, `Mail.ReadWrite`, `Calendars.ReadWrite` and
   `offline_access`, including administrator approval where required.
   **`Mail.Send` is not requested.**
5. Connect in the system browser and explicitly select folders/calendars.

The adapter requests immutable Outlook IDs, enumerates nested folders and
paginated calendars, and uses per-selected-folder message delta links for
historical and incremental sync. Continuation/delta URLs must remain on the exact
`https://graph.microsoft.com/v1.0/` origin/path boundary; redirects are refused.
Expired deltas trigger a visible full-refresh retry. Delta removals mark source
records deleted; immutable message identities preserve references across moves.

Draft creation uses `createReplyAll` with the reviewed subject, body and recipients,
not `reply`, `replyAll` or `send`. Known drafts are checked for `isDraft`, original
conversation and exact native revision before conditional `PATCH` (`If-Match`).

Selected calendars are read through fully paginated `calendarView`, including
expanded occurrences. **Coverage is a rolling 365 days in the past and 730 days
in the future.** Arbitrary selected-calendar delta is not implemented: Graph
v1.0's calendarView delta availability differs from arbitrary calendar routes.
Each sync reconciles this window; continuation pages and observed event IDs are
durable, including across interrupted snapshots. A completed empty snapshot
explicitly tombstones previously archived events in the covered window. Legacy
continuations without observed IDs defer missing-event inference until the next
complete snapshot. Mail is not subject to this calendar coverage limit.

Calendar writes preserve IANA time zones, exclusive all-day end dates and
offset-qualified timed instants. Tenant/provider rejection of an IANA zone is
surfaced, never silently replaced with a different requested zone. Recurring
occurrence/series edits are explicitly unsupported and must be done in Outlook.

## Slack (workspace-owned internal application)

Slack is not treated as a generic public-desktop PKCE provider. No hosted OAuth
broker, Slack client scraping, bot posting or Socket Mode is used.

1. Create a workspace-owned internal Slack app and obtain workspace approval.
2. Add these **User Token Scopes**, then install/reinstall the app:
   `channels:read`, `channels:history`, `groups:read`, `groups:history`,
   `im:read`, `im:history`, `mpim:read`, `mpim:history`, `users:read`, `files:read`.
3. Import the authorized `xoxp-...` user token in the connection dialog.
   The adapter checks `auth.test`, verifies the response's `x-oauth-scopes`,
   and rejects bot identities or missing scopes. Tokens are stored only in the
   encrypted credential vault. `chat:write` is neither requested nor required.
4. Select the conversations the user is authorized to archive.

Initial history is fully paginated. Subsequent syncs overlap recent history by
24 hours; a complete history rescan is scheduled daily. Every archived thread is
revisited, including old parents, so new replies and edits on old conversations
are not lost merely because a history watermark advanced. Replies are fully
paginated; missing accessible replies are marked deleted. A crashed thread pass
may repeat reads, but the checkpoint is never advanced past an incomplete pass.
This correctness-first polling can be expensive in large workspaces. Workspace
retention, API access and rate limits constrain availability; no expired history
recovery or real-time-event guarantee is made.

Slack replies remain local drafts for **Copy / Open thread**. The adapter has no
Slack post method. Internal private-file URLs are obtained with `files.info` and
must use the exact HTTPS `files.slack.com` host. Redirects and external Drive /
OneDrive links are refused rather than forwarding Slack credentials. Slack
token rotation is not implemented: replace an expired/revoked token by reconnecting.

## Writes, retries, cancellations and credentials

### Scheduling and backfill responsiveness

Sync invocations are **not bounded by a total page count or wall-clock budget**.
The hub processes selected sources sequentially; each provider completes the
current historical pagination before advancing to the next selected source.
The parent serializes sync jobs per account. Consequently, a large backfill or
Slack thread reconciliation can delay newer-mail refreshes and later sources.
Bounded HTTP retries/timeouts do not imply bounded overall job duration.

Every completed provider page awaits the parent's durable checkpoint callback.
Cancellation is checked before requests, between sources, and before committing
pages; retry resumes the saved continuation rather than restarting committed
backfill pages. Slack's interrupted thread pass can repeat reads. Gmail captures
a history watermark before backfill and catches up afterward; Graph reaches its
incremental delta link after the initial folder enumeration completes. These
protect eventual completeness, **not prioritized real-time delivery during
backfill**. No separate live-change lane or provider page scheduling budget is
implemented. Large-account responsiveness requires that additional scheduler
work; do not present this release as fully real-time during an initial import.

### Transport and write safety

* Read retries are bounded (four total attempts) with exponential backoff,
  jitter, bounded `Retry-After` handling and cancellation. A server delay above
  60 seconds fails visibly instead of retrying too early or blocking forever.
  HTTP requests have a 60-second timeout; OAuth token exchange has 30 seconds.
* Non-idempotent mutations are never automatically retried. Durable vault write
  markers survive ambiguous network errors and application crashes. An uncertain
  operation remains blocked until reconciled; inspect the native provider before
  proceeding. This release does **not** provide an automatic uncertain-write
  reconciliation/reset UI. Do not simply create another approval to bypass it.
* Google event creates use a deterministic provider event ID; Microsoft event
  creates use `transactionId`. Approval operation IDs and stored receipts are
  payload-bound. Exact event `expectedRevision` is fetched and compared before
  any update and is sent as `If-Match`. Recurrence writes are rejected.
* Event create/update can notify attendees. Google uses `sendUpdates=all`;
  Graph applies its native invitation/update behavior. These are real external
  communications requiring the parent's exact-payload approval UI, not silent
  email sending. No calendar deletion or meeting-response endpoint is exposed.
* Calendar cancellations currently use `(Cancelled)` titles and
  `writable:false`, because the shared event model lacks a deletion property.
  Cancelled records are retained in the archive. Consumers must not treat them
  as active editable appointments. Complete Google refreshes also tombstone
  previously archived selected-calendar events missing from the refreshed result;
  empty incremental pages do not imply deletion.
* Attachments are bound to the archived account/message/source before download.
  Google base64 attachment responses are decoded in memory (not streamed from
  JSON); Microsoft/Slack return streaming bodies. Size approval and extraction
  limits are enforced by the separate attachment service.
* Account and provider IDs are namespaced. Credential-bearing requests reject
  wrong-host URLs and HTTP redirects. No token or provider error body is logged.
  Disconnect deletes local credentials; it does **not** revoke an app grant at
  the provider. Revoke that grant through the provider's account security page.

## Integration API

`src/main/connectors/index.ts` exports `ConnectorHub(vault, openExternal,
options?)`. The optional third parameter accepts injected `fetch` and `login`
functions for deterministic tests. Normal application callers need only the
first two arguments.

Public methods: `connect(provider, settings, token?)`, `sync(account, sources,
onPage, signal?)`, `saveDraft(account, message, draft)`,
`downloadAttachment(account, attachment, signal?)`,
`writeEvent(account, source, change, operationId)`, and `disconnect(accountId)`.

`onPage` may return `void` or `Promise<void>` and is **awaited** before further
pages. The adapter only reads `checkpoints`; the parent atomically persists each
page and its optional `{id,value}` checkpoint and controls indexing backpressure.
The parent remains responsible for durable source selection, sync cancellation
when selection changes, exact calendar approval and explicit native draft saves.

Run deterministic coverage with `npm test -- tests\connectors.test.ts`.
Live Google/Microsoft/Slack authentication, tenant approval, provider revision
semantics and notifications still require an authorized real-account smoke test.
