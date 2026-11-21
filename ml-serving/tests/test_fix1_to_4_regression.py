"""Regression suite for Fixes 2, 3, and 4 (async queue/non-blocking health, Whisper biasing, sparse JSON SOAP + drug/allergy matching)."""
from __future__ import annotations

import json
import threading
import time
import types
from pathlib import Path

from conftest import FakeMLProvider
from config import ServingConfig
from providers import MLProvider, VET_OBJECTIVE_PARAMS, _vet_hydrated_story
from vet_glossary import (
    VET_APPROVED_VACCINES,
    VET_DRUG_CATALOG,
    build_whisper_initial_prompt,
    clean_asr_transcript,
    resolve_drug_name,
)


def test_whisper_initial_prompts_stay_under_180_words_and_contain_critical_terms():
    en_prompt = build_whisper_initial_prompt("en")
    ur_prompt = build_whisper_initial_prompt("ur")
    for term in (
        "otitis externa",
        "conjunctival hyperemia",
        "serous discharge",
        "erythematous",
        "gingivitis",
        "auscultation",
        "palpation",
        "subcutaneous",
        "borborygmi",
        "Sulfonamides",
        "Penicillin",
        "NSAIDs",
        "Carprofen",
        "Simplicef",
        "cefpodoxime",
        "Terramycin",
        "Rimadyl",
        "Gabapentin",
        "Posatex",
        "Epi-Otic",
        "Clavamox",
        "Metacam",
        "Apoquel",
        "Semintra",
        "Revolution Plus",
        "Cerenia",
        "Metronidazole",
        "FortiFlora",
        "DHPP",
        "Bordetella",
        "Leptospirosis",
        "FVRCP",
        "Rabies",
    ):
        assert term.lower() in en_prompt.lower(), f"Missing {term!r} in EN prompt"
    for term in ("doktor sahab", "bukhar", "ulti", "dast", "cefpodoxime", "Sulfonamides", "FVRCP"):
        assert term.lower() in ur_prompt.lower(), f"Missing {term!r} in UR prompt"
    # Whisper prompt budget ceiling sanity: < ~180 tokens
    assert len(en_prompt.split()) < 110
    assert len(ur_prompt.split()) < 120


def test_whisper_ur_and_en_prompt_plus_max_new_tokens_never_exceeds_448():
    import numpy as np
    from transformers import (
        GenerationConfig,
        WhisperConfig,
        WhisperForConditionalGeneration,
        WhisperProcessor,
    )

    cfg_serving = ServingConfig()
    processor = WhisperProcessor.from_pretrained(str(cfg_serving.asr_adapter_dir))
    tiny_cfg = WhisperConfig(
        vocab_size=processor.tokenizer.vocab_size + 500,
        num_mel_bins=80,
        encoder_layers=1,
        decoder_layers=1,
        encoder_attention_heads=1,
        decoder_attention_heads=1,
        d_model=16,
        encoder_ffn_dim=16,
        decoder_ffn_dim=16,
        max_target_positions=448,
    )
    tiny_model = WhisperForConditionalGeneration(tiny_cfg)
    tiny_model.generation_config = GenerationConfig.from_pretrained(
        cfg_serving.asr_base_model, local_files_only=True
    )
    tiny_model.generation_config.forced_decoder_ids = None
    dummy_audio = np.zeros(16000, dtype=np.float32)
    feats = processor.feature_extractor(
        dummy_audio, sampling_rate=16000, return_attention_mask=True, return_tensors="pt"
    )
    for lang_key, lang_whisper in (("ur", "urdu"), ("en", "english"), ("auto", None)):
        prompt_text = build_whisper_initial_prompt(lang_key)
        pids = processor.get_prompt_ids(prompt_text, return_tensors="pt")
        max_prompt = max(0, min(180, 448 - cfg_serving.asr_max_new_tokens - 8))
        if len(pids) > max_prompt:
            pids = pids[:max_prompt]
        eff_max = min(cfg_serving.asr_max_new_tokens, max(1, 448 - len(pids) - 8))
        assert len(pids) + 8 + eff_max <= 448
        gen_kwargs = {
            "input_features": feats.input_features,
            "attention_mask": feats.attention_mask,
            "prompt_ids": pids,
            "task": "transcribe",
            "condition_on_prev_tokens": False,
            "max_new_tokens": eff_max,
        }
        if lang_whisper is not None:
            gen_kwargs["language"] = lang_whisper
        # Verify real transformers generate() with language + task + prompt_ids never raises ValueError
        out = tiny_model.generate(**gen_kwargs)
        assert out.shape[0] == 1


def test_clean_asr_transcript_normalizes_structure_only():
    raw = "  doctor:   he is eating well ,  no vomiting..  owner : good  "
    cleaned = clean_asr_transcript(raw)
    assert cleaned.startswith("Doctor: he is eating well, no vomiting.")
    assert "Owner" in cleaned or "owner" in cleaned


