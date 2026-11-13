import { useEffect, useRef, useState } from "react";
import { LoaderCircle, Mic, Square } from "lucide-react";
import type { Command, CommandResult } from "../shared/contracts";

type Run = (command: Command, success?: string, onError?: (text: string) => void) => Promise<CommandResult | undefined>;
const SAMPLE_RATE = 16_000;
const MAX_SECONDS = 15 * 60;

/** Mono 16 kHz 16-bit PCM, base64-encoded for the local Whisper transcriber. */
export function encodePcm16(samples: Float32Array): string {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < samples.length; index++) {
    const value = Math.max(-1, Math.min(1, samples[index]));
    view.setInt16(index * 2, value < 0 ? value * 0x8000 : value * 0x7fff, true);
  }
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

/** Records a spoken instruction and transcribes it on this computer (no audio leaves the machine). */
export function VoiceButton({ run, disabled, autoSend, onTranscript, onError }: {
  run: Run; disabled?: boolean; autoSend?: boolean; onTranscript: (text: string) => void; onError: (text: string) => void;
}) {
  const [state, setState] = useState<"idle" | "recording" | "transcribing">("idle");
  const [seconds, setSeconds] = useState(0);
  const recorder = useRef<MediaRecorder | undefined>(undefined);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => { window.clearInterval(timer.current); recorder.current?.stream.getTracks().forEach(track => track.stop()); }, []);

  const transcribe = async (blob: Blob) => {
    setState("transcribing");
    try {
      const context = new AudioContext({ sampleRate: SAMPLE_RATE });
      const audio = await context.decodeAudioData(await blob.arrayBuffer()).finally(() => void context.close());
      const result = await run({ type: "voice.transcribe", audio: encodePcm16(audio.getChannelData(0)) }, undefined, onError);
      if (result?.transcript) onTranscript(result.transcript);
      else if (result) onError(result.message ?? "No speech was recognized.");
    } catch { onError("The recording could not be transcribed. Try again."); }
    finally { setState("idle"); }
  };
  const start = async () => {
    let stream: MediaStream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } }); }
    catch { onError("Microphone unavailable. Allow Relay Desk to use the microphone in your system privacy settings."); return; }
    const chunks: Blob[] = [];
    const media = new MediaRecorder(stream);
    media.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
    media.onstop = () => {
      window.clearInterval(timer.current);
      stream.getTracks().forEach(track => track.stop());
      void transcribe(new Blob(chunks, { type: media.mimeType }));
    };
    recorder.current = media;
    media.start(1000);
    setSeconds(0); setState("recording");
    const began = Date.now();
    timer.current = window.setInterval(() => {
      const elapsed = Math.floor((Date.now() - began) / 1000);
      setSeconds(elapsed);
      if (elapsed >= MAX_SECONDS && media.state === "recording") media.stop();
    }, 500);
  };
  const stop = () => { if (recorder.current?.state === "recording") recorder.current.stop(); };

  if (state === "transcribing")
    return <button type="button" className="voice-button busy" disabled title="Transcribing on this computer (the first use downloads the speech model once)…" aria-label="Transcribing">
      <LoaderCircle size={16} className="spin"/><span>Transcribing…</span></button>;
  if (state === "recording")
    return <button type="button" className="voice-button recording" onClick={stop} title="Stop and transcribe" aria-label="Stop recording">
      <Square size={13}/><span>{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}</span></button>;
  return <button type="button" className="voice-button" disabled={disabled} onClick={() => void start()} aria-label="Speak an instruction"
    title={autoSend ? "Speak an instruction: transcribed on this computer, then sent" : "Speak an instruction: transcribed on this computer into the message box"}><Mic size={16}/></button>;
}
