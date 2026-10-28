"""resolve_scale unit tests - artifact-agnostic (inline manifests, no disk).

These pin the model_scale labeling CONTRACT documented in ../README.md:
tags from manifests win; pre-tag manifests derive an honestly-labeled
assumption; nothing is ever fabricated.
"""
from __future__ import annotations

from providers import resolve_scale


def test_tagged_manifest_wins():
    label, source = resolve_scale({"model_scale": "full", "train_rows": 1200})
    assert label == "FULL" and source == "training_manifest.model_scale"


def test_pretag_small_rows_derives_smoke():
    label, source = resolve_scale({"train_rows": 180})  # run-8 ASR manifest shape
    assert label.startswith("SMOKE(assumed") and source == "derived_from_train_rows"
    label, _ = resolve_scale({"train_rows": 100})       # run-8 SOAP manifest shape
    assert label.startswith("SMOKE(assumed")


def test_pretag_large_rows_derives_untagged():
    label, source = resolve_scale({"train_rows": 4000})
    assert label.startswith("UNTAGGED(assumed") and source == "derived_from_train_rows"


def test_missing_manifest_is_unknown():
    assert resolve_scale(None)[0].startswith("UNKNOWN")


def test_corrupt_manifest_is_unknown_with_reason():
    label, source = resolve_scale({"_corrupt_manifest": True})
    assert label.startswith("UNKNOWN") and source == "unreadable"
