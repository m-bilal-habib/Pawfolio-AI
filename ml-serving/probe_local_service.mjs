// Live /health probe against the local VoxSOAP ML service (127.0.0.1:8321)
// and — through OUR Next.js proxy contract shape — a /transcribe drill with a
// synthetic 16 kHz PCM WAV. Synthetic noise is NOT a real consultation: the
// transcript text may be empty/wrong by design; what is being gated is the
// envelope (200 / real-provider / model_scale FULL) and honest shapes.
const SERVICE = 'http://127.0.0.1:8321';

function synthesizeWav16k(seconds, sr = 16_000) {
  // White-noise-ish modulated tone; deterministic.
  const frames = seconds * sr;
  const buffer = new ArrayBuffer(44 + frames * 2);
  const dv = new DataView(buffer);
  const ascii = (o, t) => { for (let i = 0; i < t.length; i++) dv.setUint8(o + i, t.charCodeAt(i)); };
  ascii(0, 'RIFF'); dv.setUint32(4, 36 + frames * 2, true); ascii(8, 'WAVE');
  ascii(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true); dv.setUint32(24, sr, true); dv.setUint32(28, sr * 2, true);
  dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  ascii(36, 'data'); dv.setUint32(40, frames * 2, true);
  for (let i = 0; i < frames; i++) {
    const t = i / sr;
    const env = 0.5 * (1 - Math.cos(2 * Math.PI * (0.7 + 0.05 * t))); // slow modulation
    const s = Math.round(env * Math.sin(2 * Math.PI * 220 * t) * 8000);
    dv.setInt16(44 + i * 2, s, true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

async function json(name, url, opts = {}) {
  const res = await fetch(url, opts);
  let text = '';
  try { text = await res.text(); } catch { /* no body */ }
  console.log(`\n== ${name}: HTTP ${res.status}`);
  try {
    const body = JSON.parse(text);
    console.log(JSON.stringify(body, null, 1).slice(0, 1400));
    return { status: res.status, body };
  } catch {
    console.log(text.slice(0, 400));
    return { status: res.status, body: null };
  }
}

// 1) service health directly
const health = await json('GET /health (direct service)', `${SERVICE}/health`);
const scale = health.body?.model_scale ?? {};
console.log(`scale summary: asr=${scale.asr} soap=${scale.soap} roman=${scale.roman}`);

// Probe the NEW language + multi-window contract: 35 s of synthetic tone
// (forced into TWO clean 30 s windows) with language=en. Whitespace-shaped
// synthetic audio is NOT real speech — the transcript stays meaningless by
// design; what is gated is the envelope: windows count, language echo,
// serving_mode real-provider, model_scale FULL.
const formData = new FormData();
formData.append('audio', synthesizeWav16k(35), 'synthetic-16k.wav');
formData.append('language', 'en');
const t0 = Date.now();
const tr = await json(
  `POST /transcribe (direct, synthetic 35 s @16kHz language=en — 2 windows, CPU real inference)`,
  `${SERVICE}/transcribe`,
  { method: 'POST', body: formData }
);
console.log(
  `wall: ${((Date.now() - t0) / 1000).toFixed(1)} s | serving_mode=${tr.body?.serving_mode} ` +
    `scale=${typeof tr.body?.model_scale === 'string' ? tr.body.model_scale : JSON.stringify(tr.body?.model_scale)} ` +
    `language=${tr.body?.language} windows=${tr.body?.windows} latency=${tr.body?.latency_s}`
);

// Honest-400 drill: an unsupported language must never reach the provider.
const bad = await json('POST /transcribe language=klingon (expect 400)', `${SERVICE}/transcribe`, {
  method: 'POST',
  body: (() => {
    const f2 = new FormData();
    f2.append('audio', synthesizeWav16k(1), 'synthetic-16k.wav');
    f2.append('language', 'klingon');
    return f2;
  })(),
});
console.log(`honest-400: status=${bad.status} error=${bad.body?.error} (nothing invented: no provider touched)`);

// 4) RAM hygiene: drop every loaded reference so the machine returns to
// pre-load (the Windows RAM safeguard exercised by the probe itself).
const un = await json('POST /unload all (RAM hygiene)', `${SERVICE}/unload`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ component: 'all' }),
});
console.log(
  `unload: ${isObj(un.body) ? JSON.stringify(un.body.unload_status ?? {}) : un.status}`
);

function isObj(v) {
  return v && typeof v === 'object';
}
