# Architecture and validation boundaries

## Process and trust boundaries

`src\main\app.ts` owns the Electron lifecycle, tray, Windows credential protection, native file dialogs and trusted IPC. It constructs `RelayService`, which coordinates provider access, jobs, drafts, approvals, retrieval and AI.

The renderer runs with Node integration disabled, context isolation and sandboxing enabled. New windows, navigation away from the application and permission requests are denied. The narrow preload bridge exposes snapshots and application commands, not arbitrary filesystem, SQL, shell or credential access. `ipc\schema.ts` rejects unknown command fields and privileged commands absent from the allowlist. In particular, UI patches cannot reset `aiRunsToday` or `aiUsageDate`.

The `RelayService.command` TypeScript method is internal; runtime validation happens at the IPC handler. Tests calling the service directly do not themselves prove the Electron sender/origin checks.

## Persistent data

`storage\vault.ts` uses `better-sqlite3-multiple-ciphers` in SQLCipher mode. The application refuses to start if Windows `safeStorage` encryption is unavailable. A random 32-byte archive key is protected in `archive-key.dpapi`; the database does not fall back to plaintext.

Records include accounts, source selections, messages, draft state, attachment metadata, calendars, approvals, settings, credentials, jobs and checkpoints. FTS5 text and embedding vectors live inside the encrypted database. Original attachment blobs and backups are authenticated encrypted files, with keys derived from the archive key. Model caches are not secret credential stores and are not covered by archive encryption. Decrypted material exists in process memory during use.

Backups are encrypted, key-bound recovery artifacts. Restore replaces the local archive; it is not a merge or portable user-account migration. After an attempted restore, synchronization and background AI are paused, interrupted jobs are paused, and pending/executing calendar approvals are made uncertain so they cannot replay. This also applies when cleanup fails after installing the restored archive; the error remains visible. Preserve the original Windows-protected key/profile; no recovery-password export is implemented.

## Service workflow

`src/main/service.ts` (`RelayService`) owns job tracking, sync scheduling and shared guards, and validates and dispatches renderer commands. Domain command handlers live in `src/main/commands/`: `accounts.ts` (consent, source selection, demo data), `gmail-relay.ts` (Apps Script relay) and `browser-calendar.ts` (reviewed browser rescheduling). They receive a narrow `CommandContext` rather than the whole service, so private state such as abort controllers and active jobs is reached only through explicit callbacks. Chat tool output limits are in `src/main/chat-tool-budget.ts`.

- Source selection gates ingestion and use. Disconnect removes connector credentials and excludes the account from retrieval; optional forgetting purges local account-derived data. Provider copies remain unchanged.
- Sync is scheduled approximately every minute while the app is running and sync is not paused. Provider adapters paginate selected sources and provide durable cursors. The service persists a cursor only after the page's local indexing succeeds.
- Local rules identify questions/urgency without Copilot. They are fallible suggestions, not verified commitments or inferred deadlines.
- Background AI requires an enabled account, global opt-in, selected model and remaining local budget. The current batch is limited to three recent nonhistorical messages. Historical backfill is not a request to draft every old conversation.
- Jobs store running/done/failed state. Retry is limited to commands with persisted retry arguments. Startup pauses interrupted jobs rather than silently replaying them.
- Draft generation/editing changes the local archive only. Native draft saving requires its own command and source-revision check. A save is marked uncertain before the provider call; an ambiguous failure must be reconciled manually.
- Calendar proposals bind the exact payload to a SHA-256 hash. Approval checks hash, payload, time window and single-use status before writing. Calendar audit records retain the payload hash. The provider may notify attendees; no automatic event deletion is exposed.

The service is not a distributed durable job broker. It does not continue while the process or Windows is stopped, and not every operation is automatically retryable.

### Provider-specific coverage

Gmail uses selected-label backfill and mailbox history cursors. Microsoft discovers recursive mail folders and uses folder delta cursors. Slack uses initial/daily full scans, overlapping incremental history and revisits known threads; these requests remain subject to workspace retention and rate limits.

Microsoft calendar reads refresh a paginated rolling window from 365 days before through 730 days after the current time, including recurrence expansion for reading. They are not unlimited-history calendar imports or an arbitrary-calendar delta feed. Cancelled events remain visible as cancelled/read-only records.

