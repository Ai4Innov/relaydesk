# Attachment support

Relay Desk records attachment metadata before obtaining file contents. Unsupported types remain
visible. API attachments use the authenticated provider download callback. Browser-captured
Gmail attachments download automatically when **Automatically download and index Gmail
attachments** is enabled (the default) and their account/source is locally permitted.
The paired companion uses the exact download link from the verified native Gmail attachment
widget through Chrome/Edge's Downloads API. It does not extract cookies or invent provider
endpoints. Downloads require the updated companion's `downloads` permission.
Loaded-page metadata alone does not provide file contents. The pipeline never follows an arbitrary attachment URL,
Office relationship, playlist URL or external media link.

Local-copy import does not establish that an entire conversation's attachments were captured.
Only metadata from attachment tiles in loaded, expanded Gmail messages is captured, not
inbox previews or unloaded messages. The download queue also processes previously discovered
files, subject to source permissions, processing approval and resource limits. No AI request
or separate provider API registration is needed; account AI consent remains separate.
Unknown-size, large and costly files wait for approval in their attachment card.
Previously cached full emails are revisited once for the versioned attachment scan, including
legacy empty lists. Unverified/loading manifests are not treated as empty; failures back off.

Browser downloads temporarily use a request-specific `RelayDesk` subdirectory in the Windows
Downloads folder. Relay Desk validates the exact authorized destination and regular file,
encrypts the bytes, and removes only that job's verified staging file. This temporary
browser-created copy is not encrypted while downloading. A custom browser Downloads folder
outside Windows Downloads cannot be imported automatically; use the default folder or the
manual fallback. Browser-blocked dangerous downloads are never accepted automatically.

**Import downloaded file** remains available as a fallback and for WhatsApp. Its native file
picker requires a filename matching captured metadata; that check alone does not independently
prove the file's origin. User-selected originals are not deleted.

The imported original is copied into encrypted storage and processed through the existing
extraction pipeline and resource limits. Successfully indexed text is available to local
search. **Comprehensive AI archive review currently excludes attachment contents**, including
imported and indexed files; its coverage must not be interpreted as attachment review.

## Approval and status

Approval is required **before download** for unknown sizes, sizes above 25 MiB or a lower
configured threshold, ZIP archives, raster OCR, and audio/video. A provider that understates
size cannot bypass the threshold: the stream stops before over-threshold bytes are retained.
Scanned PDF pages detected after downloading require approval before OCR. Approval does not
remove resource limits.

Originals are streamed through the Vault's encrypted blob writer with SHA-256 checksums.
Retries reuse the encrypted original. Text extraction runs in a worker thread, not on the
Electron main event loop. Media tools run as explicitly configured local children; file
contents travel through anonymous pipes, not plaintext staging files.

States include `awaiting-approval`, `downloading`, `extracting`, `indexed`, `partial`,
`unsupported`, `encrypted`, `blocked`, `failed`, and `cancelled`. `indexed` requires real
nonempty text and successful local retrieval indexing. Empty/scanned/unsupported content is
never presented as successfully indexed. `partial` explains omitted pages, members or content.
Failures do not log the underlying provider response or raw document contents.

## Formats

| Format | Processing and references |
| --- | --- |
| TXT | Strict UTF-8, with physical line ranges. Binary/legacy encoding is rejected. |
| CSV | UTF-8 plain text with physical line ranges; multiline records are not mislabeled as row numbers. Formulas remain inert text. |
| PDF | `pdfjs-dist`, with page numbers; image-only pages use local OCR after approval. Password protection is explicit. |
| DOCX | `mammoth` raw text, paragraph references. No linked-file retrieval. |
| XLSX | `exceljs`, sheet/cell references. Formulas are never evaluated; only stored cached results are used. |
| PPTX | Safe ZIP/XML parsing, presentation slide order and notes relationships. |
| PNG, JPEG, WebP, BMP, single-page TIFF | Local Tesseract OCR with validated dimensions; native canvas codec availability is required. Animated WebP/multipage TIFF are blocked; use a PDF export. |
| ZIP | In-memory extraction, member-qualified references, bounded nested ZIPs. Unsupported members make the result partial. |
| WAV, MP3, M4A, OGG, FLAC; MP4, MOV, WebM, MKV, AVI | FFmpeg audio decoding, whisper.cpp transcription with timestamp references. Video visuals are not interpreted. |

Legacy Office, macro-enabled documents, executables, scripts, HTML/SVG, encrypted archives,
other archive formats and unsupported codecs are not silently interpreted. Content signatures
are checked as well as file names. Raster-only Office content is not OCRed automatically.
Some containers require seekable input and cannot be decoded through pipes; those jobs visibly
fail instead of writing plaintext media to disk.

## Resource and safety controls

These are implementation resource budgets, **not a marketing file-size ceiling**. Approval
can retain a larger original encrypted, but extraction can still be blocked with an explanation.

- Whole-buffer decryption/extraction is limited to the lesser of 128 MiB and 1/16 available
  RAM. Streaming extraction of originals above this budget is not implemented.
- Native browser downloads have a five-minute deadline and a 512 MiB safety budget
  even after approval. Larger files need a smaller export; approval does not guarantee
  that the entire retained original can be extracted within local memory limits.
- Five-minute overall job deadline; V8 worker heap 384 MiB, young generation 32 MiB.
- ZIP: 2,000 cumulative entries, 128 MiB cumulative expanded bytes, 32 MiB per entry,
  200:1 expansion ratio, three archive levels. Declared sizes and CRC are verified.
