# Pawfolio AI — VoxSOAP ML Integration Implementation Plan

> **Document purpose:** This is the implementation contract for the coding agent working in the existing Pawfolio AI repository. It describes how to build an ML-based alternative to the current Gemini-based VoxSOAP pipeline, prepare reproducible Colab training, connect trained models to the application, and fairly compare the ML branch against the original AI pipeline.
>
> **Repository:** `D:\Pawfolio AI`  
> **Feature branch shown in the user's editor:** `Speech-to-Text-feature/voxsoap-model-integration`  
> **Desired document path in the repository:** `feature/voxsoap-model-integration.md`

---

## 0. Critical branch and comparison rules

### 0.1 Preserve `main`

The goal is to compare two strategies:

- **Baseline A — existing AI integration:** the current Gemini-based VoxSOAP pipeline in `main`.
- **Candidate B — ML integration:** the new ML-based pipeline implemented on the feature branch, using a fine-tuned speech recognition model and a separately trained/selected SOAP-generation model.

**Never delete, reset, force-push, or rewrite `main`.** All removal/replacement of the old VoxSOAP processing strategy is confined to the feature branch. Keeping `main` intact is what makes this comparison possible.

On the feature branch, the old Gemini-backed *processing path* may be replaced by the ML path, but do not indiscriminately delete every file whose name contains `vox-soap`. Shared UI, authentication, authorization, schemas, validation, persistence, audit logs, export, and sign-off logic may be required by both strategies. Inspect dependencies before removing anything.

### 0.2 Do not compare different application versions

The fairest initial comparison is to run the baseline version from `main` and the ML version from the feature branch against the **same frozen test cases**, using the same audio files, patient/encounter context, safety requirements, and evaluation rubric. Record the exact commit hash for each run.

Do not claim the ML path is better just because it has a lower training loss or produces a nicer-looking note. Measure accuracy, hallucination/unsupported details, missing-information behavior, latency, reliability, and reviewer preference.

### 0.3 Current branch name versus document path

The branch name currently shown in VS Code is `Speech-to-Text-feature/voxsoap-model-integration`; it is not the same as the requested document path `feature/voxsoap-model-integration.md`. A Git branch name and a file path are separate things. Keep the current branch if it is already the working branch. Do not rename it solely to match this document's directory.

---

## 1. Product objective

Implement an ML alternative for VoxSOAP while keeping the Pawfolio AI Next.js experience usable.

The intended pipeline is:

1. A clinic staff member records or uploads consultation audio in the existing VoxSOAP UI.
2. The Next.js server validates the request and checks authentication/authorization.
3. A speech-recognition model produces a transcript. The initial ML candidate is a fine-tuned multilingual Whisper checkpoint.
4. If Roman Urdu output is requested, a separate transliteration/normalization stage converts Urdu-script text to Roman Urdu. This is a separate task, not an automatic capability of Whisper.
5. A text-generation model produces a **draft** SOAP note from the transcript and permitted encounter context.
6. The existing schemas, validators, workflow rules, access controls, and safety checks validate the draft.
7. The veterinarian reviews and edits it. Only the existing explicit confirmation flow can mark it as confirmed.
8. The UI saves the draft and supports the existing export and audit behavior.

The ML implementation is an assistive documentation draft system, not an autonomous veterinarian and not a substitute for veterinary review.

## 2. Explicitly out of scope

Do not:

- Rebuild the Next.js project from scratch.
- Change unrelated owner/clinic portal pages or redesign the whole product.
- Remove authentication or patient/encounter authorization.
- Bypass, delete, or weaken the existing safety validator, sign-off workflow, or audit trail.
- Let an LLM or speech model directly confirm a visit, create a prescription, or silently persist a final clinical record.
- Upload real, identifiable clinic records, patient data, recordings, credentials, or secrets to public datasets or an unapproved training service.
- Commit model weights, raw audio, full derived datasets, checkpoints, Hugging Face caches, or secrets to Git.
- Claim that a model has been trained or deployed if the notebook was not actually run or the serving endpoint does not exist.
- Use a temporary Colab runtime as though it were a durable production inference server.
- Use the conditional Omi dataset listed below for training until the stated permission requirement has been verified.

---

## 3. Existing project: audit before editing

Read the following specifications and source files before implementation. The list reflects the user's current project tree; verify every path exists.

### Product specifications

- `VoxSOAP_Guard.md`
- `VoxSOAP_UI_TrackA.md`

### Engine and domain logic

- `src/lib/vox-soap/vox-soap.engine.ts`
- `src/lib/vox-soap/vox-soap.schema.ts`
- `src/lib/vox-soap/vox-soap.validator.ts`
- `src/lib/vox-soap/vox-soap.workflow.ts`
- `src/lib/vox-soap/vox-soap.types.ts`
- `src/lib/vox-soap/vox-soap.aierrors.ts`
- `src/lib/vox-soap/vox-soap.catalog.ts`
- `src/lib/vox-soap/vox-soap.richtext.ts`
- `src/lib/vox-soap/vox-soap.staff.ts`

### APIs

