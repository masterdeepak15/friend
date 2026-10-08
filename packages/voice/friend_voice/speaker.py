"""Speaker embeddings (voiceprints) with WeSpeaker ResNet34 through sherpa-onnx (CPU)."""

from __future__ import annotations

import threading

from .stt import SAMPLE_RATE, decode_audio

#: Less speech than this is not enough to tell who is talking.
MIN_SPEECH_SECONDS = 1.2


def voiced_seconds(samples) -> float:
    """Seconds of audio that are clearly louder than the background (a simple, adaptive energy gate)."""
    import numpy as np

    frame = SAMPLE_RATE // 50  # 20 ms
    n = len(samples) // frame
    if n == 0:
        return 0.0
    rms = np.sqrt(np.mean(samples[: n * frame].reshape(n, frame) ** 2, axis=1))
    gate = max(0.008, 0.25 * float(np.percentile(rms, 90)))
    return float(np.count_nonzero(rms > gate)) * 0.02


class SherpaSpeaker:
    def __init__(self, model_path: str, threads: int = 2) -> None:
        import sherpa_onnx

        cfg = sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=model_path, num_threads=threads, provider="cpu")
        self._extractor = sherpa_onnx.SpeakerEmbeddingExtractor(cfg)
        self._lock = threading.Lock()

    def embed(self, audio: bytes) -> dict:
        import numpy as np

        samples = decode_audio(audio)  # bounded decode: hostile or huge input is refused here
        speech = voiced_seconds(samples)
        if speech < MIN_SPEECH_SECONDS:
            raise ValueError("not enough speech to recognize a voice (speak for about two seconds)")
        with self._lock:
            stream = self._extractor.create_stream()
            stream.accept_waveform(sample_rate=SAMPLE_RATE, waveform=samples)
            stream.input_finished()
            vec = np.array(self._extractor.compute(stream), dtype=np.float32)
        norm = float(np.linalg.norm(vec))
        if norm == 0.0:
            raise ValueError("could not compute a voiceprint from this audio")
        vec /= norm
        return {"embedding": [round(float(x), 6) for x in vec], "seconds": round(speech, 2)}