- Absolute/traversal/Windows-device paths, backslashes, NTFS alternate streams, symbolic links,
  special files and duplicate names are refused. Nothing is extracted to the filesystem.
- Office packages receive the same ZIP checks; XML DTD/entities, macros and embedded objects
  are refused. Relationships are never fetched.
- 2,000,000 text characters, 10,000 segments, 300 PDF pages, 16 million OCR pixels.
- Media: first ten minutes, two whisper CPU threads, 60-second decoder and 120-second
  transcription deadlines, bounded pipe outputs and FFmpeg allocation sizes. Truncation is
  reported as partial.
- Models are limited to the lesser of 512 MiB and 1/8 available RAM and verified before loading.
- Cancellation stops provider streaming, terminates the worker and requests media-child
  termination. Successful/failed parsers leave no application-created plaintext extraction files.

Worker HTTP/HTTPS/fetch/socket access is disabled, Tesseract uses only preverified local assets,
PDF evaluation is disabled, and FFmpeg accepts only pipe protocols. **Worker threads and these
library controls are not an OS security sandbox**: native parser memory is not governed solely
by V8 heap limits, and a compromised native library may evade JavaScript restrictions. Keep
parsers patched; a hardened Windows restricted-token/job-object sandbox remains a release
hardening task. No assurance is made that an arbitrary hostile parser exploit is contained.

## Offline OCR and transcription setup

The desktop app installs English and French OCR models automatically on first use: pinned
`tessdata_fast` files (Apache-2.0) are downloaded from a fixed upstream commit, size- and SHA-256-verified,
and registered in `models.json` under the app's `models` directory. An existing user-configured `ocr` entry is
never overwritten. Attachments left blocked because OCR was missing are re-queued at startup, and chat can read an
unindexed attachment on demand. Transcription models and executables are never downloaded automatically. To
configure them (or your own OCR models), obtain reviewed, licensed models, verify published checksums, then
edit `models.json`:

```json
{
  "version": 1,
  "ocr": {
    "language": "eng",
    "file": "eng.traineddata",
    "sha256": "REPLACE_WITH_THE_VERIFIED_64_HEX_SHA256"
  },
  "transcription": {
    "file": "ggml-base.bin",
    "sha256": "REPLACE_WITH_THE_VERIFIED_64_HEX_SHA256"
  }
}
```

Use an **uncompressed** Tesseract language file. A single three-letter language identifier is
supported per installation. The file name must match the language, e.g. `fra.traineddata`.
The manifest can contain only the engine being installed. Symlinks escaping the model directory
and checksum mismatches are blocked. Runtime installation/download UI is not implemented.

For media, set absolute executable paths in the application environment:

```powershell
$env:RELAY_FFMPEG_PATH = 'C:\ReviewedTools\ffmpeg.exe'
$env:RELAY_WHISPER_CPP_PATH = 'C:\ReviewedTools\whisper-cli.exe'
```

Use reviewed FFmpeg and whisper.cpp Windows binaries; Relay Desk never downloads or executes an
attachment as a tool. The whisper.cpp build must accept WAV on standard input (`-f -`) and emit
timestamped text on standard output. Incompatible builds yield an explicit failure. Check codec,
binary and model licensing separately before redistribution. Missing engines/models do not cause
a cloud fallback or fabricated success.

## Packaging and validation

Copy `src\main\attachments\attachment-worker.cjs` beside packaged `.vite\build\main.js`.
This is a real CommonJS asset and does not require a TypeScript loader in Electron. Its parser
dependencies must remain packaged runtime dependencies; PDF/raster OCR also needs pdfjs-dist's
optional native `@napi-rs/canvas` dependency, and Tesseract needs local worker/core/WASM assets.
The processor reports a missing worker/component instead of attempting runtime installation.
Native canvas binaries and user-configured executables must be accessible outside compressed
ASAR where required by Electron's native loader.

`npm test -- tests\attachments.test.ts` covers gates, deceptive sizes, cancellation, failures,
real UTF-8/PDF/DOCX/XLSX/PPTX extraction, archive paths/links/bombs/depth, encrypted ZIP metadata,
and visible missing-model/media configuration. It performs no model downloads. Successful real
OCR/transcription and packaged codec availability require separate explicitly installed fixtures;
passing these unit tests does not claim those live engine checks have passed.
# Internal viewing and saving originals

Inbox attachment rows and cited documents in Chat offer **View document**. PDFs
render one read-only page at a time with page navigation and zoom; supported
raster images display locally. Office files use their extracted text, explicitly
labelled as a text preview rather than a reproduction of the original layout.
Unsupported files show an explanation instead of attempting to execute content.
PDF scripts, forms, embedded links and external resources are not activated.

**Save to Downloads** opens the native save dialog in Downloads with a safe
filename. You can choose another local folder. It exports the retained original,
not an AI summary; existing files are never overwritten. Exported copies are
ordinary local files outside Relay Desk's encrypted archive.

Local viewing/export requires a connected account, local data consent and a
selected source, but does not require AI consent. Source revocation closes an
open viewer and invalidates pending access. Preview bounds are 12 MiB for PDF or
image bytes, 16 megapixels for images, and 200,000 characters for text. Larger
originals can be exported up to the 128 MiB in-memory export limit; larger exports
must be downloaded directly in the provider application.

Browser attachment records initially contain metadata only. Gmail originals enter
the automatic download/indexing queue; their cards also offer **Download and index**
and approval when required. WhatsApp still requires **Import downloaded file**,
which remains a Gmail fallback. API attachments use their existing processing/download
action. Opening a viewer never bypasses file-size or processing approval.
