# Chat agent

Chat uses a real `@github/copilot-sdk` agent session with the user's selected, entitled Copilot model and existing CLI subscription authentication. It is not an intent classifier or a simulated chatbot. No provider API key is needed.

Assistant answers support safe Markdown: headings, emphasis, lists, tables, quotations and code blocks. Message-supplied HTML, scripts, images and embedded content are not executed or loaded. Reviewed actions have visual field summaries alongside the complete stored payload, and provider outcomes distinguish verified completion from a browser step needing user attention or an uncertain save.

Named-event lookup searches all permitted captured calendar entries, not just the first page. A locally captured event can still be unavailable to Copilot when its account has not enabled AI sharing. Chat's Calendar access controls expose that distinction and require an explicit user opt-in; requesting a move does not silently enable sharing for the account's other selected sources.

## Available work

The agent can answer general questions and inspect:

- Selected mail sources from connected, consented, AI-enabled accounts.
- Recent messages with account/source filters and pagination, search excerpts, and explicitly paged message bodies.
- Optional inbox refresh and new/changed full-email downloads after the user chooses **Yes, download latest**, scoped to selected, AI-permitted mail sources. This pre-question prompt is off by default (answers use already-saved messages, kept current by background refresh); turn it on in **Settings → AI & assistant → AI usage → Ask to download latest mail before answering**.
- Already-indexed attachment text; chat cannot download or import a file.
- Permitted local tasks, API calendar events, and read-only browser calendar captures.
- Local calendar insights: exact conflicts, explicitly provisional browser overlaps, and title-based importance suggestions, using only AI-permitted calendars.
- A fully permitted existing focus report, eligible-message coverage, and workspace status.

Every personal-data tool filters account AI consent and source selection. The entire desktop snapshot is **never** sent to Copilot. Message/attachment citations show the evidence actually read, not just the subset the model chose to cite. Calendar/task/source reads also retain private dependency records for permission and revision checks.

## Choose whether to download before answering

When AI-permitted mail sources are selected, Chat asks **Do you want to download
latest messages before I answer?** before a question is submitted.
**Yes** authorizes downloads for that turn;
**No** answers using the current local archive immediately, including its newest
imported messages. Explicit wording such as "no need to refresh messages" skips
the prompt and enforces local-only reads. Missing IPC choices default to local.
Approval is never inherited from a previous turn. This choice does not change
separately configured background synchronization.

The main process enforces the choice for `refresh_inbox`, attention, recent-message,
archive-search and message-read tools. The model cannot override No. Skipping a
refresh is not an error and does not create an incomplete-refresh warning. Existing
turns retain their historical refresh outcomes.

The attention shortlist reserves space for the newest locally received conversations
and balances accounts before filling remaining slots by action signals. Each thread
occupies only one slot, represented by its newest evidence; many old replies cannot
crowd out today's messages. Newer previews remain visible alongside older full bodies.
Chat and the Inbox use the same receipt-date chronology, without treating capture time
as receipt time. AI consent, source selection and API-origin permissions still apply.

Gmail reads prefer the authorized API Inbox for the exact same mailbox, including
when the conversation is displayed under its existing browser account. Mailboxes
without API setup use the explicitly enabled Playwright fallback and its dedicated
signed-in profile. API authorization, policy, quota, and source-exclusion errors
are not silently bypassed. API-derived copies require both account records'
source/local permissions, and both AI consents before their excerpts reach Copilot.

An explicit **Settings > Gmail reading method > Direct browser** selection instead
routes browser inbox reads through the companion in the normally signed-in browser.
Chat refresh and full-thread downloads use that same choice. Switching methods
invalidates in-flight reads and transport-specific cache proofs, not source or AI
permissions. The managed Playwright login is not used in direct browser mode.

When the user chooses **Yes**, requests resolve the permitted account, then refresh
its inbox **before** reading evidence. This is an awaited read operation authorized
by that turn's choice. Recent-message, attention, archive-search and message reads
all honor that same choice, with no refresh when **No** is selected.
An actual refresh result includes per-source
status, confirmation time, downloaded conversations, remaining downloads and failure
reasons. A heartbeat or an arbitrary full-message capture is not an inbox-refresh
confirmation. Native Gmail refresh waits for refreshed rows, a loading cycle, or
a newly completed, uncached inbox-view response from Gmail's own browser request
while the page settles. Only response timing/status is observed; Relay Desk does
not issue private endpoint requests or inspect their payloads.

