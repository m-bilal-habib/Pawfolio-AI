# Phase 3 Gate Report — VoxSOAP ML (feature/voxsoap-model-integration.md §15)

**Run:** `20261030-165202` (Colab Tesla T4, free tier; toggles `RUN_ASR=True`, `RUN_SOAP=True`, `RUN_MODEL_C=False`) — 15 stages OK, 3 SKIPPED(toggle), 0 FAILED, 0 NOT RUN.
**Artifact package:** `D:\Pawfolio AI\ml-training\artifacts\voxsoap_ml_exports_20261030-165202.zip` (41,462.6 KB, 40 entries) — downloaded by the owner, extracted and verified locally on 2026-10-30; zips/adapters stay untracked in git per the never-commit-rules.
**Gate text (§15):** "Verify GPU, load small samples using streaming where available, decode audio, validate text records, and save a small artifact/metrics report … show actual logs, data counts, environment versions, and successful export path. Clearly label unexecuted stages."
**Verdict: Phase 3 SATISFIED at full scale for ASR and SOAP — the phase-2 smoke limitations (0-claim on quality, missing-draft coverage gap) were addressed with measurable wins, AND every clinical caveat from Phase 2 still stands (see §6).**

## 1. Environment and stack (Stages 1–2)

| Item | Value |
|---|---|
| Runtime | Colab: Python 3.13, torch 2.11.0+cu130, Tesla T4 14.56 GB (both training manifests record `gpu.device_name: "Tesla T4"`) |
| Fail-fast | Stages 1/2 run with `abort=True` (run-11 CPU-runtime lesson: a no-GPU session costs ~2 s, never 37 min) |
| Runtime-owned guards | torchao absent pre-peft; protobuf never pinned; `USE_TF=0`, `USE_FLAX=0` |

Recorded source: `reports/environment_versions_20261030-165202.json` (verified in zip).

## 2. ASR gate evidence — Whisper Urdu full scale

- **Training (Stage 9):** 1,500 train rows (1,200 `ur_pk` + 300 `en_us`) / 260 validation, 3 epochs, `train_runtime 818.7 s`, LoRA r=16 on q/k/v/o (2,654,208 trainable = 1.0861%), `eval_steps=50` fired 10×. fp16 forward+backward smoke-checked before the loop. `train_loss 0.7824`, first-recorded loss 1.6632 → final 0.6016.
- **Stage 8 → Stage 10 (same 25 held-out Urdu rows, same normalization; both evals reported `executed: true`):**

| Metric | Base (Stage 8) | Phase-2 smoke tuned | **Phase-3 full-scale tuned (Stage 10)** | Δ vs base |
|---|---|---|---|---|
| WER | 0.4048 | 0.4018 | **0.3733** | **−0.0315 absolute (−7.8% relative)** |
| CER | 0.1500 | 0.1474 | **0.1350** | **−0.0150 absolute** |
| number_lost | 5 | 5 | **2** | **5 → 2** |
| mean latency s/clip | 0.9153 | 1.42 | 1.822 | (adapter overhead in eval loop; 4.565 audio-min/25 rows; device `cuda`) |

- **Honest reading:** unlike Phase-2's −0.003 non-delta, the full-scale run moves WER, CER **and** number preservation, consistent with 8.3× the data and LoRA widened r=8→16. BUT: 25 general-domain rows remain a light slice, and `number_lost 2/25` is still not 0. The limitation field ships inside both eval JSONs: general-domain refs (e.g. FLEURS) do not validate veterinary meds/jargon — the veterinary benchmark (A8.3) is still the decisive gate and is still pending.

## 3. SOAP gate evidence — Qwen 2.5-3B QLoRA full scale

- **Training (Stage 12):** 400 train rows / 40 validation, 2 epochs, `train_runtime 1271.4 s`, `max_seq_tokens 1024`, assistant-token-only loss (325,588 prompt tokens masked, 0 rejected rows), QLoRA NF4 fp16-compute. `train_loss 0.6839`; **eval_loss improved 0.6334 (ep 1) → 0.6040 (ep 2)** — a validation-backed improvement, not just a training-curve claim.
- **Draft generation:** drafts for **ALL 90 preserved test rows** at `max_new_tokens=512` (per-row timed prints). `[STAGE-12-OK] drafts generated for 90 test rows`. Note: the `SOAP_TEST` knob caps at 100; the official split yielded 90 rows after prep filters — 90/90 coverage is complete against what the prep actually produced, so the run-9/phase-2 coverage gap class is closed.
- **Stage 13 (both report JSONs cross-checked against the pasted logs):**

| Signal | Phase-2 smoke | **Phase-3 full scale** | Honest comparison |
|---|---|---|---|
| n_cases / n_evaluated | 40 / 20 (drafts covered 20 of 40) | **90 / 90** | the known `missing_drafts` mismatch is fixed: **missing_drafts 0** |
| schema_ok_rate | 0.85 (17/20) | **1.0 (90/90)** | structural reliability improved AND held at 8× the sample size |
| cases_with_unsupported_facts | 8/20 (40%) | 73/90 (81.1%) | NOT directly comparable as a rate: longer drafts at a 512-token cap give the token-lexical heuristic more sentences to flag, and the training source (`Tushar9802/medscribe-soap-712`, human medical) is explicitly NOT veterinary-validated. Recorded as measured, no spin. |
| cases_with_omitted_facts | 15/20 (75%) | 63/90 (70%) | same caution; per-case columns (`retained_facts` / `omitted_facts`) shipped in the eval JSON |
| review sheet | 20 blank rows | **`soap_review_sheet_20261030-165202.csv` — blank reviewer columns, ready for the veterinarian** | automated numbers are NOT a clinical verdict (A8.3/A11.3) |