- `src/app/api/clinic/vox-soap/extract/route.ts`
- `src/app/api/clinic/vox-soap/assistant/route.ts`
- `src/app/api/clinic/vox-soap/confirm/route.ts`
- `src/app/api/clinic/vox-soap/draft-save/route.ts`
- `src/app/api/clinic/vox-soap/export/route.ts`
- `src/app/api/clinic/vox-soap/recordings/route.ts`
- `src/app/api/clinic/vox-soap/state/route.ts`
- `src/app/api/clinic/vox-soap/unmark/route.ts`

### UI and application infrastructure

- `src/components/vox-soap/VoxSoapWorkspace.tsx`
- `src/components/vox-soap/NewRecordingPanel.tsx`
- `src/components/vox-soap/UploadAudioPanel.tsx`
- `src/components/vox-soap/RichTextEditor.tsx`
- `src/components/vox-soap/DashboardRecordButton.tsx`
- `src/lib/auth.tsx`
- `src/lib/data.ts`
- `package.json`
- `.gitignore`
- `.env.local` (inspect variable **names** and code usage only; never print or copy secret values)

### Required audit output

Before editing application code, provide a report describing:

1. Actual audio-to-transcript-to-SOAP flow.
2. Existing Gemini SDK/model configuration and where it is invoked.
3. Existing API request and response contracts.
4. Existing auth, patient-level authorization, file handling, and persistence behavior.
5. Existing Zod schemas and safety rules.
6. Existing confirmation and audit behavior.
7. Existing tests/scripts and baseline build/typecheck result.
8. Which old model-dependent functions will be replaced on the feature branch and which shared safety/workflow modules will be retained.

Do not invent missing behavior based on comments or filenames. If implementation and documentation disagree, describe the difference and make the smallest safe plan.

---

## 4. Dataset inventory and approved use policy

**The agent must validate current dataset cards, licenses, configurations, fields, splits, and access conditions before training.** Dataset cards can change. Record the review date and the exact Hub revision/commit used for each training run in a manifest.

### 4.1 Primary SOAP-format dataset

**Dataset ID:** `Tushar9802/medscribe-soap-712`  
**Dataset card:** <https://huggingface.co/datasets/Tushar9802/medscribe-soap-712>  
**Purpose:** a small starting dataset for experimenting with structured, source-grounded SOAP formatting and explicit treatment of undocumented details. Its card describes English medical encounter-to-SOAP examples, an MIT license, and separate train/validation/test files/splits. Inspect the actual configuration through `datasets` before relying on split names or columns.

**Use policy:** allowed for an engineering prototype after verifying the current card/license and exact split/schema. It is **human medical data, not veterinary data**. It can help test formatting behavior; it cannot validate veterinary medical knowledge or clinical suitability. Do not call a model trained only on this source a veterinary model.

### 4.2 Conditional larger SOAP dataset — permission gate

**Dataset ID:** `omi-health/medical-dialogue-to-soap-summary`  
**Dataset card:** <https://huggingface.co/datasets/omi-health/medical-dialogue-to-soap-summary>  
**Purpose:** synthetic doctor/patient dialogue mapped to SOAP-like summaries. The current card reports 9,250 training, 500 validation, and 250 test entries and includes columns such as `dialogue`, `soap`, `prompt`, `messages`, and `messages_nosystem`.

**Mandatory permission gate:** the dataset card says further use requires permission from the original NoteChat dataset authors. Do **not** use it in training, evaluation used for model selection, or a released model unless the required permission has been confirmed and recorded. The agent may inspect metadata and document this dependency; it must default to `SKIP_PERMISSION_NOT_VERIFIED`.

### 4.3 Urdu speech-recognition source

**Dataset ID:** `UmarRamzan/common-voice-urdu-processed`  
**Dataset card:** <https://huggingface.co/datasets/UmarRamzan/common-voice-urdu-processed>  
**Purpose:** audio/transcript pairs for Urdu ASR. The current viewer exposes fields including `audio`, `sentence`, `path`, and `variant` and roughly 9.4k rows in the training viewer.

**License gate:** the current derived dataset page does not clearly display a license in the metadata seen during planning. Before training, inspect its dataset card/files and determine the terms of the derivative and the underlying Mozilla Common Voice data. Do not assume a license solely from the fact that the data is public. If license/provenance cannot be confirmed, mark this source `BLOCKED_LICENSE_REVIEW` and proceed only with a verified source such as FLEURS for the first pipeline test.

### 4.4 Urdu-Pakistan and US-English speech data

**Dataset ID:** `google/fleurs`  
**Dataset card:** <https://huggingface.co/datasets/google/fleurs>  
**Candidate configurations:** `ur_pk` and `en_us`. Confirm that both configuration names exist in the current Hub revision before training. The card indicates CC-BY-4.0; include required attribution in the training manifest and any redistribution.

**Purpose:** audio/transcript pairs for Urdu (Pakistan) and US-English ASR. Use its actual supported splits (`train`, `validation`, and `test`, after confirming names). Prefer dataset-provided validation/test splits for final measurement. Do not combine the test split into training. Start with a bounded sample for an engineering smoke test; scale only after the notebook succeeds.