Chat shows a separate **Inbox freshness** disclosure based on app results, not on
the model's claims. An incomplete refresh adds a prominent warning to the answer;
cached findings must not be called a verified latest-inbox summary. Paused sync,
unavailable browsers, expired sign-ins, timeouts and incomplete body downloads
remain visible. Browser coverage is still the discovered inbox view, not invisible
mailbox history. Gmail may mark downloaded conversations read.

Browser refresh has a 150-second deadline and downloads at most 12 new/changed
conversations per pass. A larger backlog remains explicitly partial and continues
on subsequent refreshes; already verified, unchanged bodies are reused. Ordinary
reads may reuse a successful verification for 60 seconds, while an explicit
refresh checks the native inbox again. Manual-only refresh settings and pause
remain respected. Attachment downloads/indexing run separately and are not
included in the inbox freshness claim.

Refreshing never grants source or AI access, sends mail, or changes calendar events.
Writes still need reviewed confirmation. Already-stored refresh cards remain
compatible. New turns use the explicit pre-answer Yes/No choice instead.

The agent can propose these exact app commands:

| Proposal | After the user confirms its card |
| --- | --- |
| Create, edit, complete a task | Updates a local task; does not alter its calendar event |
| Generate a reply | Creates a local draft from selected archive evidence; never sends or saves it to a mailbox |
| Save a reviewed draft / Gmail handoff | Saves the exact displayed subject, full body and recipients as a mailbox draft; Gmail handoff also opens Gmail. Nothing is sent |
| Generate focus report | Uses the existing report workflow and AI budget |
| Start archive review | Starts the bounded existing review workflow; progress/pause/cancel remain in AI review |
| Propose calendar change | Creates a **separate Calendar approval**, not a provider write |
| Save a reviewed calendar approval | Writes the exact approval's displayed change/hash; invitation/update effects are explicitly shown |
| Schedule a task | Writes the exact displayed private event, time zone and reminder, with no attendees |
| Move a browser calendar meeting | Uses the paired companion's visible Google Calendar editor to reschedule the exact reviewed single event; no Calendar API registration is needed |

Payloads are validated and stored in the main process. The renderer only supplies conversation/turn/action IDs to confirm. Cards expose the exact stored JSON proposal, must wait until the active agent turn finishes, recheck evidence/target revisions, and execute at most once. Failed or interrupted cards are not automatically retried. The SDK's write tools **only prepare previews**; user `chat.confirm` is the authorization boundary for every write. Inbox refresh/download instead requires the pre-answer Yes choice. Provider writes reuse the existing draft and calendar approval workflows, with another exact-field/permission check immediately before the provider call.

Generation and execution can span turns: generate a local draft, confirm generation, then ask to save it; or create a calendar approval, confirm that preparation, then ask to approve the resulting change. Read tools expose permitted drafts and pending approvals; completed cards retain their draft/approval/task/event identifiers for follow-up requests. Task scheduling requires a selected authorized API calendar and never silently enables a source.

Native browser Gmail saving requires the same mailbox's connected, AI-enabled Gmail API account and a selected API mail source. Without that authorization, a browser-only account can generate local drafts but **cannot** save them natively from chat. Browser calendar rescheduling uses its separate reviewed companion workflow; broader browser calendar mutations remain unavailable. Slack replies cannot be saved or sent. Uncertain/stale drafts, unverified event revisions, and previews over 16,000 characters are refused; inspect the existing dedicated review screen instead. Chat does not send mail, even after confirmation.

For a browser move, the main process binds the captured event revision, exact account, requested date/start/end and explicit IANA time zone. The agent receives the device time zone and current local date for interpreting requests such as "today, 3-4pm"; these assumptions remain visible in the card. The model cannot submit a Save directly. The companion must verify the live editor and request a one-shot pre-save authorization, which rechecks consent and event revision. "Needs browser review" and "Save not verified" are not completed actions and do not offer automatic retry. Account AI sharing is still required for Copilot to inspect the meeting.

