// File: d:\Pawfolio AI\src\lib\vox-soap\voxsoap-ml.wav.ts

/**
 * Phase 5 capture utility for the LOCAL VoxSOAP ML service.
 *
 * The ML contract is HARD: browser audio must arrive as 16 kHz mono PCM WAV
 * (the FastAPI app rejects every other rate with an honest 400 and NEVER
 * resamples server-side — ml-serving/app.py). Resampling therefore lives
 * CLIENT-side:
 *
 *   1. the AudioContext is created with `sampleRate: 16000` so most browsers
 *      deliver native 16 kHz Float32 frames through an AudioWorklet;
 *   2. browsers that cannot be forced to 16 kHz record at the device rate and
 *      the samples are resampled with an OfflineAudioContext BEFORE encoding.
 *
 * The encoder writes a canonical 44-byte PCM WAV header (s16le, mono). Pure
 * functions are exported separately so tests can encode without a mic.
 */

const TARGET_SAMPLE_RATE = 16_000;

export const VOXSOAP_TARGET_SAMPLE_RATE = TARGET_SAMPLE_RATE;

/** Rough deliverable size in bytes for a given duration at 16 kHz s16le mono
 * (32,000 B/s — the same math the panel uses for its size guard). */
export function pcm16kBytesForSeconds(seconds: number): number {
  return Math.max(0, Math.round(seconds * TARGET_SAMPLE_RATE * 2));
}

export function pcm16kSecondsForBytes(bytes: number): number {
  return bytes / (TARGET_SAMPLE_RATE * 2);
}

/** Encodes accumulated Float32 sample chunks as 16-bit PCM mono WAV. */
export function encodeWavMono16(chunks: Float32Array[], sampleRate: number): Blob {
  let frames = 0;
  for (const chunk of chunks) frames += chunk.length;
  const dataBytes = frames * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // audio format: PCM
  view.setUint16(22, 1, true); // channels: mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);
  let offset = 44;
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i += 1) {
      const sample = Math.max(-1, Math.min(1, chunk[i]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

function mergeChunks(chunks: Float32Array[]): Float32Array {
  let frames = 0;
  for (const chunk of chunks) frames += chunk.length;
  const merged = new Float32Array(frames);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

export interface Pcm16CaptureHandle {
  /** Actual rate of the capture context — 16 kHz when the browser honoured
   * the forced rate, otherwise the device rate (resampled before upload). */
  readonly contextSampleRate: number;
  setPaused: (paused: boolean) => void;
  /** Stops capture, resamples if needed, and returns the 16 kHz PCM WAV.
   * Throws honestly (no fabricated silence) when nothing was captured. */
  stop: () => Promise<Blob>;
  /** Drops everything and releases the AudioContext (mic tracks live in the
   * caller's MediaStream, same as the Gemini-flow panels). */
  cancel: () => void;
}

/** Starts capturing `stream` as Float32 chunks via the pcm-recorder worklet.
 * Caller owns the MediaStream lifecycle. */
export async function startPcm16Capture(stream: MediaStream): Promise<Pcm16CaptureHandle> {
  if (typeof window === 'undefined') {
    throw new Error('Microphone capture is a browser-only API.');
  }
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) {
    throw new Error('The Web Audio API is unavailable in this browser.');
  }

  let context: AudioContext;
  try {
    context = new Ctor({ sampleRate: TARGET_SAMPLE_RATE });
  } catch {
    // Some engines reject forced rates outright — record at the device rate;
    // the stop() path resamples to 16 kHz before encoding.
    context = new Ctor();
  }
  if (context.state === 'suspended') {
    await context.resume().catch(() => undefined);
  }
  await context.audioWorklet.addModule('/worklets/pcm-recorder.js');

  const source = context.createMediaStreamSource(stream);
  const worklet = new AudioWorkletNode(context, 'pcm-recorder');
  // Zero-gain tap into the destination keeps the pull-chain alive across
  // engines while guaranteeing no monitoring echo leaves the machine.
  const muter = context.createGain();
  muter.gain.value = 0;

  const chunks: Float32Array[] = [];
  let paused = false;
  let stopped = false;

  worklet.port.onmessage = (event: MessageEvent) => {
    if (stopped || paused) return;
    const data = event.data;
    if (data instanceof ArrayBuffer && data.byteLength > 0) {
      chunks.push(new Float32Array(data));
    }
  };

  source.connect(worklet);
  worklet.connect(muter);
  muter.connect(context.destination);

  const teardown = () => {
    stopped = true;
    try {
      source.disconnect(worklet);
      worklet.disconnect(muter);
      muter.disconnect(context.destination);
    } catch {
      // Graph already torn down by close() — non-fatal.
    }
    void context.close().catch(() => undefined);
  };

  const encode = async (): Promise<Blob> => {
    const deviceRate = context.sampleRate;
    if (chunks.length === 0) {
      throw new Error('No audio samples were captured — nothing was uploaded, nothing invented.');
    }
    if (deviceRate === TARGET_SAMPLE_RATE) {
      return encodeWavMono16(chunks, TARGET_SAMPLE_RATE);
    }
    // Browser could not deliver native 16 kHz: resample CLIENT-side via an
    // OfflineAudioContext (the ML service contract stays untouched).
    const merged = mergeChunks(chunks);
    const frameCount = Math.max(1, Math.ceil((merged.length / deviceRate) * TARGET_SAMPLE_RATE));
    const offline = new OfflineAudioContext(1, frameCount, TARGET_SAMPLE_RATE);
    const audioBuffer = offline.createBuffer(1, merged.length, deviceRate);
    // copyToChannel's exact Float32Array<ArrayBuffer> typing fights with the
    // BufferLike default — .set() is equivalent and type-clean here.
    audioBuffer.getChannelData(0).set(merged);
    const bufferSource = offline.createBufferSource();
    bufferSource.buffer = audioBuffer;
    bufferSource.connect(offline.destination);
    bufferSource.start();
    const rendered = await offline.startRendering();
    return encodeWavMono16([rendered.getChannelData(0)], TARGET_SAMPLE_RATE);
  };

  return {
    get contextSampleRate() {
      return context.sampleRate;
    },
    setPaused(nextPaused: boolean) {
      paused = Boolean(nextPaused);
    },
    stop: async () => {
      const blob = await encode();
      teardown();
      return blob;
    },
    cancel: () => teardown(),
  };
}