Important: FLEURS and Common Voice are general speech resources, not veterinary appointment recordings. They do not alone prove accurate recognition of medication brands, dosages, veterinary jargon, or Urdu-English code-switching.

### 4.5 Urdu-script ↔ Roman Urdu aligned pairs

**Dataset ID:** `Mavkif/Roman-Urdu-Parl-split`  
**Dataset card:** <https://huggingface.co/datasets/Mavkif/Roman-Urdu-Parl-split>  
**Purpose:** paired `Urdu text` and `Roman-Urdu text` for transliteration/normalization. The current card reports a large corpus (about 6.33M rows in the train viewer), CSV files, and Apache-2.0 license. The repository is large, so stream examples and never load the full CSV into a local Pandas DataFrame.

**Use policy:** use small streamed subsets for initial training; inspect the exact fields and split names. Preserve the provided train/validation/test strategy and do not randomly blend all rows before splitting. This is general/parliamentary text; it may not reflect natural veterinary speech. Build separate veterinary-domain evaluation examples reviewed by a fluent speaker.

### 4.6 Supplementary Roman Urdu instruction data

**Dataset ID:** `Redgerd/roman-urdu-alpaca-qa-mix`  
**Dataset card:** <https://huggingface.co/datasets/Redgerd/roman-urdu-alpaca-qa-mix>  
**Purpose:** supplementary instruction/QA experiments. The current card reports approximately 1,489 rows and Apache-2.0. Typical fields are `instruction`, `input`, and `output`; inspect the actual record keys before mapping.

**Limit:** this is not a paired audio/transcript dataset and is not a clean Urdu-script-to-Roman-Urdu parallel set. Do not claim that training on this dataset makes Whisper transcribe audio in Roman Urdu. It can be excluded from the first release; if used, keep it as a separate optional text-normalization/instruction experiment and record its contribution.

### 4.7 Required dataset manifest

Create `ml-training/data_manifest.json` (or equivalent) containing one record per source:

- Dataset ID and URL.
- Hub revision/commit hash used.
- Date license and dataset-card details were reviewed.
- License/terms and any attribution requirement.
- Permission status (`APPROVED`, `BLOCKED_LICENSE_REVIEW`, or `SKIP_PERMISSION_NOT_VERIFIED`).
- Purpose and known domain mismatch.
- Actual split names and fields discovered.
- Number of rows consumed in each split.
- Transformations/normalization applied.
- Random seed and train/validation/test policy.
- Whether the source was used for training, validation, or final test.

Never misrepresent a blocked dataset as training data. Print a clear message when a gated dataset is skipped.

---

## 5. Model strategy

Treat the pipeline as three separate ML tasks, plus deterministic guardrails.

### Model A — Automatic speech recognition (ASR)

- Starting checkpoint: `openai/whisper-small` as an experiment, not a predetermined winner.
- Fine-tuning method: LoRA/PEFT if the selected Transformers and PEFT versions support the chosen architecture/configuration.
- Training data: only license-cleared rows from `UmarRamzan/common-voice-urdu-processed` and/or `google/fleurs` (`ur_pk`, `en_us`).
- Start with small caps and a single epoch to prove the training loop; tune only after evaluating the baseline and training result.
- Preserve official validation and test sets; do not use the test data for tuning.
- Save the base model ID/revision, processor, adapter, training configuration, and evaluation results.

The audio must be decoded to the model's expected sample rate/channel format by the processor. Do not assume every source is already 16 kHz mono merely from its dataset name. Read each dataset's actual `Audio` feature and use the supported audio decoder path.

### Model B — SOAP draft generation

- Use a small instruction-following text model that can be fine-tuned within the actual GPU memory available in Colab. A 3B-class model with QLoRA is one candidate, not a hard requirement; verify current model license, hardware, tokenizer, PEFT compatibility, and memory use before committing to it.
- Initial data: the approved portion of `Tushar9802/medscribe-soap-712`, after verifying actual train/validation/test layout and field mapping.
- `omi-health/medical-dialogue-to-soap-summary` stays excluded until the permission gate is satisfied.
- Preserve source facts; explicitly distinguish undocumented information from a negative finding. Train examples should not encourage making up a complete clinical section when information is missing.
- The source corpus is human medical, not veterinary. The feature must remain a draft-assistance prototype until a representative, veterinarian-reviewed dataset and evaluation set exist.
- Use correct supervised fine-tuning labels. Prefer computing loss on assistant response tokens rather than learning to repeat the system prompt or user input. The agent must not copy a simplistic training example that computes loss over the entire prompt without documenting this limitation.

### Model C — Roman Urdu normalization/transliteration

- Use paired Urdu/Roman Urdu fields from `Mavkif/Roman-Urdu-Parl-split` for a separate text-to-text task.
- Keep `Redgerd/roman-urdu-alpaca-qa-mix` optional and separate.
- Do not mix transliteration labels into Whisper's Urdu-script ASR labels unless actual aligned audio-to-Roman-Urdu pairs are available and deliberately selected.
- Initially, expose Roman Urdu normalization as an optional post-processing stage, with a confidence/uncertainty path and the ability for the clinician to edit it.
- Evaluate name/medicine handling and code-switching separately; transliteration can alter spelling and meaning.

