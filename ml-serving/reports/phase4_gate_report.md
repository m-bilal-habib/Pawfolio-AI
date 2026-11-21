# Phase 4 Gate Report — VoxSOAP ML serving (real-inference gate)

**Where it ran:** owner's Colab Tesla T4 runtime (`torch 2.11.0+cu130`), the serving code shipped as
`ML_SERVING_UPLOAD.zip` (17 entries, hash-verified) against the unpacked full-scale gate-run adapters
(`unpacked_voxsoap_ml_exports_20261030-165202`, `model_scale: "full"` in both training manifests).
**When:** 2026-10-30.
**Verdict: Phase 4 SERVING GATE PASSED — `pytest -m real` 4/4 PASSED plus four live endpoint probes all 200 OK.**

## 1. Gate evidence (owner-collected, validated against the contract envelopes)

### 1.1 Real-marker pytest suite — 4/4 PASSED

| Test | What it proves live |
|---|---|
| `test_real_health_reports_unloaded_real_components` | the real `MLProvider` object introspects the FULL-SCALE adapter dirs and reports `adapter_files_present: true` without loading any model |
| `test_real_transcribe_with_phase2_adapter` | real Whisper-small + the FULL Urdu LoRA adapter runs end-to-end over a 16 kHz PCM WAV through `POST /transcribe` (`serving_mode: "real-provider"`, `model_scale: FULL`) |
| `test_real_roman_stays_501_until_model_c_lands` | `/roman` answers the honest **501** — Model C is DEPRECATED; nothing silently substituted |
| `test_real_draft_with_fullscale_adapter` | real Qwen 2.5-3B + the FULL SOAP QLoRA adapter generates a draft through `POST /draft` (the regression test for the drift caught below) |

### 1.2 Live FastAPI endpoint probes — all 200 OK

| Probe | Result |
|---|---|
| `GET /health` | 200 OK — `asr: FULL`, `soap: FULL` (labels resolved from the training manifests, source `training_manifest.model_scale`); lazy-loading confirmed (probe loads nothing) |
| `POST /transcribe` | 200 OK — real Whisper Urdu ASR adapter inference through the exact envelope (`provider`/`serving_mode`/`model_scale`/`latency_s`) |
| `POST /draft` | 200 OK — real Qwen 2.5-3B + full SOAP adapter produced a complete SOAP note with the deterministic `guard` annotations attached (`schema.sections_present` / `facts.unsupported_*` / `omitted_*` / `unstated_markers` — guard annotations are NOT a verdict) |
| `POST /unload` | 200 OK — RAM/GPU freed; `model_scale_after` introspection still honest |

## 2. Chronology kept honestly — the gate that caught the bug

| Attempt | Stack | Result |
|---|---|---|
| 1 (2026-10-30, unpinned) | `transformers>=4.44` resolved to the newest release (beyond the verified 4.48.3) | `pytest -m real` 3/3 PASSED (42.61 s); live `POST /draft` **CRASHED**: `KeyError: 'shape'` from `BatchEncoding.__getattr__` — newer transformers return a mapping from `apply_chat_template(..., return_tensors="pt")` where 4.48.3 returned a raw tensor; the raw exception also escaped as an uncontrolled 500 |
| Fix (commit `6a07ed8`) | — | explicit `return_dict=True` + `_unwrap_chat_prompt()` accepting BOTH shapes; `attention_mask` passed when present; all three ML inference bodies wrapped as controlled `InferenceError` → 503; `dtype`/`torch_dtype` chosen by installed version; `clean_up_tokenization_spaces=True` pinned (frozen to the verified eval default); **NEW `requirements-serving-ml.txt`** (exact pins: torch 2.11.0, transformers 4.48.3, peft 0.18.1, accelerate 1.3.0, soundfile 0.13.1, bitsandbytes 0.49.2, numpy `<3`); 4th real test added |
| 2 (2026-10-30, pinned) | `requirements-serving.txt` + `requirements-serving-ml.txt` | **`pytest -m real` 4/4 PASSED + all four live probes 200 OK** — the documented gate clean |

Mocked contract suite on the same commit: **24 passed / 0 skipped / 4 real-deselected**; content checker 48/48; pyflakes 0 undefined names.

## 3. Integrity chain

- Adapter weights SHA-256 (verify before any serving load; recorded in `ml-training/reports/phase3_gate_report.md`):
  - `asr/whisper-lora-ur-20261030-165202/adapter_model.safetensors` → `3376A373D7BE707FE9BFC73A6646B6B0803C8399233C973148E6F53A54144104`
  - `soap/soap-lora-20261030-165202/adapter_model.safetensors` → `B67FA916AED21BCCE5FCBA167B3A5498525E967D49CD155CB8696A453598CCF7`
- Serving defaults point at the unpacked 20261030-165202 export (`config._FULLSCALE_ARTIFACTS`); base ids/revisions (`openai/whisper-small@main`, `Qwen/Qwen2.5-3B-Instruct@main`) validated at load by the adapter-not-a-model rule.
- Repository state at gate: commit `6a07ed8` on `Speech-to-Text-feature/voxsoap-model-integration`.

## 4. Not claimed / honest limitations

- **This is still the Phase-4 scaffold, not a production deployment.** No auth/TLS/HTTPS, no worker isolation, no rate limiting; the Next.js proxy + UI integration is Phase 5.
- **Clinical validation is still open:** the 90-case Phase-3 review sheet awaits veterinarian scoring; guard annotations and SOAP metrics are heuristic signals, never a clinical verdict (A8.3/A11.3).
- **`/roman` stays 501** by the recorded Model C deprecation (runs 9/10/11 failed; pivot options documented).
- **Windows-local real inference is still untested** (only 32-bit interpreters installed): the local gate requires the 64-bit 3.12 venv (Phase-5 plan step 1). The SOAP 3B base loads plain fp32 on CPU (~12-13 GB RAM) there — the real `/draft` test skip-guards this honestly.
- ASR transcription is single-window (long-clip windowing not implemented — noted in the envelope); `emotion_card`/preserve-terms extension points empty by design.
- No clinician-grade logging/audit trail persisted inside the service yet (Phase-5 concern).

## 5. Gate decision inputs

- Live-latency + correctness evidence on the real stack ✓ (§1), bug caught-and-fixed with a regression test locked into the suite ✓ (§2), artifacts verified with SHA-256 chain ✓ (§3), unexecuted/limited areas labeled ✓ (§4). Phase 4 is closed at the serving-layer gate; **Phase 5 (Next.js integration) is the next plan of record** — see `ml-serving/reports/phase5_integration_plan.md`.
