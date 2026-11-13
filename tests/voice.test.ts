import { describe, expect, it, vi } from "vitest";
import { commandSchema } from "../src/main/ipc/schema";
import { decodePcm16, VoiceTranscriber, type SpeechPipeline } from "../src/main/voice";

const tone = (seconds = 1) => Float32Array.from({ length: 16_000 * seconds }, (_, index) => 0.2 * Math.sin(index / 5));

function fakePipeline(text: string, winner: string) {
  const tokens = new Map([["<|startoftranscript|>", 0], ["<|en|>", 1], ["<|fr|>", 2], ["<|nocaptions|>", 3]]);
  const calls: Record<string, unknown>[] = [];
  const asr = Object.assign(async (_audio: Float32Array, options: Record<string, unknown>) => { calls.push(options); return { text }; }, {
    tokenizer: { model: { tokens_to_ids: tokens } },
    processor: async () => ({ input_features: "features" }),
    model: async () => {
      const data = [0, 0, 0, 0];
      data[tokens.get(winner)!] = 5;
      data[3] = 9;
      return { logits: { data, dims: [1, 1, 4] } };
    }
  }) as unknown as SpeechPipeline;
  return { asr, calls };
}

describe("voice instructions", () => {
  it("decodes 16-bit PCM", () => {
    const bytes = Buffer.alloc(4);
    bytes.writeInt16LE(16384, 0); bytes.writeInt16LE(-32768, 2);
    expect([...decodePcm16(bytes.toString("base64"))]).toEqual([0.5, -1]);
  });

  it("detects the spoken language and loads the model once", async () => {
    const { asr, calls } = fakePipeline("  Bonjour   Hamet ", "<|fr|>");
    const loader = vi.fn(async () => ({ pipeline: asr, startToken: (id: number) => id }));
    const voice = new VoiceTranscriber("cache", loader);
    expect(await voice.transcribe(tone(), { model: "base", language: "auto" })).toEqual({ text: "Bonjour Hamet", language: "fr" });
    expect(calls[0]).toMatchObject({ task: "transcribe", language: "fr" });
    await voice.transcribe(tone(), { model: "base", language: "en" });
    expect(calls[1]).toMatchObject({ language: "en" });
    expect(loader).toHaveBeenCalledTimes(1);
    expect(loader).toHaveBeenCalledWith("onnx-community/whisper-base", "cache");
  });

  it("skips silence and Whisper placeholders without loading a model", async () => {
    const { asr } = fakePipeline("[BLANK_AUDIO]", "<|en|>");
    const loader = vi.fn(async () => ({ pipeline: asr, startToken: (id: number) => id }));
    const voice = new VoiceTranscriber("cache", loader);
    expect(await voice.transcribe(new Float32Array(16_000), { model: "base", language: "auto" })).toEqual({ text: "" });
    expect(await voice.transcribe(tone().subarray(0, 1000), { model: "base", language: "auto" })).toEqual({ text: "" });
    expect(loader).not.toHaveBeenCalled();
    expect((await voice.transcribe(tone(), { model: "small", language: "auto" })).text).toBe("");
    expect(loader).toHaveBeenCalledWith("onnx-community/whisper-small", "cache");
  });

  it("rejects malformed audio payloads", () => {
    expect(commandSchema.safeParse({ type: "voice.transcribe", audio: "AAAA" }).success).toBe(true);
    expect(commandSchema.safeParse({ type: "voice.transcribe", audio: "not base64!" }).success).toBe(false);
    expect(commandSchema.safeParse({ type: "voice.transcribe", audio: "" }).success).toBe(false);
  });
});