### Deterministic Clinical Guard

Reuse existing Zod schemas, medication catalog, validation, and workflow rules. An ML model is not the safety validator. The model may propose draft text, but deterministic code should enforce schema shape, required fields, workflow permissions, warnings, and sign-off rules.

---

## 6. Proposed repository additions

Adapt to the repository after the audit. Do not duplicate existing functionality. Use the following as a target layout, not a requirement to create every file if the project already has an equivalent.

```text
D:\Pawfolio AI\
├── feature\
│   └── voxsoap-model-integration.md
├── ml-training\
│   ├── README.md
│   ├── requirements-colab.txt          # or notebook-pinned pip installs
│   ├── data_manifest.json
│   ├── notebooks\
│   │   └── voxsoap_ml_training.ipynb   # runnable Colab notebook
│   ├── scripts\
│   │   ├── inspect_datasets.py
│   │   ├── prepare_soap_data.py
│   │   ├── prepare_roman_urdu_data.py
│   │   ├── train_whisper_lora.py
│   │   ├── train_soap_lora.py
│   │   ├── evaluate_asr.py
│   │   └── evaluate_soap.py
│   └── reports\                       # metrics/manifests only; no sensitive cases
├── ml-service\                        # Python inference API; propose only after audit
│   ├── README.md
│   ├── requirements.txt
│   ├── .env.example
│   ├── app\
│   │   ├── main.py
│   │   ├── schemas.py
│   │   ├── asr_service.py
│   │   ├── soap_service.py
│   │   └── health.py
│   └── tests\
└── src\lib\vox-soap\                 # existing shared domain/safety logic
```

Model weights, raw audio, datasets, cache directories, local `.env`, checkpoints, and generated archives must not be committed. Add ignore rules such as `ml-training/artifacts/`, `ml-training/data/`, `ml-training/cache/`, `ml-service/models/`, `*.safetensors`, `*.pt`, and training checkpoint folders only after checking whether the repository intentionally tracks any such files already. Do not blindly ignore needed source assets.

The actual training may run in Colab rather than on Windows. The scripts/notebook must be reproducible and should save outputs to a known export folder. The coding agent must tell the user exactly which files must be uploaded to Colab or run there.

---

## 7. Colab training setup

### 7.1 User-owned setup

