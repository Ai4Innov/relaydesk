import type { VoiceModel } from "../shared/contracts";

/** Local Whisper models (ONNX, run on this computer). Audio never leaves the machine. */
export const VOICE_MODELS: Record<VoiceModel, string> = {
  base: "onnx-community/whisper-base",
  small: "onnx-community/whisper-small"
};
export const VOICE_SAMPLE_RATE = 16_000;
/** Base64 of 16 kHz mono 16-bit PCM: about 43 KB per second, so roughly 15 minutes. */
export const VOICE_AUDIO_MAX_BASE64 = 40_000_000;

interface Tensorish { data: ArrayLike<number>; dims: number[] }
export interface SpeechPipeline {
  (audio: Float32Array, options: Record<string, unknown>): Promise<{ text: string } | { text: string }[]>;
  tokenizer: { model: { tokens_to_ids: Map<string, number> } };
  processor: (audio: Float32Array) => Promise<{ input_features: unknown }>;
  model: (inputs: { input_features: unknown; decoder_input_ids: unknown }) => Promise<{ logits: Tensorish }>;
  dispose?: () => Promise<void>;
}
export type SpeechLoader = (model: string, cacheDirectory: string) => Promise<{ pipeline: SpeechPipeline; startToken: (id: number) => unknown }>;

const defaultLoader: SpeechLoader = async (model, cacheDirectory) => {
  const { pipeline, Tensor } = await import("@huggingface/transformers");
  const asr = await pipeline("automatic-speech-recognition", model, {
    dtype: { encoder_model: "fp32", decoder_model_merged: "q8" }, device: "cpu", cache_dir: cacheDirectory
  });
  return {
    pipeline: asr as unknown as SpeechPipeline,
    startToken: id => new Tensor("int64", BigInt64Array.from([BigInt(id)]), [1, 1])
  };
};

/** Decodes the renderer's base64 16-bit PCM into normalized samples. */
export function decodePcm16(base64: string): Float32Array {
  const bytes = Buffer.from(base64, "base64");
  const samples = new Float32Array(bytes.length >> 1);
  for (let index = 0; index < samples.length; index++) samples[index] = bytes.readInt16LE(index * 2) / 32768;
  return samples;
}

/**
 * Whisper language identification: one decoder step after <|startoftranscript|>,
 * picking the most likely language token (transformers.js otherwise assumes English).
 */
export async function detectLanguage(asr: SpeechPipeline, startToken: (id: number) => unknown, samples: Float32Array): Promise<string | undefined> {
  const ids = asr.tokenizer.model.tokens_to_ids;
  const start = ids.get("<|startoftranscript|>");
  if (start === undefined) return undefined;
  const languages = [...ids].filter(([token]) => /^<\|[a-z]{2,3}\|>$/.test(token) && token !== "<|nocaptions|>");
  const { input_features } = await asr.processor(samples.subarray(0, VOICE_SAMPLE_RATE * 30));
  const { logits } = await asr.model({ input_features, decoder_input_ids: startToken(start) });
  const vocabulary = logits.dims.at(-1)!, offset = logits.data.length - vocabulary;
  let best: [string, number] | undefined;
  for (const [token, id] of languages) if (!best || logits.data[offset + id] > logits.data[offset + best[1]]) best = [token, id];
  return best?.[0].slice(2, -2);
}

export class VoiceTranscriber {
  private loaded = new Map<string, ReturnType<SpeechLoader>>();
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly cacheDirectory: string, private readonly loader: SpeechLoader = defaultLoader) {}

  /** Transcriptions run one at a time; the first use downloads the model once. */
  transcribe(samples: Float32Array, options: { model: VoiceModel; language: string }): Promise<{ text: string; language?: string }> {
    const job = this.queue.then(() => this.run(samples, options));
    this.queue = job.catch(() => undefined);
    return job;
  }
  private async run(samples: Float32Array, options: { model: VoiceModel; language: string }): Promise<{ text: string; language?: string }> {
    if (samples.length < VOICE_SAMPLE_RATE / 4) return { text: "" };
    let peak = 0;
    for (let index = 0; index < samples.length; index++) peak = Math.max(peak, Math.abs(samples[index]));
    if (peak < 0.003) return { text: "" };
    const name = VOICE_MODELS[options.model] ?? VOICE_MODELS.base;
    let loading = this.loaded.get(name);
    if (!loading) {
      loading = this.loader(name, this.cacheDirectory);
      this.loaded.set(name, loading);
      loading.catch(() => this.loaded.delete(name));
    }
    const { pipeline, startToken } = await loading;
    const language = options.language && options.language !== "auto" ? options.language
      : await detectLanguage(pipeline, startToken, samples).catch(() => undefined);
    const output = await pipeline(samples, { task: "transcribe", ...(language ? { language } : {}), chunk_length_s: 30, stride_length_s: 5 });
    const text = (Array.isArray(output) ? output.map(item => item.text).join(" ") : output.text).replace(/\s+/g, " ").trim();
    // Whisper emits these placeholders for silence or noise.
    return { text: /^[[(]?\s*(blank_audio|silence|music|inaudible)\s*[\])]?$/i.test(text) ? "" : text, language };
  }
}
