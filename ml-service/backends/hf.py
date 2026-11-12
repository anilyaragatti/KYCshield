"""Lazy Hugging Face image and audio classification backend."""

import io
import logging
import warnings

import numpy as np
import soundfile as sf
import torch
from PIL import Image
from transformers import pipeline

logger = logging.getLogger("kycshield.ml.hf")
FAKE_LABEL_WORDS = ("fake", "spoof", "synthetic", "deepfake")


def fake_probability(outputs):
    """Select the fake-like label score; adjust keywords for model-specific labels."""
    if isinstance(outputs, dict):
        outputs = [outputs]
    if not isinstance(outputs, list) or not outputs:
        raise ValueError("The model returned no classification labels.")
    fake_match = next(
        (item for item in outputs if any(word in str(item.get("label", "")).lower() for word in FAKE_LABEL_WORDS)),
        None,
    )
    if fake_match is not None:
        return float(fake_match["score"])
    warnings.warn("Model labels do not identify a fake class; using the second output label. Adjust fake_probability() for this model.", RuntimeWarning)
    logger.warning("Model labels are unclear; using the second output label as the fake probability.")
    selected = outputs[1] if len(outputs) > 1 else outputs[0]
    return float(selected["score"])


class HuggingFaceDetector:
    def __init__(self, face_model_id, audio_model_id):
        self.face_model_id = face_model_id
        self.audio_model_id = audio_model_id
        self.face_pipeline = None
        self.audio_pipeline = None

    async def load(self):
        device = 0 if torch.cuda.is_available() else -1
        if self.face_model_id:
            self.face_pipeline = pipeline("image-classification", model=self.face_model_id, device=device)
        if self.audio_model_id:
            self.audio_pipeline = pipeline("audio-classification", model=self.audio_model_id, device=device)

    async def detect(self, modality: str, data: bytes):
        if modality == "face":
            if not self.face_pipeline:
                return None, "model_not_configured"
            face = self._largest_face(data)
            if face is None:
                return None, "no_face"
            outputs = self.face_pipeline(face)
            return fake_probability(outputs), None

        if modality == "audio":
            if not self.audio_pipeline:
                return None, "model_not_configured"
            try:
                samples, sample_rate = sf.read(io.BytesIO(data), dtype="float32", always_2d=True)
            except (RuntimeError, OSError, ValueError) as error:
                raise ValueError("Audio must be a readable WAV file.") from error
            if samples.size == 0:
                raise ValueError("Audio WAV contains no readable samples.")
            mono = samples.mean(axis=1)
            expected_rate = int(self.audio_pipeline.feature_extractor.sampling_rate)
            if sample_rate != expected_rate:
                mono = self._resample(mono, int(sample_rate), expected_rate)
                sample_rate = expected_rate
            outputs = self.audio_pipeline({"raw": mono, "sampling_rate": sample_rate})
            return fake_probability(outputs), None

        raise ValueError("Unsupported detection modality.")

    @staticmethod
    def _largest_face(data: bytes):
        import cv2

        try:
            image = Image.open(io.BytesIO(data))
            if image.format != "JPEG":
                raise ValueError("Frame must be a readable JPEG image.")
            image.load()
        except Exception as error:
            raise ValueError("Frame must be a readable JPEG image.") from error
        encoded = np.frombuffer(data, dtype=np.uint8)
        frame = cv2.imdecode(encoded, cv2.IMREAD_COLOR)
        if frame is None:
            raise ValueError("Frame must be a readable JPEG image.")
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        cascade_path = cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
        cascade = cv2.CascadeClassifier(cascade_path)
        faces = cascade.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=5, minSize=(30, 30))
        if len(faces) == 0:
            return None
        x, y, width, height = max(faces, key=lambda box: int(box[2]) * int(box[3]))
        margin_x, margin_y = int(width * 0.12), int(height * 0.12)
        left, top = max(0, x - margin_x), max(0, y - margin_y)
        right = min(frame.shape[1], x + width + margin_x)
        bottom = min(frame.shape[0], y + height + margin_y)
        rgb_face = cv2.cvtColor(frame[top:bottom, left:right], cv2.COLOR_BGR2RGB)
        return Image.fromarray(rgb_face)

    @staticmethod
    def _resample(samples, source_rate, target_rate):
        if source_rate <= 0:
            raise ValueError("Audio WAV has an invalid sample rate.")
        target_length = max(1, round(len(samples) * target_rate / source_rate))
        old_positions = np.arange(len(samples), dtype=np.float64)
        new_positions = np.linspace(0, max(0, len(samples) - 1), target_length)
        return np.interp(new_positions, old_positions, samples).astype(np.float32)