1. Open a new Google Colab notebook and save it as `Pawfolio_VoxSOAP_ML_Training.ipynb`.
2. Select **Runtime → Change runtime type → GPU**. Hardware availability varies; do not assume a T4 is always assigned.
3. Run a hardware check that prints PyTorch version, CUDA availability, GPU model, and GPU memory. Fail clearly if no GPU is attached for the training stages that require it.
4. Use a temporary workspace such as `/content/pawfolio`. Set Hugging Face caches under `/content/hf_cache` instead of the laptop's C: drive.
5. Install compatible pinned versions of `datasets`, `transformers`, `accelerate`, `peft`, `evaluate`, `jiwer`, `librosa`, `soundfile`, and any audio codec/model dependencies confirmed to be needed. Avoid unpinned upgrades mid-run after a successful experiment; record versions.
6. Read current dataset cards and record dataset revision identifiers and license checks.
7. Start with bounded samples; validate that audio decoding and text columns work before long training.
8. Train and evaluate in separate, clearly named stages.
9. Save adapters, tokenizer/processor assets, configs, manifests, and metrics to `/content/pawfolio/exports`.
10. Zip only the intended export files and download through the Colab browser to `D:\Pawfolio AI\ml-training\artifacts\` (create this folder on Windows first). Do not assume Colab can directly write to `D:\`.

Colab free GPU access, runtime duration, and idle lifetime are not guaranteed. A disconnected runtime can lose data in its temporary disk. Save checkpoints/exports at deliberate intervals and verify the archive exists before disconnecting.

### 7.2 Streaming rules

Use `datasets.load_dataset(..., streaming=True)` where supported for the large audio and Roman Urdu sources. Inspect the schema before selecting the transcript column. Use deterministic seeds and bounded examples for smoke tests.

Streaming avoids fully materializing a dataset as a normal local dataset, but it does **not** guarantee zero disk/cache usage or a fixed low RAM ceiling. Audio decoding, shuffle buffers, preprocessing, checkpoints, and model weights still consume resources. Do not write code that assumes all dataset bytes are always held only in RAM.

For streamed datasets:

- Inspect features/keys from a real example before mapping.
- Shuffle before applying `take`/`skip` when selecting random training subsets.
- Respect provided train/validation/test partitions. Never randomly split after combining official test samples with training samples.
- Do not call `.to_pandas()` on a very large dataset.
- Keep the sample cap configurable in the notebook.
- Count successfully decoded/written samples and skipped records; log only non-sensitive error details.
- Store a source ID/row identifier in the data manifest, not raw personal information.

### 7.3 Required notebook stages

The Colab notebook should contain these ordered sections:

1. Environment and GPU verification.
2. Install pinned dependencies and print versions.
3. Check workspace/cache/disk availability.
4. Inspect current dataset cards/configs/splits and write `data_manifest.json`.
5. Sample a few records and validate all expected fields.
6. Stream, decode, and validate audio/transcript rows.
7. Create reproducible capped training data without leaking validation/test rows.
8. Evaluate the base ASR checkpoint before fine-tuning.
9. Fine-tune the ASR adapter.
10. Evaluate the fine-tuned ASR adapter using the same held-out data.
11. Prepare approved SOAP examples and validate their schema.
12. Fine-tune the separate SOAP text model using an appropriate supervised objective.
13. Evaluate SOAP outputs using automated checks plus a manual review sheet.
14. Prepare the optional Roman Urdu alignment experiment separately.
15. Save adapters/processors/tokenizers/configuration/metrics/model-card notes.
16. Package and verify an export archive.
17. Print exact output paths and sizes, without claiming success when a stage failed.

The agent should create a notebook that can run end-to-end on the environment it actually verifies. If the notebook cannot run in the agent's environment, it must label this as **not executed** and give the user the exact Colab steps. Do not report imagined metrics.

---

## 8. Dataset preparation and data quality requirements

### 8.1 Common schema

Create a normalized intermediate format. The actual field names must be discovered and validated from each source; do not assume every data source has `messages` or `sentence`.

SOAP model examples should be represented internally as:

```json
{
  "input": "Encounter transcript or source text",
  "target": "Structured SOAP draft",
  "source_dataset": "dataset ID",
  "source_split": "train",
  "source_row_id": "stable non-sensitive source identifier"
}
```

ASR samples should be represented internally as audio features/paths and their exact reference transcript, plus source/split identifiers. Roman Urdu pairs should hold separate Urdu-script and Roman Urdu fields. Do not join these tasks into a single undifferentiated JSONL file.

### 8.2 Quality checks

Before training:

- Drop empty audio/text rows and invalid audio metadata.
- Reject or separately report unreasonably long/short clips and excessive transcript length according to configurable limits.
- Normalize whitespace consistently without stripping meaningful Urdu characters, punctuation, or medicine names.
- Detect exact and near-duplicate examples across training/evaluation splits where feasible.
- Check whether speaker identities or repeated source segments can leak between splits if speaker metadata exists.
- Keep a count of accepted/rejected rows and reasons.
- Inspect a small sample of decoded audio and transcripts manually.
- Do not auto-correct transcripts in a way that changes ground truth without documenting it.
- Never create fake aligned audio/transcript pairs by translating unrelated QA text.

### 8.3 Veterinary-specific validation set

Public general datasets are not adequate for evaluating the final Pawfolio task. The project owner must prepare or approve a separate set of **synthetic or appropriately de-identified** veterinary consultation examples covering:

- English speech.
- Urdu speech.
- Urdu-English code-switching.
- Common symptom terms and anatomy.
- Medicine names and ambiguous/uncertain medication mentions.
- Dosage, frequency, units, and negation.
- Missing vitals/exam findings.
- Speaker interruptions and background noise.
- Cat and dog cases, while avoiding the claim that the dataset covers every species or specialty.

Have a qualified veterinarian review reference SOAP outputs before treating them as a benchmark. Keep this benchmark out of model training. Do not upload private real-world clinic records to Colab without the relevant authority, consent/privacy review, approved processing arrangements, and appropriate safeguards.

---

## 9. Model serving: training is not deployment

A Colab notebook is a temporary training environment. Once the runtime terminates, its internal URL and files cannot be treated as a stable inference API for the Next.js application.

Choose and document one serving target before announcing that the ML integration is usable:

### Option 1 — Local Python service for the demo

A Python FastAPI process runs on the user's Windows computer and loads the trained artifacts from a local models folder. The Next.js server calls it over `http://127.0.0.1:<port>`.

Advantages: avoids paying for a continuously hosted GPU endpoint and is useful for local evaluation. Limitations: the user's older CPU/GPU may make inference slow; the service and artifacts must be present and running; some GPU quantization paths used in Colab may not work on Windows CPU. Test actual model loading and latency before choosing this option.

### Option 2 — Persistent hosted inference service

Deploy the model behind an authenticated HTTPS endpoint that remains available while the app uses it. This may incur cost and requires account, access control, deployment configuration, monitoring, privacy review, and an explicit budget decision. Do not create billable infrastructure without user approval.

### Option 3 — Provider stub during development

If trained weights or serving infrastructure are not yet available, implement a clearly named unavailable/stub state for automated testing only. The UI must display a clear error for real requests. Never return fabricated transcripts or SOAP notes while indicating that an ML model ran.

### Required inference API shape

Design an internal Python API (adapt its names after the repo audit) with endpoints similar to:

- `GET /health` — returns service status, loaded model IDs/revisions, and whether required artifacts are loaded; never exposes secrets or sensitive paths.
- `POST /transcribe` — accepts validated audio and returns transcript text, language/provider metadata, and a request ID.
- `POST /soap` — accepts a transcript plus permitted encounter context and returns a structured *draft* SOAP result.
- Optionally `POST /process` — orchestrates both stages server-side only if that reduces complexity without duplicating the Next.js engine's safety logic.

