"""Resumable, hash-verified downloader for GGUF model blobs (2026-11-20).

WHY THIS EXISTS: on the owner's network, HuggingFace's CDN throttled a single
stream to ~0.03 MB/s and dropped connections after 7-14 MB (hf_transfer cannot
follow the Xet redirect without `hf_xet`, which must stay uninstalled). The
Ollama registry served the SAME Qwen2.5 GGUF weights at ~0.8 MB/s, so the
serving model is fetched from there by content digest.

The script resumes with HTTP Range requests (the registry supports them),
retries transient failures with backoff, and verifies the final file's
SHA-256 against the registry digest. A corrupt or truncated file is NEVER
left behind under the final name.

Usage (3B Qwen2.5-Instruct Q4_K_M, ~1.93 GB):
  .venv-ml64\\Scripts\\python.exe ml-serving\\scripts\\fetch_gguf_blob.py ^
    --url https://registry.ollama.ai/v2/library/qwen2.5/blobs/sha256:5ee4f07cdb9beadbbb293e85803c569b01bd37ed059d2715faa7bb405f31caa6 ^
    --sha256 5ee4f07cdb9beadbbb293e85803c569b01bd37ed059d2715faa7bb405f31caa6 ^
    --size 1929903008 ^
    --out ml-serving\\models\\qwen2.5-3b-instruct-q4_k_m.gguf

Ollama model blobs are standard GGUF files; llama-cpp-python loads them
directly via VOXSOAP_SOAP_GGUF_PATH (no Ollama runtime involved).
"""
from __future__ import annotations

import argparse
import hashlib
import sys
import time
from pathlib import Path

import requests

CHUNK = 1024 * 1024  # 1 MiB


def log(message: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {message}", flush=True)


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(4 * CHUNK), b""):
            digest.update(block)
    return digest.hexdigest()


def download(url: str, out: Path, expected_size: int, expected_sha: str) -> int:
    out.parent.mkdir(parents=True, exist_ok=True)
    part = out.with_suffix(out.suffix + ".part")

    # A previous run may have finished the transfer but died before rename.
    if out.exists() and expected_size and out.stat().st_size == expected_size:
        log(f"complete file already present: {out}")
        if sha256_of(out) == expected_sha:
            log("sha256 OK")
            return 0
        log("sha256 MISMATCH on existing file - re-downloading")
        out.unlink()

    attempt = 0
    last_report = 0.0
    while True:
        have = part.stat().st_size if part.exists() else 0
        if expected_size and have >= expected_size:
            break
        attempt += 1
        headers = {"Range": f"bytes={have}-"} if have else {}
        try:
            with requests.get(
                url, headers=headers, stream=True, timeout=(20, 120)
            ) as response:
                if response.status_code == 416:
                    # Range beyond EOF: if the size matches, we are done.
                    if expected_size and have == expected_size:
                        break
                    raise RuntimeError(f"HTTP 416 with {have} bytes on disk")
                response.raise_for_status()
                if have and response.status_code == 200:
                    # Server ignored Range: restart cleanly instead of
                    # appending a second copy.
                    log("server ignored Range - restarting from byte 0")
                    part.unlink(missing_ok=True)
                    have = 0
                mode = "ab" if have else "wb"
                written = have
                with part.open(mode) as handle:
                    for chunk in response.iter_content(CHUNK):
                        if not chunk:
                            continue
                        handle.write(chunk)
                        written += len(chunk)
                        now = time.time()
                        if now - last_report >= 10:
                            last_report = now
                            pct = (
                                f"{written * 100.0 / expected_size:5.1f}%"
                                if expected_size
                                else "?"
                            )
                            log(
                                f"{written / 1e6:8.1f} MB / "
                                f"{expected_size / 1e6:.1f} MB ({pct}) "
                                f"attempt {attempt}"
                            )
        except Exception as err:  # noqa: BLE001 - retry every transport error
            wait = min(30, 2 ** min(attempt, 5))
            log(f"attempt {attempt} interrupted: {type(err).__name__}: {err}")
            log(f"retrying in {wait}s (resume at {part.stat().st_size if part.exists() else 0} bytes)")
            time.sleep(wait)
            continue

    size = part.stat().st_size if part.exists() else 0
    if expected_size and size != expected_size:
        raise SystemExit(f"size mismatch: {size} != {expected_size}")
    log("verifying sha256 (this reads the whole file once)...")
    actual = sha256_of(part)
    if expected_sha and actual != expected_sha:
        bad = part.with_suffix(part.suffix + ".corrupt")
        part.replace(bad)
        raise SystemExit(
            f"sha256 mismatch: {actual} != {expected_sha}; moved to {bad.name}"
        )
    part.replace(out)
    log(f"OK {out} ({size / 1e9:.2f} GB) sha256={actual[:16]}...")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--sha256", default="")
    parser.add_argument("--size", type=int, default=0)
    args = parser.parse_args()
    return download(
        args.url, Path(args.out), args.size, args.sha256.strip().lower()
    )


if __name__ == "__main__":
    sys.exit(main())
