# ml-training — VoxSOAP ML training assets (feature branch only)

This folder implements **Phase 1** of `feature/voxsoap-model-integration.md`:
reproducible Colab training assets for the ML alternative to the Gemini-based
VoxSOAP pipeline. Everything here is currently a **scaffold: NOT EXECUTED**.
No notebook stage has run, no model has been trained, no metric exists.

## Layout

```text
ml-training/
├── README.md                     ← this file
├── requirements-colab.txt        ← pinned versions installed by notebook Stage 2
├── data_manifest.json            ← planning-time dataset gates (§4.7). Runtime copy
│                                    is rewritten by Stage 4 as data_manifest_runtime_*.json
├── notebooks/
│   └── voxsoap_ml_training.ipynb ← the Colab notebook (Stage 0-17, §7.3)
├── scripts/                      ← single source of truth for training logic
│   ├── inspect_datasets.py       ← Stage 4: hub revisions, licenses, splits, gates
│   ├── prepare_soap_data.py      ← Stage 11: normalized SOAP triples + quality report
│   ├── prepare_roman_urdu_data.py← Stage 14: STREAMED Urdu→Roman pairs (separate task)
│   ├── train_whisper_lora.py     ← Stage 9: ASR LoRA/PEFT (GPU-hard-gated)
│   ├── train_soap_lora.py        ← Stage 12: QLoRA SFT, loss on assistant tokens only
│   ├── evaluate_asr.py           ← Stages 8/10: WER/CER + preservation + latency
│   └── evaluate_soap.py          ← Stage 13: deterministic checks + vet review sheet
├── artifacts/                    ← (create locally) downloaded export zips - GITIGNORED
├── data/                         ← local cached/prepared data - GITIGNORED
├── cache/                        ← local model/dataset caches - GITIGNORED
└── reports/                      ← small JSON/CSV/MD metrics and run manifests (committable)
```

## Dataset gates (mirror of `data_manifest.json` — a human, not the agent, upgrades these)

| Source | Status | Use |
|---|---|---|
| `Tushar9802/medscribe-soap-712` | APPROVED (engineering prototype) | SOAP formatting experiments; HUMAN medical data — never describe a model trained on it as veterinary |
| `omi-health/medical-dialogue-to-soap-summary` | **SKIP_PERMISSION_NOT_VERIFIED** | 0 rows until you record permission from the original NoteChat authors |
| `UmarRamzan/common-voice-urdu-processed` | **BLOCKED_LICENSE_REVIEW** | 0 rows until you verify the derivative + underlying Common Voice terms |
| `google/fleurs` (ur_pk, en_us) | APPROVED (CC-BY-4.0 attribution required) | First ASR smoke tests; official splits respected; capped |
| `Mavkif/Roman-Urdu-Parl-split` | APPROVED (Apache-2.0) | STREAMED subsets only; separate transliteration task |
| `Redgerd/roman-urdu-alpaca-qa-mix` | APPROVED_OPTIONAL | Excluded from the first release by default |

To record YOUR license/permission decision after verifying a card yourself:

```bash
python scripts/inspect_datasets.py \
  --record-license-decision "UmarRamzan/common-voice-urdu-processed=APPROVED" \
  --manifest-in data_manifest.json --manifest-out reports/data_manifest_runtime.json
```

## Exact Colab workflow

