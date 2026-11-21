# Phase 2 Gate Report — VoxSOAP ML (feature/voxsoap-model-integration.md §15)

**Run:** `20261027-181112` (Colab Tesla T4, free tier) — first full 16/16 OK run, 0 skipped, 0 failed.
**Artifact package:** `D:\Pawfolio AI\ml-training\artifacts\voxsoap_ml_exports_20261027-181112.zip` (35,340,370 bytes, 41 entries) — extracted and verified locally on 2026-10-27; zip stays untracked in git per the never-commit-rules.
**Gate text (§15):** "Verify GPU, load small samples using streaming where available, decode audio, validate text records, and save a small artifact/metrics report … show actual logs, data counts, environment versions, and successful export path. Clearly label unexecuted stages."
**Verdict: Phase 2 SATISFIED — pipeline proven end-to-end at smoke scale. This is NOT a claim of model quality or clinical safety.**

## 1. Environment and stack (Stages 1–2)

| Item | Value |
|---|---|
| Runtime | Colab: Python 3.13.16, torch 2.11.0+cu130, Tesla T4 14.56 GB |
| Pins | all 10 verified (transformers 4.48.3, datasets 3.3.2, accelerate 1.3.0, peft 0.18.1, evaluate 0.4.3, jiwer 3.1.0, librosa 0.10.2.post1, soundfile 0.13.1, sentencepiece 0.2.1, bitsandbytes 0.49.2) |
| Runtime-owned | torchao uninstalled pre-peft; protobuf left at Colab's preinstalled 6.33.6 — never pinned (run-5 lesson); `USE_TF=0`, `USE_FLAX=0` recorded in the env report |

Recorded source: `reports/environment_versions_20261027-181112.json` (verified in zip).

## 2. ASR gate evidence (Stages 7–10)

- **Prep accounting (§7.3.7 run-6 mandate)** — `reports/asr_prep_20261027-181112.json`: exact per-split counters (`raw_rows` → `dropped_empty_text` / `dropped_duration_outlier` / `dropped_silent_or_corrupt` / `kept_clean_rows`) with provenance `source_row_ids`; ur_pk train 122 raw → 120 kept (2 duration outliers dropped). Store schema canonical: `audio` (16 kHz mono float32) + `text` only.
- **Stage 9 training**: 180 train rows / 60 validation rows, 1 epoch, LoRA r=8 (q_proj, v_proj), trainable 884,736 of 242,619,648 params (0.3647%). Smoke check proved fp16 forward + backward with grads on **72 LoRA tensors** before the loop. `train_loss=1.7166`, runtime 22.44 s.
- **Stage 8 → Stage 10 (25 held-out Urdu rows, same normalization):**
  - WER: base **0.4048** → tuned **0.4018**; CER: **0.1500** → **0.1474**.
  - Honest reading: the −0.003 WER delta on 25 general-domain rows is **not** evidence of model improvement — the run's success is the trained-and-evaluated LOOP, not tuning gain. More data/epochs (Phase 3) is where real gain must be shown.
  - `number_lost: 5` in both (numbers are the hard preservation case; tracked as a standing Phase-3 target).
  - Latency: base 0.97 s/cl faced vs tuned 1.42 s (adapter overhead in eval loop; 4.565 audio-min/25 rows).

## 3. SOAP gate evidence (Stages 11–13)

- Training (§7.3.12): 100 rows (16 val), QLoRA NF4 fp16 compute on T4, assistant-token-only loss (mask-prefix assertion: 0 rejected), LoRA r=16 on q/k/v/o. Adapter + tokenizer + training manifest exported.
- Draft generation: 20 test-row drafts, ≤256 new tokens each, per-row timed prints.
- Stage 13 (§7.3.13): `schema_ok_rate 0.85` (17/20 structurally valid SOAP), `unsupported facts` in 8/20, `omitted facts` in 15/20 — the omission spike is consistent with the smoke's 256-token cap; noted as a Phase-3 tuning item.
- `missing_drafts: 20` is a KNOWN coverage mismatch, not a failure: Stage 12 drafted 20 of the 40 test cases while Stage 13 scores against all 40. Phase-3 fix queued: draft cap tied to `SOAP_TEST` knob.
- `reports/soap_review_sheet_20261027-181112.csv`: 20 case rows with blank reviewer columns — ready for mandated veterinarian scoring; automated numbers are NOT a clinical verdict.

## 4. Roman Urdu gate evidence (Stage 14)

- Prep only (Model C training is a SEPARATE task per §5/§12.1 — never bundled into Whisper).
- Fields verified from record VALUES, not names: `urdu='Urdu text'`, `roman='Roman-Urdu text'`.
- 300 train / 120 validation / 80 test aligned pairs; rejects recorded (too short 3, near-duplicate 5, exact duplicate 1); optional alpaca mix stays excluded (`APPROVED_OPTIONAL`).
- `roman_urdu_prep_report.json` exported into the artifact package.

## 5. Artifact package verification (on-disk)

| Group | Entries | Verified contents |
|---|---|---|
| `asr/whisper-lora-ur-20261027-181112/` | 10 | adapter_model.safetensors (3.56 MB), adapter_config (r=8, peft 0.18.1), full whisper processor/tokenizer set, training_manifest (base openai/whisper-small @ main) |
| `soap/soap-lora-20261027-181112/` | 10 | adapter_model.safetensors (29.5 MB), adapter_config (r=16), tokenizer/merges/vocab, training_manifest (base Qwen/Qwen2.5-3B-Instruct @ main, objective + quantization recorded) |
| `reports/` | 8 | asr base+adapter eval, soap_eval, review sheet CSV, asr_prep, data_manifest_runtime (Importance-revet-ready), environment_versions, disk, sample_fields, audio_decode |
| data/manifests | 8 | run_manifest.json (stage ledger + CONFIG_KNOBS + seeds), model_card_notes.md (honest non-claims + CC-BY-4.0 attribution), soap data + drafts, soap_prep report, roman prep report |
| `soap_test_drafts.jsonl` | — | 20 drafts, source_row_id keyed |

Integrity check: full zip extracted without error; every manifest declares `executed: true` and points to exact base checkpoint id+revision (adapter-alone-is-not-a-model rule honored).

## 6. Unexecuted / not claimed (honest labeling)

- **Model quality**: NOT claimed. WER delta −0.003 on 25 rows is pipeline proof only; `number_lost 5/25` unchanged.
- **Serving / Next.js integration**: NOT EXECUTED (Phase 4/5); nothing therefore is veterinary-validated or clinic-deployable.
- **Model C transliteration training/eval**: NOT EXECUTED (pairs prepared only).
- **`eval_steps=100`** never fired (22 optimizer steps in a 100-row smoke epoch) — validation split exists but Trainer-side eval did not occur; SOAP-side eval is the Stage 13 scorer.
- **en_us configs** were prepared/decoded (Stage 6 counters) but the ASR train/eval store is ur_pk-only — no English ASR metrics in this gate.
- **Gated datasets remain blocked**: `omi-health/medical-dialogue-to-soap-summary` (permission), `UmarRamzan/common-voice-urdu-processed` (license review) — 0 rows consumed.
- **Veterinary benchmark**: still TO BE PROVIDED by the project owner (manifest §veterinary_benchmark); general-domain metrics do not validate the final task.

## 7. Gate decision inputs for §15 approval

- Actual logs ✓ (stage ledger pasted in run session), data counts ✓ (prep + eval reports), environment versions ✓ (§1), successful export path ✓ (zip verified on disk), unexecuted stages labeled ✓ (§6).