There is no model-accessible generic command executor, shell, filesystem, web search, MCP server, plugin, autonomous message sending, settings mutation, account connection, consent change, deletion, or secret access.

## Privacy and lifecycle

Conversation transcripts and action payloads persist only in the existing encrypted vault's `checkpoints/chat:v1` record. SDK sessions use the existing in-memory filesystem and disable session telemetry/store, external tools, instruction/config discovery, skills, plugins, file hooks and host Git operations.

An active request checks source eligibility before/after every tool and after the model response. Permission changes cancel its own session; cancellation never calls the archive review's cancellation controller. If any previously used source becomes unavailable or loses permission, the affected conversation's text, citations, action previews and executable payloads are removed from the live encrypted checkpoint, including follow-up user messages that could quote the evidence. Existing encrypted backups are not rewritten.

Explicit Forget account and Clear demo delete associated conversation records from the encrypted checkpoint rather than merely hiding them. Already-redacted placeholders are also removed on explicit forgetting; `ChatService.forgetSource` provides the same purge for source removal. Source deselection is a revocation, not a source-deletion command, and permanently removes affected transcript contents immediately. Archive restore reloads its replacement chat checkpoint, applies current permissions, and disables restored pending approvals to prevent replay.

Full dependency scope includes calendar/task/report output even when the model supplies no mail citations, and the accounts/sources contributing to aggregate totals outside a returned page. Browser calendar `whenText` labels remain verbatim; ambiguous dates are not invented. The status tool exposes only the chosen model, local remaining request budget, pause flag and permitted source identifiers/names; it does not expose client credentials or token settings.

Shutdown cancels pending chat work. Recovery marks interrupted turns cancelled and interrupted actions failed with reconciliation guidance. Confirmation already executing cannot be undone by cancelling chat.

## Bounded behavior

- 20 conversations; 60 turns per conversation (user and assistant turns both count).
- 12,000 characters per user message; 100,000 characters for the complete submitted history/prompt. Oversized input is rejected, **not silently truncated**. Conversation titles are short display labels; the original user message remains intact.
- No cap on the number of tool calls or agent rounds per answer; six proposal cards per assistant turn. Long runs are bounded only by the inactivity timeout below.
- 16,000 characters of tool arguments or exact action preview. A tool response over 24,000 characters is withheld, and the agent is asked for a smaller page. Once 320,000 characters of tool results have been gathered, further evidence is withheld and the agent answers from what it has, stating that coverage was limited. Neither case fails the answer.
- 1,000 tracked evidence dependencies; 20,000 characters in a final model answer.
- Search returns at most 12 excerpts. Recent inbox pages contain up to 12 messages with 1,000-character excerpts. Message bodies are paged in 10,000-character slices; attachment text in six-chunk pages; tasks/calendar in 20-item pages.
- 180-second inactivity timeout, reset by SDK activity or actual inbox-download progress and paused while a tool is executing; no overall deadline; tool progress and cancellation are live, final text is not token-streamed.

Argument-size limits stop the request with an explicit visible error. Output limits withhold evidence and the answer states that coverage was limited; they never silently present partial evidence as complete.

Each submitted SDK request goes through the existing shared `runAi` busy/budget gate. Tool-driven model rounds inside that request can consume additional Copilot credits; the local counter measures submitted agent requests, **not provider billing credits**. Confirmed draft/report/review AI work uses the existing separate accounting and current model selection. Chat and archive review are not parallel AI sessions: a busy request fails visibly rather than silently cancelling the other.

Coverage is intentionally truthful: search results are not a full archive review; browser captures may be partial/stale; chat coverage counts eligible messages but directs users to AI review for exact batch progress.

## Offline validation

`tests/chat.test.ts`, `tests/chat-copilot.test.ts`, and `tests/chat-service.test.ts` use synthetic vaults/SDK clients. They cover consent revocation during tools and after AI, historical redaction, scoped attachments, persisted one-shot proposals, revision checks, cancellation/recovery, prohibited actions, selected model, SDK restrictions, shared budget/busy gating, local draft generation, exact native draft handoff, calendar approval and private task scheduling. Synthetic provider spies verify that no write occurs before confirmation, that exact displayed fields reach the connector, and that revocation during asynchronous save preparation blocks the native write. No production browser bridge, real mailbox/calendar or live Copilot quota is used by these tests.