1. Create the local target folder: `D:\Pawfolio AI\ml-training\artifacts\` on Windows.
2. In Colab: **Runtime → Change runtime type → GPU**.
3. Upload **the whole `ml-training` folder**, or zip it and upload as `ML_TRAINING_UPLOAD.zip`, so `/content/ml-training/scripts/*.py` and `/content/ml-training/data_manifest.json` exist. Stage 0 verifies the payload and stops with clear instructions if it is missing.
4. Run all cells top-to-bottom. Stage 1 aborts immediately if no GPU is attached.
5. Stage 2 installs the exact pins from `requirements-colab.txt` and records versions; if pip fails, adjust pins (never upgrade mid-run) and re-run Stage 2.
6. Stage 4 writes `reports/data_manifest_runtime_*.json` with live revisions/licenses; every later stage re-checks the gates it needs.
7. Stage 16 creates `/content/voxsoap_ml_exports_<runid>.zip` and **verifies** it (count + size + `testzip`).
8. Download that zip through the Colab browser into `D:\Pawfolio AI\ml-training\artifacts\` — Colab cannot write to `D:\` directly.
9. Stage 17 prints the per-stage ledger: any stage FAILED/SKIPPED(gate)/NOT RUN means the run is incomplete and must not be reported as success.

Colab runtimes are temporary and can disconnect: exports/checkpoints land in `/content/pawfolio/exports` and `/content/pawfolio/checkpoints` as each stage finishes; zip early if a long run becomes risky.

## Script ↔ notebook mapping (§7.3)

| # | Required stage | Where |
|---|---|---|
| 1 | Environment and GPU verification | notebook cell (Stage 1) |
| 2 | Install pinned deps + print versions | notebook cell (Stage 2) |
| 3 | Workspace/cache/disk availability | notebook cell (Stage 3) |
| 4 | Dataset cards/configs/splits + manifest | `scripts/inspect_datasets.py` via Stage 4 cell |
| 5 | Sample record field validation | Stage 5 cell |
| 6 | Stream/decode/validate audio rows | Stage 6 cell |
| 7 | Capped reproducible ASR prep, no test leak | Stage 7 cell (saves `data/asr_store`) |
| 8 | Base ASR eval before tuning | `scripts/evaluate_asr.py` (Stage 8) |
| 9 | Fine-tune ASR adapter | `scripts/train_whisper_lora.py` (Stage 9) |
| 10 | Eval fine-tuned adapter, same held-out set | `scripts/evaluate_asr.py` (Stage 10) |
| 11 | SOAP prep + schema validation | `scripts/prepare_soap_data.py` (Stage 11) |
| 12 | SOAP fine-tune (assistant-token loss) + drafts | `scripts/train_soap_lora.py` (Stage 12) |
| 13 | SOAP eval + manual review sheet | `scripts/evaluate_soap.py` (Stage 13) |
| 14 | Optional Roman Urdu alignment (separate) | `scripts/prepare_roman_urdu_data.py` (Stage 14, default OFF) |
| 15 | Save artifacts/config/metrics/model-card notes | Stage 15 cell |
| 16 | Package + verify export archive | Stage 16 cell |
| 17 | Print paths/sizes without false success claims | Stage 17 cell |

Scripts are independently runnable on a GPU machine (see each file's docstring header) with the same CLI arguments the notebook passes.

## Honest status — read before citing anything

- [ ] Notebook: **NOT EXECUTED** by the coding agent (no Colab access from the feature workspace).
- [ ] No training has happened; there are **no model artifacts** anywhere in this repo.
- [ ] `evaluate_asr`/`evaluate_soap` numbers: **none exist yet** — nothing was fabricated.
- [ ] Serving (Phase 4) and the Next.js ML provider (Phase 5) are not built; `.env.example`
      documents the planned variable names only.
- [ ] The veterinary benchmark (§8.3) must be created and vet-reviewed before any final A/B claim.

## Safety rails (enforced in code, not just prose)

- Gate table is read from the manifest; every training stage refuses unapproved sources and prints `[GATE-SKIP]`.
- `omi-health/...` has a hard refusal in `prepare_soap_data.py` regardless of CLI flags; only a human-recorded manifest status unlocks it.
- Common Voice Urdu stays blocked until its license is verified; FLEURS covers the first smoke tests.
- Official train/validation/test splits are respected; the test split is never merged into training.
- Streaming (`streaming=True`, shuffle-before-take) for the large corpora; never `to_pandas()` on full sets.
- Secrets: none needed for public datasets; if you add a fine-tuned gated source, use Colab Secrets — never hard-code tokens.

## Rollback

Everything in this folder is additive on the feature branch. `git revert` of the Phase 1
commit, or deleting `ml-training/`, restores the pre-ML tree. `main` was never touched.
