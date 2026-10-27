# Phase 3 prep + Phase 4 serving scaffold - honest status report

Date: 2026-10-27. Branch: `Speech-to-Text-feature/voxsoap-model-integration` (main untouched).

## Phase 3 - full-scale training & evaluation prep (PREP COMPLETE, NOT EXECUTED)

Code and notebook changes only. **No training has run.** All numbers below are
configuration targets for Colab run 9, not results.

- Notebook `voxsoap_ml_training.ipynb` regenerated: 21 cells (20 code), all 20
  compile, 9/9 train/eval scripts compile, argparse cross-check clean.
- Top-level Colab quota toggles: `RUN_ASR` / `RUN_SOAP` / `RUN_MODEL_C` (each
  skipped component is honestly `SKIPPED(toggle)` in the Stage-17 ledger).
- ASR (google/fleurs ur_pk + en_us): caps 1200/200/100 (+ EN 300/60/60),
  Whisper LoRA r=16 on q,k,v,o, 3 epochs, lr 8e-5, warmup 0.05, eval_steps=50
  (eval now actually fires), `--model-scale full` tag recorded in manifest.
- SOAP (Tushar9802/medscribe-soap-712): 400/100/100, 2 epochs,
  max_seq_tokens=1024, drafts generated over ALL 100 test cases at
  max_new_tokens=512 (coverage fix for run-7/8 `missing_drafts`; `0` expected
  at run 9 - 512 tokens addresses the 256-token truncation omissions).
- Model C Roman Urdu (Mavkif/Roman-Urdu-Parl-split): NEW standalone scripts
  `train_transliteration_lora.py` (mT5-small, LoRA r=16 q/v, fp32 masters +
  fp16 AMP) and `evaluate_transliteration.py` (exact-match norm/raw, jiwer CER,
  latency, 20-row BLANK fluent-speaker review CSV, explicit normalization
  rules). Caps 2000/300/300, 3 epochs. Stages 14b/14c added to the notebook.
- Blocked datasets unchanged (0 rows consumed): `omi-health/...` (permission),
  `UmarRamzan/common-voice-urdu-processed` (license review).

## Phase 4 - serving scaffold (CONTRACT-TESTED, REAL INFERENCE GATE OPEN)

New `ml-serving/` FastAPI scaffold; routes `/health`, `/transcribe`,
`/draft`, `/roman` (501 stub until Model C weights), `/unload`.

- Lazy/on-demand loading: process startup loads NO weights; first request per
  component loads it; `POST /unload` frees RAM (Windows safeguard; bnb 4-bit
  is Linux-only, so the Qwen2.5-3B base uses full dtype when loaded).
- Adapter-not-a-model validation: adapter `training_manifest.json` base
  id+revision must match `VOXSOAP_*_BASE_MODEL(_REVISION)` exactly, else the
  load is refused with a controlled 503.
- `model_scale` surfaced in EVERY response (success and error envelope).
  Phase-2 manifests predate the tag: ASR (180 rows) / SOAP (100 rows)
  resolve as `SMOKE(assumed: manifest predates the model_scale tag; small
  train_rows)` - explicit source, nothing fabricated.
- Provider policy: request-level `provider` + `VOXSOAP_DEFAULT_PROVIDER`
  (default `ml`). ML failures are controlled 5xx; the Gemini proxy
  (`VOXSOAP_GEMINI_PROXY_URL`, unset by default) is ONLY used when explicitly
  requested - never as a silent fallback. Gemini unset => honest 501.
- `/draft` attaches the deterministic guard annotations ported from
  `evaluate_soap.py` (section presence, unsupported/omitted numbers and
  medicine tokens, unstated markers). Explicitly NOT a clinical-safety verdict.
- `/transcribe`: 16 kHz PCM WAV accepted (soundfile or stdlib-wave decode);
  other rates => honest 400 (no silent resampling); 25 MB cap.

### Tests executed

- MOCKED (fake providers, clearly labeled `serving_mode="mocked-test-double"`):
  `py -m pytest ml-serving/tests -m "not real"` -> **18/18 PASSED**
  (Python 3.15.1 32-bit; fastapi 0.162.0, pytest 9.1.1, httpx 0.28.1,
  python-multipart 0.0.32 in user site-packages).
- REAL inference: gated behind `pytest.mark.real`; on this machine they
  **skip honestly** (3 skipped) because torch is not importable - the only
  interpreters installed are 32-bit (Python 3.15-32, 2.7-32) and torch
  publishes no win32 wheels. NOT a failure; an honest blocked state.
- Notebook/scripts content checks: run-9 checker 26/26 PASS (toggles, knobs,
  Stage 9/12/14b/14c, guard invariants carried from runs 5-8).

### NOT proven (no claim made)

- Any real ASR/SOAP/Roman inference end-to-end (torch gate above).
- Any training/eval re-run (phase-3 results pending Colab run 9).
- Draft quality, latency under load, production readiness. Phase-5
  replacement of the Gemini path still requires: real inference gate, full
  workflow tests, and evaluation on independent veterinarian-reviewed cases.

## Next user actions

1. Colab run 9: re-upload the regenerated `.ipynb` AND re-zip the payload
   (`ML_TRAINING_UPLOAD.zip` = `ml-training/scripts/*.py`, now 9 scripts
   including the two new Model C files). Use the toggles to split quota
   across sessions if needed.
2. For the real serving gate: install a 64-bit Python (3.11-3.13) with
   torch/CUDA + `requirements-serving.txt`, or run the serving check in
   Colab and copy back the evidence.