Use typed request/response schemas, request size/duration limits, timeouts, safe error responses, and internal authentication where the service is reachable beyond loopback. Do not expose the Python model service publicly without proper authentication and rate limiting.

The Next.js route must call the service server-side. No Hugging Face token, inference credential, or model service secret belongs in client code or `NEXT_PUBLIC_*` variables.

A PEFT adapter is not a complete base model. The serving configuration must identify the compatible base checkpoint and revision as well as the adapter path/revision. Validate compatibility before loading. Do not promise that adapters are 5 MB or that training takes a fixed number of minutes.

---

## 10. Next.js integration design

### 10.1 Provider separation

Based on the audit, introduce typed interfaces or use equivalent existing abstractions for:

- Speech recognition.
- Optional Roman Urdu normalization.
- SOAP generation.

Avoid duplicating domain types. The ML provider should return structured data to the existing engine, and the existing validation/workflow layer should remain in charge of draft validation and sign-off.

### 10.2 Feature-branch replacement rules

On this feature branch, switch the **active extraction pipeline** away from the old Gemini call path to the ML provider once the service is configured. The previous Gemini implementation can be removed from the candidate runtime path only after:

1. Its responsibilities have been mapped.
2. All required shared validation/workflow functions are retained.
3. Tests cover the new behavior.
4. The user approves the specific removal/replacement patch.

Do not remove `vox-soap.validator.ts`, `vox-soap.schema.ts`, `vox-soap.workflow.ts`, auth, recording storage, audit handling, or confirmation behavior merely because the active generator is no longer Gemini-based.

If an optional runtime provider toggle is helpful for local evaluation, propose it first. The default in the ML feature branch must be explicit; avoid hidden fallbacks that silently switch to Gemini because an ML service is unavailable. A failed ML call should report a controlled error so the comparison remains valid.

### 10.3 `extract/route.ts` expectations

- Verify authentication and patient/encounter authorization before expensive model processing.
- Validate MIME type, file size, duration, and request body.
- Enforce timeouts and controlled upstream errors.
- Call the selected speech provider for audio inputs.
- Send the transcript and allowed context to SOAP generation.
- Validate generated data with existing Zod and clinical guard rules.
- Return the draft plus validation warnings and missing-information indicators.
- Do not confirm or finalize the visit.
- Do not log raw audio, API keys, or full clinical transcripts in ordinary logs.

Inspect all related recording, draft-save, state, assistant, export, unmark, and confirm routes for regressions.

### 10.4 UI behavior

Reuse `VoxSoapWorkspace.tsx`, `NewRecordingPanel.tsx`, `UploadAudioPanel.tsx`, and `RichTextEditor.tsx` where possible. Make status states clear:

- Uploading/recording.
- Transcribing.
- Normalizing script (if enabled).
- Generating SOAP draft.
- Validating draft.
- Ready for review.
- Failed / retry available.

Maintain editing, autosave, warnings, confirmation, export, and existing navigation. If a request fails, do not erase an unsaved draft. Clearly label results as drafts until explicit veterinarian confirmation.

---

## 11. Evaluation and fair A/B comparison

### 11.1 Freeze a benchmark

Create a small, fixed evaluation pack with stable IDs and synthetic/de-identified content. Do not include private identifying data. Keep the reference transcripts and veterinary-reviewed reference SOAP notes separate from training artifacts. Use the same test examples for `main` and the ML branch.

Record:

- Test-pack revision/hash.
- Baseline commit hash from `main`.
- ML branch commit hash.
- Base model IDs/revisions and adapter file hashes.
- Dataset revisions and sample counts.
- Inference configuration and hardware.
- Date, latency, error state, and reviewer scores.

### 11.2 ASR measures

Measure at least:

- Word Error Rate (WER) on normalized transcripts.
- Character Error Rate (CER), useful for Urdu script.
- Exact preservation of important medication names, numbers, units, negations, and uncertain phrases.
- Urdu-English code-switching quality on the separate veterinary benchmark.
- Real latency per minute of audio and failure rate.

Use `jiwer` or a verified equivalent for WER; clearly document normalization rules because tokenization and punctuation affect scores. Do not compare metrics produced with different normalization settings.

### 11.3 SOAP measures

Measure at least:

- Required section presence/valid schema rate.
- Supported-fact retention.
- Unsupported or hallucinated clinical claims.
- Medication/dosage/route/frequency fidelity.
- Handling of undocumented findings versus explicit negative findings.
- Important omitted facts.
- Vet reviewer score for usefulness and edit effort.
- End-to-end latency and service error rate.

Avoid relying solely on ROUGE/BLEU or a second LLM's judgement for clinical safety. Include explicit factual error checks and human review.

### 11.4 Results report

Produce `ml-training/reports/ab-comparison.md` or equivalent with a table comparing baseline and ML on the same cases. Include failures and limitations, not just successful examples. Never fabricate scores. If a test stage has not run, mark it `NOT RUN`.

---

## 12. Configuration and secrets

Inspect current environment variable names before changing them. Preserve compatibility where reasonable and propose changes clearly.

Add placeholders to `.env.example`, not real credentials. Candidate ML-only variables may include:

```dotenv
# Example names; align them with the actual application after inspection.
VOXSOAP_PROVIDER=ml
VOXSOAP_ML_SERVICE_URL=http://127.0.0.1:8000
VOXSOAP_ML_SERVICE_TOKEN=
VOXSOAP_ASR_MODEL_ID=openai/whisper-small
VOXSOAP_ASR_ADAPTER_PATH=
VOXSOAP_SOAP_BASE_MODEL_ID=
VOXSOAP_SOAP_ADAPTER_PATH=
VOXSOAP_ROMAN_URDU_ENABLED=false
VOXSOAP_ML_TIMEOUT_MS=120000
```

These names are illustrative; inspect the existing engine and configuration first. Do not put Hugging Face tokens, model-serving secrets, or Gemini credentials into `NEXT_PUBLIC_*`. Keep secrets in `.env.local` for local development and in the deployment platform's secret manager for production. Ensure `.env.local` is ignored by Git.

For public datasets, a Hugging Face token may not be needed, but the notebook should not hard-code a token and must support private/gated access only through Colab Secrets or an interactive secure login if genuinely required. Never print the token.

---

## 13. Security, privacy, and safety requirements

- Treat all model output as untrusted input.
- Validate server-side and enforce authorization before model calls and data reads.
- Do not trust a client-supplied patient ID without checking access permissions.
- Avoid storing model prompts or transcript bodies in operational logs.
- Limit upload bytes, accepted formats, audio duration, generation tokens, request frequency, and timeouts.
- Handle provider service errors without returning stack traces or secrets to the browser.
- Ensure retries do not create duplicate visits, audit entries, or confirmations.
- Keep explicit veterinarian confirmation as a separate authorized action.
- Do not generate medicine choices or dosages from model memory; preserve only source-grounded content and run the existing validator.
- Never send real identifiable clinical data to a third-party model/training environment without documented authority and appropriate privacy/security approval.
- The dataset pipeline must not ingest real Pawfolio patient records by default.

---

## 14. Testing requirements

Use existing test tooling. If no test framework exists, report that and propose the smallest appropriate setup before adding substantial dependencies.

### Automated tests

1. Provider selection and missing configuration.
2. ML service not running (controlled error; no silent Gemini fallback).
3. ML service returns valid transcript.
4. ML service returns malformed/empty response.
5. Upload validation: allowed format, disallowed type, oversized input, empty audio.
6. Request timeout and retry behavior.
7. SOAP response conforms to existing schema.
8. Undocumented information stays undocumented, not fabricated.
9. Ambiguous medication/dosage is flagged rather than invented.
10. Draft-save and state hydration still work.
11. Confirmation requires authorized explicit action.
12. Unauthorized access to another patient's encounter is rejected.
13. Export continues to work.
14. No secrets appear in frontend bundles or committed files.
15. ML integration does not alter non-VoxSOAP routes unintentionally.
16. Dataset preparation maps the actual source schemas and skips invalid rows transparently.
17. Training scripts fail clearly on missing GPU/permission/license gates and report actual sample counts.

Mock network/model calls for unit tests. Mark real-model integration tests separately; they must not imply that an endpoint was tested if only mocks were used.

### Manual browser tests

- Upload a short supported audio file and watch status changes.
- Record audio if microphone permissions are available.
- Verify transcript editing and correction flow.
- Generate SOAP and inspect each section.
- Confirm warnings for undocumented information.
- Edit the draft and ensure autosave works.
- Simulate a stopped ML service; confirm the UI shows a recoverable error and preserves the draft.
- Confirm a visit only through the authorized confirmation action.
- Export the note and compare it with the saved draft.
- Check browser console/network requests for secrets or unintended client-side model calls.

---

## 15. Required implementation phases and approval gates

### Phase 0 — Audit only

Deliver the repository audit report. No application-code changes.

**Approval gate:** user approves the plan and confirms which old model-dependent behavior should be replaced.

### Phase 1 — Training assets and dataset audit

Create the data manifest, schema inspection script, training notebook scaffold, license/permission gates, data preparation, and export format. Do not train on blocked sources.

**Approval gate:** user confirms the model candidates and external account/cost constraints.

### Phase 2 — First Colab smoke test

Verify GPU, load small samples using streaming where available, decode audio, validate text records, and save a small artifact/metrics report. Do not run large full-corpus processing.

**Approval gate:** show actual logs, data counts, environment versions, and successful export path. Clearly label unexecuted stages.

### Phase 3 — Train and evaluate model adapters

Train ASR and SOAP components separately. Roman Urdu normalization remains a separate optional experiment. Preserve proper validation/test splits. Save only approved artifacts and metrics.

**Approval gate:** provide results, model limitations, artifact sizes, and license/provenance manifest.

### Phase 4 — Inference service

Implement the Python serving API only after deciding local versus hosted serving. Add health checks, schema validation, error handling, and mockable clients. Do not add paid infrastructure without approval.

**Approval gate:** run a health check and one real inference request against actual trained artifacts, or label the stage blocked if artifacts are not yet available.

### Phase 5 — Next.js integration on the feature branch

Connect the ML service to the existing engine and extract route. Replace the active Gemini-based extraction path in the feature branch only after safety and compatibility tests are in place. Retain shared clinical guards and workflow.