Microsoft draft updates use conditional writes. Gmail checks the remote draft revision immediately before updating, but the Gmail draft API path has no documented atomic compare-and-swap guarantee here. An external edit in that small interval can still race; avoid concurrent editing and inspect the provider after uncertain outcomes.

## Copilot isolation and evidence

`copilot\index.ts` dynamically loads the official SDK, uses the logged-in user's identity and checks authentication and the entitled model list. Ambient GitHub token overrides are removed from the child environment. There is no AI-provider key field and no alternate paid-provider fallback.

The client uses SDK `mode: "copilot-cli"` so the runtime can access the Windows credential store used by CLI login. SDK `mode: "empty"` forces `COPILOT_DISABLE_KEYTAR=1`, preventing that discovery. Session isolation is configured explicitly rather than inherited from empty mode: experimental features, scheduling, coauthor behavior and skills are disabled, MCP OAuth storage remains in memory, and installed plugins are cleared before any prompt is sent.

Each request creates a fresh, model-specific session. Its filesystem provider is in-memory. General built-in/MCP tools, plugins, skill/config/instruction discovery, host Git operations, file hooks, persistent memory, session store/telemetry and embedding retrieval are disabled. Permission requests are denied. Non-chat generation has no tools. Chat explicitly allowlists app-owned read and proposal tools with deterministic source checks; proposals cannot execute provider writes. These choices constrain the app session; they do not make Copilot's remote service offline or establish its retention policy.

Non-chat generation receives a bounded user task and up to 12 evidence excerpts, each limited to 6,000 characters. Messages are labeled untrusted evidence. Structured JSON is validated, including citation IDs against supplied evidence. The session is aborted/disconnected and the memory filesystem cleared after use; in-memory sessions do not use the disk-session deletion API. Prompts cannot directly invoke draft-saving or calendar-writing adapters.

`chat.ts` persists bounded conversations and main-process action payloads in encrypted checkpoints. The SDK runs its actual tool loop against selected AI-enabled sources; the app retains all tool evidence dependencies, including uncited inputs. The renderer confirms an exact stored action by ID, never by supplying an executable payload. Revisions and permissions are rechecked before execution and immediately before native writes. Revocation removes affected transcript contents, forgetting purges related conversations, and restore prevents pending-action replay. See [chat agent](chat-agent.md) for tool coverage, limits and lifecycle behavior.

Models still make mistakes and prompt isolation is not a guarantee of accurate prose. Users must inspect drafts, recipients, dates and citations.

## Retrieval

Keyword search uses SQLite FTS5. Optional semantic search runs an ONNX-compatible model locally and stores vectors in the encrypted database. Candidate selection uses an indexed 8-bit projection with neighboring buckets plus lexical candidates, followed by local ranking; this is approximate retrieval, not a full-corpus exhaustive vector comparison or a `sqlite-vec` integration.

All supplied text segments are divided into overlapping 1,800-character chunks and indexed lazily in batches of 64, yielding between batches. There is no per-document chunk-count cap; 64 is the batch size, not a truncation limit. A failed/interrupted document rebuild clears its incomplete index and reports the failure. Upstream attachment extraction can still be partial because of its separately disclosed resource limits.

Search results are bounded to 12 excerpts and two per document; complete indexing does not imply an exhaustive answer to every question. Account/source permission checks are reapplied during indexing and after asynchronous inference. Enabling AI sharing is distinct from authorizing local archival/search.

The `hybrid` search indicator means the local embedding engine is loaded, not that the whole archive already has vectors. Existing content requires Archive Reindex after model setup/change; newly indexed messages are embedded automatically.

If loading the semantic model fails during startup, the service records a failed index job with an actionable message and keeps the application usable with keyword search. It does not silently claim semantic retrieval succeeded.

The default embedding model is `Xenova/multilingual-e5-small`, quantized for CPU inference, with the appropriate E5 query/passage prefixes. Enabling semantic search may download it using Transformers' model cache. The app resolves and persists an immutable Hugging Face commit SHA along with repository, quantization and index-version metadata; later launches reuse it rather than silently tracking `main`. This does not independently verify artifact signatures/hashes or provide accurate pre-download size/disk checks. Those remain release-hardening requirements.

## Attachment processing

Provider downloads pass through size/consent checks and encrypted blob storage. Parsers run in a worker thread rather than the renderer. Worker resource limits and cancellation reduce accidental resource exhaustion; a worker thread is **not an OS security sandbox**.

