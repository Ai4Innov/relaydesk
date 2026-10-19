import { fork } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { freemem } from "node:os";
import type { Attachment, Collection } from "../../shared/contracts";
import { approvalLimit, approvalReason, attachmentFormat } from "./policy";

interface AttachmentVault {
  get<T>(collection: Collection, id: string): T | undefined;
  put<T>(collection: Collection, id: string, value: T): void;
  all<T>(collection: Collection): T[];
  writeBlob(id: string, stream: ReadableStream<Uint8Array>, signal?: AbortSignal): Promise<{ hash: string; size: number }>;
  readBlob(id: string): Buffer | Promise<Buffer>;
}
interface AttachmentRetrieval {
  indexAttachment(attachment: Attachment, segments: { text: string; location: string }[]): Promise<void>;
}
interface Options {
  /** Approval granted by default (Settings → Activity). Safety and resource limits still apply. */
  autoApprove?(): boolean;
  modelDirectory: string;
  thresholdMb: () => number;
  /** Explicit override for tests/custom deployment; production copies the CJS asset beside main.js. */
  workerPath?: string;
}
interface Extraction {
  segments: { text: string; location: string }[];
  status?: Attachment["status"];
  reason?: string;
}
export interface AttachmentInput {
  size?: number;
  validate(): void;
  open(signal: AbortSignal): Promise<ReadableStream<Uint8Array>>;
}
class PipelineError extends Error {
  constructor(readonly status: Attachment["status"], message: string) { super(message); }
}
const TIME_LIMIT_MS = 5 * 60 * 1000;
const active = new Set<string>();

export class AttachmentProcessor {
  constructor(
    private readonly vault: AttachmentVault,
    private readonly retrieval: AttachmentRetrieval,
    private readonly download: (attachment: Attachment, signal?: AbortSignal) => Promise<ReadableStream<Uint8Array>>,
    private readonly options: Options,
  ) {}

