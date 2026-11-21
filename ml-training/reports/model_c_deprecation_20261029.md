# Model C deprecation — 2026-10-29 (owner decision, after run 11)

## Decision

**Model C (mT5-small Roman-Urdu transliteration; §5 of the integration contract) is
DEPRECATED and REMOVED from the Phase-3/4 blocking path.** It is marked
**EXPERIMENTAL / UNSOLVED**. Nothing about it may report as ready: the serving
endpoint `/roman` keeps answering an controlled **501**, and the notebook toggle
`RUN_MODEL_C` now **defaults to `False`**.

Three separate training recipes, each with deliberate remediation from the
previous failure, all failed quality evaluation. The common factor is the
**architecture + data combination itself** (mT5 span-corruption fine-tuning over
~2k parliament transliteration pairs), not hyperparameters alone. Core VoxSOAP
components — Whisper Urdu ASR and SOAP QLoRA drafting — are **unaffected**.

## Measured failure history (all FAIL ×3)

| Run | Recipe | Measured result | Failure mode |
| --- | --- | --- | --- |
| 9 (`20261028-142956`) | fp16-AMP, lr 5e-4, 3 ep, LoRA r16 q/k/v/o | exact_match 0.0, **CER 0.9142**, all 20 review rows literal `<extra_id_0>` | span-corruption **sentinel collapse** |
| 10 | PURE fp32, lr 1e-4, 3 ep (AMP removed, mT5/T5 not fp16-safe) | train loss plateau ≈ 6.8 ≈ ln(vocab) → model emits near-uniform character soup, **CER 6.1456** | no learning signal — loss pinned at the zero-informativeness point |
| 11 (`20261029-155115`) | fp32, lr 1e-4, 8 ep, LoRA r16 q/k/v/o, `<extra_id_0>` target-prefix alignment, eval every 50 steps | loss ~6.4→6.8 plateau; probe + eval outputs were **degenerate repetition loops** ("January…", "aik aik…", "aaaaa…"), exact_match 0.0, **CER 6.8905** | repetition collapse despite correct prefix alignment |

Diagnostic notes carried with the decision:

- mT5 vocab is 250,112 (ln ≈ 12.43); an effective plateaus at ~6.8 means the model
  learned to hedge far below the uninformative bound while producing loops — the
  usual signature of a task the pretraining representation fragments cannot serve
  as decode targets without a fundamentally different formulation.
- Run-11's prefix alignment was implemented and verified in code
  (`TARGET_PREFIX = "<extra_id_0>"` asserted at trainer start), and the evaluator
  honestly strips decoded prefixes — so the remaining failure is genuinely
  model-side, not a formatting artifact.
- The LoRA slice (r16 on q/k/v/o ≈ 0.45% of parameters) is a deliberate Colab
  constraint; widening it further was rejected as a dead end given the loss
  behaviour across three recipes.

## What changed on the branch

- Notebook (SS5/§7.3.14–14c): `RUN_MODEL_C = False` with a dated comment; stages
  14/14b/14c skip errors and stage notes carry DEPRECATED wording. Model C stays
  toggle-reachable **only** for a supervised owner-approved experiment; it never
  gates ASR/SOAP stages.
- Trainers/evaluator (`train_transliteration_lora.py`, `evaluate_transliteration.py`):
  module docstrings carry deprecation banners with the measured numbers.
- Serving (`ml-serving`): `config.py` comment blocks,
  `providers.py` `_require_adapter("roman")` message, `app.py` docstring +
  `/health` notes, and `README.md` (intro, run-9 note, route table) all state the
  deprecation. `/roman` → 501 by design; `VOXSOAP_ROMAN_ADAPTER_DIR` remains a
  diagnostics-only override requiring a passing adapter.
- Feature contract: dated deprecation addendum appended under
  `feature/voxsoap-model-integration.md` §5 Model C.
- Checker (`check_run9.py`): toggle assertion flipped to `RUN_MODEL_C = False`,
  plus assertions on the deprecation markers in notebook source, both scripts,
  and the serving config/providers.

## Pivot options IF Roman Urdu normalization is ever required again

Listed for the record; none is scheduled, and none blocks Phase 3/4:

1. **Rule-based normalization pipeline** — deterministic Urdu-script → Roman
   transliteration table plus a small post-edit model; fully auditable, no
   training, no GPU. Recommended first candidate (the contract already favours a
   clinician-editable confidence path).
2. **Byte-level character-mapping seq2seq** (e.g. `byt5-small`) — explicit
   character granularity sidesteps mT5's 250k-vocab span formulation entirely.
3. **Dedicated transliteration library / data source** evaluation, if a packaged
   Persian/Urdu transliterator meets the audit standard.

All must go through the same honest eval gate (exact_match / CER / fluent-speaker
review) before anything is wired into serving.