See [attachment support](attachment-support.md) for exact formats, resource budgets, optional engine requirements and packaging instructions.

The pipeline supports TXT/CSV, text PDF, DOCX, XLSX, PPTX, raster-image OCR, bounded ZIP extraction, and audio/video-audio transcription paths. It does not execute attachment scripts/macros or fetch arbitrary links. Unknown/encrypted/unsafe files receive visible status/reasons.

Explicit approval is required for unknown sizes, downloads above 25 MiB or a lower configured threshold, ZIP, image OCR and media. Approved originals can be streamed into encrypted storage without a product-level archive-size ceiling, subject to disk/resources/provider limits. Full-buffer extraction is separately limited to at most 128 MiB and a fraction of available RAM. There is a five-minute processing budget; ZIP entry/expansion/ratio/depth limits and document/media bounds can result in partial output. Approval never disables those safeguards.

### Optional local models and media

OCR and transcription models are manually supplied under the application's `models` directory. Review model/tool licenses and provenance before installing them. There is no automatic downloader for these optional models.

The attachment worker reads a `models.json` manifest:

```json
{
  "version": 1,
  "ocr": {
    "file": "eng.traineddata",
    "language": "eng",
    "sha256": "<64-hex-character SHA-256 of the trusted local model>"
  },
  "transcription": {
    "file": "ggml-base.bin",
    "sha256": "<64-hex-character SHA-256 of the trusted local model>"
  }
}
```

Replace the placeholders; they are not valid checksums. Verify a trusted upstream checksum before using `Get-FileHash -Algorithm SHA256` to compare the installed artifact. A checksum supplied alongside an untrusted download does not prove provenance. OCR requires an uncompressed matching `language.traineddata` file. Unconfigured/mismatched models cause a blocked status rather than a hidden download.

Media additionally requires absolute paths to trusted local executables before launching Relay Desk:

```powershell
$env:RELAY_FFMPEG_PATH = 'C:\Tools\ffmpeg\bin\ffmpeg.exe'
$env:RELAY_WHISPER_CPP_PATH = 'C:\Tools\whisper.cpp\whisper-cli.exe'
npm start
```

No ffmpeg/whisper.cpp binary or model is bundled or claimed tested against all real-world media. Scanned PDF OCR additionally depends on a working local canvas renderer; a missing renderer/model results in a blocked/partial status rather than a cloud fallback. Video handling transcribes audio only. Parser limits include bounded PDF pages, images and media duration; longer material requires splitting/exporting and review.

## Validation and release gates

`tests\service.test.ts` integrates the real service, command schema and approval code with structural in-memory storage and `vi.mock` doubles for connectors, retrieval, attachments and Copilot. It checks local-only drafts, explicit provider writes, stale/conflict handling, exact approvals, budget-schema protection, source/account exclusions at orchestration boundaries, job recovery and restore behavior. It performs no real API calls or model downloads.

These tests do not certify SQL encryption, provider OAuth correctness, the real retrieval SQL, extraction engines, renderer origin checks or packaging. Separate storage/retrieval/provider/attachment tests and desktop smoke tests cover their own boundaries. A passing mock suite must not be described as successful live Copilot generation or account synchronization.

The service suite includes ordinary passing regressions for refusing restore when a job starts while its native file dialog is open, and refusing AI generation from deleted message bodies.

A packaged Windows application has passed Playwright startup and encrypted-vault sample/search checks. Its bundled Copilot runtime recognizes the existing CLI login and returns available models. Set `RELAY_REQUIRE_COPILOT_AUTH=1` for desktop coverage that requires ready status and a nonempty model inventory rather than accepting the unauthenticated login gate. Packaging includes external runtime dependencies and the CommonJS attachment-worker asset. These results establish packaged startup and authentication, not successful AI generation or every optional parser/codec path.

Renderer tests additionally exercise workflows in installed Edge using an injected bridge: navigation, plaintext rendering, draft preservation and local-before-native save ordering, citations, explicit calendar approval, transient credential clearing and responsive layout. This is a distinct test boundary from packaged Electron and live provider access.

Release still requires user-authorized live provider tests, Copilot/model generation, optional model/tool validation, appropriate privacy/compliance review and recovery testing. See README for runtime pins and authentication troubleshooting.