def test_sparse_json_soap_hydration_skips_explicitly_skipped_vitals_and_preserves_polarity():
    transcript = (
        "Owner says Bruno has no loss of appetite, is drinking normally, and has had no vomiting "
        "or diarrhea for 4 days. Known allergies: Beta-Lactam. Physical exam: skipped temperature today "
        "because he was anxious, heart rate 120 bpm, weight 18.4 kg, right ear canal shows serous discharge "
        "and is erythematous, mild gingivitis on oral exam. Prescribe Kef Podoxyme 100 mg once daily "
        "for 7 days and apply terebrizin ointment to left eye twice daily for 5 days."
    )
    sparse_json = json.dumps(
        {
            "subjective": {
                "clinical_summary": (
                    "Bruno presents with a 4-day history. Owner reports no loss of appetite, "
                    "normal water intake, and no vomiting or diarrhea."
                ),
                "appetite": "no loss of appetite (normal)",
                "water_intake": "drinking normally",
                "vomiting_diarrhea": "no vomiting or diarrhea",
                "duration": "4 days",
                "known_allergies": "Beta-Lactam",
            },
            "objective": {
                "Temperature": "101.5 F",  # should be dropped because vet explicitly skipped temperature
                "Heart Rate": "120 bpm",
                "Weight": "18.4 kg",
                "Ears": "right ear canal serous discharge, erythematous",
                "Oral/Dental": "mild gingivitis",
            },
            "assessment": ["Acute otitis externa and mild gingivitis."],
            "plan": {
                "medications": [
                    {
                        "spoken_name": "Kef Podoxyme",
                        "dose": "100 mg",
                        "route": "oral",
                        "frequency": "once daily",
                        "duration": "7 days",
                    },
                    {
                        "spoken_name": "terebrizin",
                        "dose": "1 ribbon",
                        "route": "left eye",
                        "frequency": "twice daily",
                        "duration": "5 days",
                    },
                ],
                "vaccines_administered": [],
                "diagnostics": [],
                "procedures": [],
                "home_care": [],
                "follow_up": "7 days",
            },
        }
    )
    draft_text, sections, unknown, drops = _vet_hydrated_story(sparse_json, transcript=transcript)
    obj = sections["objective_map"]
    assert list(obj.keys()) == list(VET_OBJECTIVE_PARAMS)
    assert obj["Temperature"] == "Not mentioned"
    assert obj["Heart Rate"] == "120 bpm"
    assert obj["Weight"] == "18.4 kg"
    assert "serous discharge" in obj["Ears"]
    assert "gingivitis" in obj["Oral/Dental"]
    assert "no loss of appetite" in sections["subjective"].lower()
    assert "no vomiting" in sections["subjective"].lower()
    assert "Pyridium" not in draft_text
    assert "Kef Podoxyme" in draft_text
    assert "terebrizin" in draft_text


    # Verify truncated end-of-budget JSON recovers cleanly without leaking JSON syntax
    truncated = (
        '{"subjective":{"clinical_summary":"Bruno has no vomiting."},'
        '"objective":{"Weight":"18.4 kg","Temperature":"101.5 F"},'
        '"assessment":["Otitis"],'
        '"plan":{"medications":[{"spoken_name":"Kef Podoxyme","dose":"100 mg"}],"home_care":["'
    )
    t_draft, t_sec, _, _ = _vet_hydrated_story(truncated, transcript=transcript)
    assert "{" not in t_draft and "}" not in t_draft
    assert t_sec["objective_map"]["Weight"] == "18.4 kg"
    assert t_sec["objective_map"]["Temperature"] == "Not mentioned"
    assert "Kef Podoxyme" in t_sec["plan"]


def test_two_stage_drug_and_allergy_resolver_tiers():
    # High confidence catalog + Beta-Lactam allergy cross-check
    cefpod = resolve_drug_name("cefpodoxime", ["Penicillin", "Beta-Lactam"])
    assert cefpod["tier"] == "high"
    assert cefpod["matched_canonical"] == "Simplicef (Cefpodoxime Proxetil)"
    assert cefpod["status"] == "MISMATCH"
    assert cefpod["blocks_confirmation"] is True

    # Medium confidence ("Needs Confirmation — Did you mean ...?")
    ter = resolve_drug_name("terebrizin", [])
    assert ter["tier"] == "medium"
    assert ter["status"] == "NEEDS_REVIEW"
    assert "Did you mean Terramycin Ophthalmic Ointment?" in (ter["prompt_text"] or "")
    assert ter["blocks_confirmation"] is True

    # Low confidence -> [UNVERIFIED DRUG: "<verbatim>"] with NO unrelated substitute
    unk = resolve_drug_name("mysterypotion99", [])
    assert unk["tier"] == "low"
    assert unk["status"] == "UNKNOWN"
    assert unk["display_label"] == '[UNVERIFIED DRUG: "mysterypotion99"]'
    assert unk["matched_canonical"] is None
    assert unk["blocks_confirmation"] is True


def test_draft_jobs_alias_routes_and_nonblocking_health(app, client, wav16k):
    gate = threading.Event()

    class SlowTranscribeProvider(FakeMLProvider):
        def transcribe(self, samples, sample_rate, audio_bytes=None, language="ur"):
            gate.wait(timeout=2.0)
            return super().transcribe(samples, sample_rate, audio_bytes=audio_bytes, language=language)

    app.state.container.ml = SlowTranscribeProvider()

    trans_res = {}

    def _run_transcribe():
        trans_res["resp"] = client.post(
            "/transcribe",
            files={"audio": ("clip.wav", wav16k, "audio/wav")},
            data={"language": "en"},
        )

    t = threading.Thread(target=_run_transcribe)
    t.start()
    time.sleep(0.05)

    t0 = time.perf_counter()
    h = client.get("/health")
    health_ms = (time.perf_counter() - t0) * 1000.0
    assert h.status_code == 200
    assert health_ms < 250.0  # non-blocking asyncio.to_thread leaves /health responsive

    gate.set()
    t.join(timeout=3.0)
    assert trans_res["resp"].status_code == 200

    # Test /draft-jobs aliases
    r = client.post("/draft-jobs", json={"transcript": "Leo weighs 24.5 kg."})
    assert r.status_code == 202
    jid = r.json()["job_id"]
    st = client.get(f"/draft-jobs/{jid}")
    assert st.status_code == 200
    assert "stage_label" in st.json()