## 4. Roman Urdu (Model C) — DEPRECATED, honestly skipped

Stages 14/14b/14c report `SKIPPED(toggle)` with the ledger text `RUN_MODEL_C=False (DEPRECATED run-11: experimental/unsolved - runs 9/10/11 eval failed)`. Three recipes failed measured quality (CER 0.9142 / 6.1456 / 6.8905; exact_match 0.0) — full history and pivot options (rule-based normalization, byt5-small char-mapping): `ml-training/reports/model_c_deprecation_20261029.md`. Model C is explicitly NOT part of this gate's satisfied scope, never blocks Phase 3/4, and serving keeps `/roman` at an honest 501.

## 5. Artifact package verification (on disk, 2026-10-30)

- Zip verification: 40 entries, **0** backslash-path entries, **0** `__pycache__` entries.
- Extracted to `ml-training/artifacts/unpacked_voxsoap_ml_exports_20261030-165202/` (40 files).
- Integrity: every manifest declares `executed: true` with exact base checkpoint id+revision

| Artifact | Contents verified |
|---|---|
| `asr/whisper-lora-ur-20261030-165202/` (14 entries) | adapter_model.safetensors (10,397.6 KB), adapter_config (r=16, q/k/v/o, alpha 32), full whisper processor/tokenizer set, training_manifest (`model_scale: "full"`, train_rows 1500, val_rows 260, epochs 3, T4, torch 2.11.0+cu130) |
| `soap/soap-lora-20261030-165202/` (12 entries) | adapter_model.safetensors (28,837.6 KB), adapter_config (r=16), tokenizer/merges/vocab, training_manifest (`model_scale: "full"`, QLoRA quantization block, train_rows 400, assistant-only-loss objective, T4) |
| `reports/` (12) | asr base+adapter eval, soap_eval (90 per-case rows), review sheet CSV, asr_prep, data_manifest_runtime, environment_versions, disk, sample_fields, audio_decode |
| root | run_manifest.json (stage ledger + CONFIG_KNOBS + seeds — snapshot written mid-Stage-15 so stage-15 shows RUNNING there; the Stage-17 pasted ledger, 15 ok / 3 skipped, is the authoritative final state), model_card_notes.md, soap data + prep report + drafts |

- Eval JSONs re-read from the unpacked export and matched against the owner's pasted stage output exactly (ASR base/tuned tables above; SOAP overall counts `n_cases 90, n_evaluated 90, missing_drafts 0, schema_ok_rate 1.0, unsupported 73, omitted 63`).

SHA-256 (adapter-not-a-model; verify before any serving load):

```
voxsoap_ml_exports_20261030-165202.zip         8087EC4BE77082292AEF4B1878D6F16E127C42A0F6C817CE7049F60BB722176B
asr/whisper-lora-ur-20261030-165202/adapter_model.safetensors
                                               3376A373D7BE707FE9BFC73A6646B6B0803C8399233C973148E6F53A54144104
soap/soap-lora-20261030-165202/adapter_model.safetensors
                                               B67FA916AED21BCCE5FCBA167B3A5498525E967D49CD155CB8696A453598CCF7
```

## 6. Unexecuted / not claimed (honest labeling)

- **Clinical quality / veterinary validation:** NOT claimed. The vet benchmark (A8.3) is still pending; general-domain ASR WER and token-lexical SOAP signals are pipeline artifacts, not clinical verdicts. The 90-case review sheet must be filled by the veterinarian before any reliance.
- **Real inference:** NOT EXECUTED on this machine yet (32-bit Pythons only; the mock suite is fully green, real gate pending — see ml-serving/README "Real-inference gate status").
- **Phase 5 Next.js integration:** NOT EXECUTED.
- **Roman Urdu normalization:** DEPRECATED/UNSOLVED — not a Phase-3 component; 501 in serving.
- **`soap_test_drafts.jsonl`, `soap_train/validation/test.jsonl`** ship inside the archive (data files — never git-committed).
- **Gated datasets unchanged:** still 0 rows consumed from the permission/license-blocked sources.
- **ASR train includes 300 `en_us` rows** (new vs Phase-2's ur_pk-only store): stage-6 decode counters cover it; the 25-row Stage-10 eval slice is Urdu general-domain, so the reported Urdu metrics are not confounded by those rows — but no English ASR quality claim is made.

## 7. Gate decision inputs for §15 approval

- Actual logs ✓ (stage ledger pasted in run session; run_manifest + environment/disk/sample/audio reports in zip), data counts ✓ (asr_prep + soap_prep reports + eval JSONs), environment versions ✓ (§1), successful export path ✓ (zip verified + unpacked + hash-recorded on disk), unexecuted stages labeled ✓ (§4/§6), serving retargeted ✓ (`ml-serving` defaults point at this run; mocked suite 24 passed / 0 skipped / 3 real-deselected).
- Remaining to close out Phase 4→5: the REAL inference gate (64-bit Python or Colab serving check), then the Next.js integration.
