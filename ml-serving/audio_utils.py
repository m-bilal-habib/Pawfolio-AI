"""VoxSOAP ML serving - audio decoding helpers.

Strategy (honest-by-default):
  1. soundfile (libsndfile) decodes any supp format when installed - the real
     inference environments (64-bit Python / Colab) have it.
  2. Without soundfile, only RIFF/WAVE PCM is decoded with the stdlib `wave`
     module so the MOCKED test env (32-bit Python, no soundfile) still works.
  3. Anything undecodable raises AudioDecodeError -> honest 400 at the API.

The 16 kHz rule is enforced at the API layer: the server does NOT silently
resample, and a wrong rate is an explicit error, not garbage output.
"""
from __future__ import annotations

import io
import struct
import wave
from typing import Any, List, Tuple


class AudioDecodeError(Exception):
    """Raised when audio cannot be decoded - mapped to an honest 400."""


def decode(data: bytes) -> Tuple[Any, int]:
    """Decode uploaded audio bytes -> (samples_list_or_array, sample_rate)."""
    if not data:
        raise AudioDecodeError("empty audio upload")
    if len(data) >= 4 and data[:3] == b"ftyp" or b"ftyp" in data[:64]:
        raise AudioDecodeError(
            "M4A/MP4 container detected: this scaffold requires WAV (PCM) audio; "
            "install soundfile in the serving environment to accept other containers"
        )
    try:
        return _decode_soundfile(data)
    except AudioDecodeError:
        raise
    except ImportError:
        return _decode_stdlib_wave(data)
    except Exception as err:  # soundfile present but decode failed
        raise AudioDecodeError(f"soundfile could not decode the upload: {type(err).__name__}: {err}") from err


def _decode_soundfile(data: bytes) -> Tuple[Any, int]:
    import numpy as np
    import soundfile as sf

    with sf.SoundFile(io.BytesIO(data)) as handle:
        sample_rate = int(handle.samplerate)
        frames = handle.read(dtype="float32", always_2d=True)
    if frames.size == 0:
        raise AudioDecodeError("audio file decodes to zero samples")
    if frames.shape[1] > 1:  # never assume mono from the container name
        mono = frames.mean(axis=1)
    else:
        mono = frames[:, 0]
    return mono.astype(np.float32), sample_rate


def _decode_stdlib_wave(data: bytes) -> Tuple[List[float], int]:
    if len(data) < 12 or data[:4] != b"RIFF" or data[8:12] != b"WAVE":
        raise AudioDecodeError(
            "soundfile is not installed and the upload is not a RIFF/WAVE file; "
            "please upload 16 kHz mono PCM WAV (or install soundfile for other formats)"
        )
    with wave.open(io.BytesIO(data), "rb") as handle:
        channels = handle.getnchannels()
        width = handle.getsampwidth()
        sample_rate = handle.getframerate()
        if handle.getcomptype() != "NONE":
            raise AudioDecodeError("compressed WAV requires soundfile (not installed here)")
        raw = handle.readframes(handle.getnframes())
    if not raw:
        raise AudioDecodeError("audio file decodes to zero samples")
    if channels <= 0:
        raise AudioDecodeError(f"invalid channel count {channels}")
    if width == 2:
        samples = [v / 32768.0 for v in struct.unpack(f"<{len(raw) // 2}h", raw)]
    elif width == 1:
        samples = [(b - 128) / 128.0 for b in raw]
    elif width == 4:
        samples = [v / 2147483648.0 for v in struct.unpack(f"<{len(raw) // 4}i", raw)]
    else:
        raise AudioDecodeError(f"unsupported PCM bit width {width * 8} (16/24/32-bit need soundfile)")
    if channels > 1:
        mono = [
            sum(samples[i:i + channels]) / channels
            for i in range(0, len(samples) - channels + 1, channels)
        ]
    else:
        mono = samples
    return mono, sample_rate
