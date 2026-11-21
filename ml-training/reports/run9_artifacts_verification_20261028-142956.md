# Run 9 artifact verification - `20261028-142956` (Sections A + B)

Verified locally on 2026-10-28. Verdict per component; nothing below is
inferred beyond the files shown.

## 1. Upload integrity

- `ML_TRAINING_UPLOAD.zip` (rebuilt per instructions): all **9 scripts are
  byte-identical (SHA-256 MATCH)** to the repo versions, including the two new
  Model C files; notebook `voxsoap_ml_training.ipynb` (21 cells) present; zip
  uses forward-slash separators (no fixer cell required).
- Cosmetic flaw: the zip carries `scripts/__pycache__/*.pyc` (Windows build
  step picked them up). Harmless for Colab; exclude `__pycache__` next time.

## 2. Export archives

- `voxsoap_ml_exports_20261028-142956 Section A.zip` (38 entries) and
  `Section B.zip` (52 entries): forward slashes, both parse cleanly. Section B
  (superset) extracted to
  `ml-training/artifacts/unpacked_voxsoap_ml_exports_20261028-142956/`.

### Training manifests (all `executed: true`, `model_scale: "full"`)

| Component | Base | LoRA | Epochs | train/val rows | notes |
| --- | --- | --- | --- | --- | --- |
| ASR | openai/whisper-small @ main | r=16 q,k,v,o | 3 | 1500 / 260 | 1200 ur + 300 en (as specified) |
| SOAP | Qwen/Qwen2.5-3B-Instruct @ main | r=16 q,k,v,o QLoRA nf4 | 2 | 400 / 40 | assistant-only loss ✓ |
| Roman (Model C) | google/mt5-small @ main | r=16 q,v | 3 | 2000 / 120 | task_prefix recorded ✓ |

Roman prep (streaming, approved caps): 2000 / 120 / 80 pairs stored - the
official test split yielded only 80 usable pairs under the 300 cap. `n_pairs
80` in the eval is honest, not truncated silently.

## 3. Component verdicts

### ASR - PASS (measured, general-domain)
Stage 10, same 25-row val slice: base WER **0.4048 -> adapter 0.3733**, CER
0.1500 -> 0.1318, numbers lost 5 -> 2. Honest limitation recorded: general
FLEURS refs do not prove veterinary accuracy; vet benchmark (A8.3) still
outstanding.

### SOAP - PASS on pipeline, quality frontier unchanged
Stage 13: **`missing_drafts: 0`** (the run-7/8 coverage mismatch is fixed),
schema_ok_rate **1.0** across evaluated cases; `cases_with_unsupported_facts`
47/60, `cases_with_omitted_facts` 38/60 - the deterministic-guard frontier
documented in earlier runs. **Evaluation gap found**: Stage 13 passed no
`--max-cases`, so the default cap evaluated only 60 of the 100 generated
drafts. Fixed in the notebook (`--max-cases = SOAP_TEST`); run 10 can re-run
Stage 13 on the existing drafts file (no retraining needed for that stage).

### Roman Urdu (Model C) - FAIL, not servable
Stage 14c: exact_match_norm **0.0**, exact_match_raw 0.0, CER **0.9142** with
**every one of the 20 review rows predicting exactly `<extra_id_0>`** - the
mT5 span-corruption sentinel (the saved tokenizer does not mark `<extra_id_*`
as special, so it survives `skip_special_tokens` and is visible verbatim).
The adapter learned nothing usable.

Also: timeline anomaly in the package - roman eval measured_at 16:28:55Z but
roman trained_at 16:39:08Z, i.e. the packaged eval predates the final training
run. Cause not determinable from artifacts alone; keep Stage 14b + 14c
sequenced in ONE session.

**Remediation applied (code, run-10 prep):**
- `train_transliteration_lora.py` now trains in **pure fp32** (T5/mt5 family
  is officially not fp16-tested; run-9 evidence recorded), LR default
  **1e-4** (was 5e-4), eval every **50 steps**, and a **post-train quality
  probe** (greedy generation on 3 validation rows) recorded as
  `quality_probe` in the manifest, loudly warning on sentinel-collapse.
- Notebook passes `--learning-rate ROMAN_LR`, `--eval-steps ROMAN_EVAL_STEPS`
  (knobs added), and Stage 13 passes `--max-cases`.
- Content battery: checker 29/29 PASS; 20/20 cells + 9 scripts compile;
  mocked serving suite 24/24 (real tests still honestly gated).

`/roman` in serving stays 501 until a Model C adapter passes its eval.

## 4. Ledger snapshot

18 stages OK through 14c + 16 + 17; Stage 15 shows `RUNNING` inside the
packaged `run_manifest.json` (the manifest is written mid-export; cosmetic).

## 5. Serving status

- `ml-serving` defaults retargeted to the run-9 ASR + SOAP adapters;
  `VoxSOAP` health will now report `model_scale=FULL` for ASR/SOAP and
  `UNKNOWN` for Roman (unconfigured by design).
- Mocked contract suite re-run green: **24 passed**.
- REAL inference gate remains blocked locally: the machine still has only
  32-bit interpreters (3.15-32, 2.7-32); no torch win32 wheels exist. The
  gate must run on 64-bit Python (install) or Colab.

## 6. Next actions (user)

1. Run 10, Session A (Roman only): re-zip `ML_TRAINING_UPLOAD.zip` from the
   updated `ml-training` (EXCLUDE `__pycache__`), re-upload the notebook, set
   `RUN_ASR=False, RUN_SOAP=False, RUN_MODEL_C=True`, run all cells, and -
   in the SAME session, since the timeline anomaly showed a split hazard -
   let Stage 14b + 14c finish together. Paste Stage 14b's stdout (esp.
   `[SMOKE-OK]`, eval losses every 50 steps, and `[QUALITY-PROBE]`).
2. Optional cheap re-run in the same session: Stage 13 alone will still need
   drafts if `soap_test_drafts.jsonl` is absent in a fresh runtime (drafts
   are produced by Stage 12) - do the SOAP re-eval only if SOAP is kept as-is.
3. If Model C probe passes, Servable Roman requires a serving-config pointer
   to the NEW adapter dir + real-gate run.
4. Real serving gate: 64-bit Python + torch, or a Colab serving-check.