**Approval gate:** review the full diff before deleting/replacing old model-dependent code.

### Phase 6 — Regression, safety, and browser testing

Run typecheck, lint, build, unit tests, integration tests, and manual scenarios. Report every command and its actual result.

### Phase 7 — A/B comparison and handoff

Run the same frozen test set against `main` and the ML branch. Produce the comparison report, user setup steps, local run instructions, and rollback instructions.

---

## 16. Git and change-management requirements

1. Verify the current branch with `git branch --show-current`.
2. Verify a clean/safely checkpointed working tree before broad modifications.
3. Check that `.env.local`, model files, raw audio, and generated data are not staged.
4. Keep every code change on the current feature branch.
5. Do not run `git reset --hard`, `git clean -fd`, force-push, or destructive bulk-delete commands.
6. Do not merge into `main` automatically.
7. Make focused commits after completed phases where the user has approved the changes.
8. Before deleting files, show the user the proposed deletions and explain which dependencies/tests demonstrate they are unnecessary.
9. Preserve enough Git history that the original baseline can still be checked out and run.

Suggested commit grouping (names may be adapted):

- `docs: add VoxSOAP ML implementation plan`
- `ml: add dataset audit and Colab training workflow`
- `ml: add model evaluation and artifact export`
- `ml: add inference service`
- `feat: integrate ML provider into VoxSOAP extraction`
- `test: add VoxSOAP ML integration regression tests`

Do not make these commits unless the corresponding work is done and verified.

---

## 17. Definition of done

The task is complete only when all applicable criteria are met or explicitly marked blocked:

- [ ] `main` remains unchanged by this feature work.
- [ ] The initial repository audit is documented.
- [ ] Dataset IDs, current revisions, license/permission gates, and splits are captured in the manifest.
- [ ] Conditional datasets are skipped unless permission is verified.
- [ ] Streaming/schema inspection and capped data preparation work on actual records.
- [ ] No test split leakage is introduced.
- [ ] ASR training/evaluation can be reproduced in Colab, or limitations are clearly documented.
- [ ] SOAP training/evaluation uses an appropriate objective and does not claim veterinary validation based on human data.
- [ ] Roman Urdu normalization is implemented/evaluated as a separate task, not misrepresented as Whisper behavior.
- [ ] Model artifacts can be exported and their base-model dependencies are documented.
- [ ] A real, stable inference target is configured or the integration clearly reports that inference is unavailable.
- [ ] The Next.js ML provider is server-side and preserves authentication/authorization.
- [ ] Existing schemas, validators, draft handling, audit logs, exports, and explicit confirmation remain effective.
- [ ] Unit/integration/build checks have actual recorded outcomes.
- [ ] The same test set has been used for baseline-versus-ML comparison, where available.
- [ ] No secrets, raw patient data, or large model artifacts were accidentally committed.
- [ ] User-facing setup, run, test, evaluation, and rollback instructions are complete.

If some criteria are blocked by an external permission, absent GPU, missing trained weights, missing inference hosting, or lack of veterinarian-reviewed evaluation data, report the blocker. Do not mark it done.

---

## 18. Required final report from the coding agent

At the end, provide:

1. Summary of architecture changes.
2. Exact files added, edited, and deleted, with reasons.
3. Which previous Gemini-based behavior was replaced on the feature branch and which shared logic was retained.
4. Dataset IDs actually used versus skipped, with permission/license status.
5. Training configuration and real sample counts.
6. Actual model evaluation numbers, with baselines and test splits specified.
7. Model/adapter artifact locations and base model requirements.
8. The actual inference URL/location and how to start/stop it.
9. Exact commands the user must run locally and in Colab.
10. Actual lint/typecheck/build/test results, including failures.
11. Known limitations and safety concerns.
12. How to compare this feature branch against `main` and how to roll back.

Do not say “complete,” “working,” “trained,” or “deployed” for a component that was only scaffolded, mocked, or documented.

---

## 19. References to verify during implementation

- MedScribe SOAP dataset: <https://huggingface.co/datasets/Tushar9802/medscribe-soap-712>
- Omi medical dialogue to SOAP dataset and its permission condition: <https://huggingface.co/datasets/omi-health/medical-dialogue-to-soap-summary>
- Processed Common Voice Urdu dataset: <https://huggingface.co/datasets/UmarRamzan/common-voice-urdu-processed>
- FLEURS speech dataset: <https://huggingface.co/datasets/google/fleurs>
- Roman Urdu parallel dataset: <https://huggingface.co/datasets/Mavkif/Roman-Urdu-Parl-split>
- Roman Urdu instruction/QA mix: <https://huggingface.co/datasets/Redgerd/roman-urdu-alpaca-qa-mix>
- Hugging Face streaming documentation: <https://huggingface.co/docs/datasets/stream>
- Hugging Face ASR training guide: <https://huggingface.co/docs/transformers/tasks/asr>
- Google Colab resource/usage FAQ: <https://research.google.com/colaboratory/faq.html>

Recheck the current cards and docs before running training, because dataset metadata, revisions, dependencies, and service availability can change.