  async process(attachmentId: string, approved: boolean, signal?: AbortSignal, input?: AttachmentInput): Promise<void> {
    approved ||= this.options.autoApprove?.() === true;
    if (active.has(attachmentId)) return;
    const original = this.vault.get<Attachment>("attachments", attachmentId);
    if (!original) throw new Error("Attachment not found.");
    if (original.browser && !original.hash && !input)
      throw new Error("Use Download attachment for Gmail, or choose Import downloaded file for a manual fallback.");
    if (original.status === "indexed") return;
    active.add(attachmentId);
    let attachment = { ...original };
    const set = (status: Attachment["status"], reason?: string, patch: Partial<Attachment> = {}) => {
      input?.validate();
      // Forget/disconnect may delete a record while a worker is running. Never resurrect it.
      if (!this.vault.get<Attachment>("attachments", attachmentId)) throw new PipelineError("cancelled", "Attachment was removed.");
      attachment = { ...attachment, ...patch, status, reason };
      this.vault.put("attachments", attachment.id, attachment);
    };
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(() => controller.abort(new PipelineError("blocked", "Attachment processing exceeded the five-minute resource budget; retry a smaller export.")), TIME_LIMIT_MS);
    try {
      controller.signal.throwIfAborted();
      input?.validate();
      if (input?.size !== undefined) attachment.size = input.size;
      const format = attachmentFormat(attachment);
      if (!format) { set("unsupported", "This file type is not supported. Executables, scripts, macros and arbitrary external links are never opened."); return; }
      const reason = approvalReason(attachment, this.options.thresholdMb());
      if (!approved && reason) {
        set("awaiting-approval", input ? reason.replace(/download/gi, "local import") : reason); return;
      }
      if (!attachment.hash) {
        set(input ? "extracting" : "downloading", input ? "Importing downloaded bytes into the encrypted archive." : undefined, { approved });
        const stream = input ? await input.open(controller.signal) : await this.download(attachment, controller.signal);
        const reader = stream.getReader();
        const cancelReader = () => { void reader.cancel(controller.signal.reason).catch(() => {}); };
        controller.signal.addEventListener("abort", cancelReader, { once: true });
        let received = 0;
        const limit = approvalLimit(this.options.thresholdMb());
        const guarded = new ReadableStream<Uint8Array>({
          async pull(destination) {
            try {
              controller.signal.throwIfAborted();
              input?.validate();
              const chunk = await reader.read();
              input?.validate();
              if (chunk.done) { destination.close(); return; }
              received += chunk.value.byteLength;
              if (!approved && received > limit)
                throw new PipelineError("awaiting-approval", "Actual download exceeds the approval threshold; download stopped before retaining further bytes.");
              destination.enqueue(chunk.value);
            } catch (error) { void reader.cancel().catch(() => {}); destination.error(error); }
          },
          cancel: reason => reader.cancel(reason),
        }, { highWaterMark: 0 });
        let blob: { hash: string; size: number };
        try { blob = await this.vault.writeBlob(attachment.id, guarded, controller.signal); }
        finally {
          controller.signal.removeEventListener("abort", cancelReader);
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
        set("extracting", undefined, { hash: blob.hash, size: blob.size, approved });
      } else set("extracting", undefined, { approved });
      controller.signal.throwIfAborted();
      // Blob APIs currently decrypt whole buffers. Bound that allocation before readBlob,
      // independently of the approval threshold and without capping encrypted archival.
      const inputBudget = Math.min(128 * 1024 * 1024, Math.floor(freemem() / 16));
      if (attachment.size === undefined || attachment.size > inputBudget)
        throw new PipelineError("blocked", `Original retained encrypted. Extraction requires more than the current ${Math.floor(inputBudget / 1048576)} MiB input-memory budget; split/export this document.`);
      const bytes = await this.vault.readBlob(attachment.id);
      input?.validate();
      if (bytes.length > inputBudget) throw new PipelineError("blocked", "Decrypted original exceeds the current extraction-memory budget.");
      const result = await this.extract(bytes, attachment, approved, controller.signal);
      controller.signal.throwIfAborted();
      const segments = result.segments.filter(segment => segment.text.trim());
      if (segments.length) {
        input?.validate();
        await this.retrieval.indexAttachment(attachment, segments);
        controller.signal.throwIfAborted();
        set(result.status === "partial" || result.reason ? "partial" : "indexed", result.reason);
      } else {
        // Also clear stale derived text when a re-extraction yields no evidence.
        input?.validate();
        await this.retrieval.indexAttachment(attachment, []);
        set(result.status ?? "partial", result.reason ?? "No searchable text was found; the original remains encrypted.");
      }
    } catch (error) {
      const cause = controller.signal.aborted ? controller.signal.reason : error;
      const status = cause instanceof PipelineError ? cause.status : controller.signal.aborted ? "cancelled" : "failed";
      if (this.vault.get<Attachment>("attachments", attachmentId))
        set(status, cause instanceof PipelineError ? cause.message : status === "cancelled" ? "Attachment processing cancelled." : "Download, decryption, extraction or indexing failed. Retry or check the provider and local parser installation.");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      active.delete(attachmentId);
    }
  }

  private extract(bytes: Buffer, attachment: Attachment, approved: boolean, signal: AbortSignal): Promise<Extraction> {
    const bundled = typeof __dirname !== "undefined" ? join(__dirname, "attachment-worker.cjs") : "";
    // Never fall back to cwd: a packaged app can be started from an untrusted folder.
    const workerPath = this.options.workerPath ?? bundled;
    if (!existsSync(workerPath)) throw new PipelineError("blocked", "The packaged attachment worker is missing. Repair the Relay Desk installation.");
    const hostPath = join(dirname(workerPath), "attachment-host.cjs");
    if (!existsSync(hostPath)) throw new PipelineError("blocked", "The packaged attachment worker host is missing. Repair the Relay Desk installation.");
    return new Promise((resolve, reject) => {
      // Parse in a disposable child process (Node mode of this same executable), not an
      // in-process thread: a crash in a native parser addon must not close the app.
      const child = fork(hostPath, [], {
        execPath: process.execPath, serialization: "advanced", stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true,
        // Do not forward provider credentials or other ambient application secrets.
        env: {
          ELECTRON_RUN_AS_NODE: "1",
          PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "",
          RELAY_WHISPER_CPP_PATH: process.env.RELAY_WHISPER_CPP_PATH ?? "",
          RELAY_FFMPEG_PATH: process.env.RELAY_FFMPEG_PATH ?? "",
        },
      });
      let settled = false;
      const finish = (error?: Error, result?: Extraction) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort);
        if (child.connected) child.send("cancel", () => {});
        // Give the host an event-loop turn to stop its explicitly configured media child.
        const termination = setTimeout(() => { if (child.exitCode === null) child.kill(); }, 200);
        termination.unref();
        if (error) reject(error); else resolve(result!);
      };
      const abort = () => finish(signal.reason instanceof Error ? signal.reason : new PipelineError("cancelled", "Attachment processing cancelled."));
      signal.addEventListener("abort", abort, { once: true });
      child.on("message", (reply: { type: string; result?: Extraction }) => {
        if (reply?.type === "result") finish(undefined, reply.result);
        else if (reply?.type === "error") finish(new PipelineError("blocked", "The isolated parser failed or exceeded its memory budget. Original retained encrypted."));
        else finish(new PipelineError("failed", "The isolated parser exited without an extraction result."));
      });
      child.once("error", () => finish(new PipelineError("failed", "The isolated parser process could not start.")));
      // "close" follows delivery of every IPC message, unlike "exit".
      child.once("close", () => finish(new PipelineError("failed", "The isolated parser exited without an extraction result.")));
      child.send({
        workerPath,
        workerData: { bytes, attachment: { name: attachment.name, mimeType: attachment.mimeType }, approved, modelDirectory: this.options.modelDirectory },
        resourceLimits: { maxOldGenerationSizeMb: 384, maxYoungGenerationSizeMb: 32, stackSizeMb: 8 },
      }, error => { if (error) finish(new PipelineError("failed", "The isolated parser process could not receive the attachment.")); });
      if (signal.aborted) abort();
    });
  }
}
