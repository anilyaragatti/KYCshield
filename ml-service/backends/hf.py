"""Hugging Face image and audio classification backend."""

import io
import logging
import time

import numpy as np
import soundfile as sf
import torch
from PIL import Image
from scipy.signal import resample_poly
from transformers import pipeline

logger = logging.getLogger("kycshield.ml.hf")
FAKE_WORDS = ("fake", "deepfake", "spoof", "synthetic", "ai")


def fake_probability(outputs, id2label, fake_label_setting):
    """Return (fake probability, selected class label); never guess a class."""
    if isinstance(outputs, dict):
        outputs = [outputs]
    if not isinstance(outputs, list) or not outputs:
        return None, None

    labels = {str(index): str(label) for index, label in (id2label or {}).items()}
    # Normalize common JSON/stringified config keys such as "0".
    normalized_labels = {}
    for index, label in labels.items():
        normalized_labels[index.casefold()] = label
        normalized_labels[f"label_{index}".casefold()] = label
        normalized_labels[label.casefold()] = label

    selected = None
    if fake_label_setting is not None and str(fake_label_setting).strip():
        setting = str(fake_label_setting).strip().casefold()
        chosen_label = normalized_labels.get(setting)
        if chosen_label is None:
            logger.error("Configured fake label %r does not match model labels %s", fake_label_setting, list(labels.values()))
            return None, None
        selected = next((item for item in outputs if str(item.get("label", "")).casefold() in {
            setting, chosen_label.casefold(),
            next((key for key, value in normalized_labels.items() if value.casefold() == chosen_label.casefold() and key.startswith("label_")), "")
        }), None)
        if selected is None:
            # Pipelines may return numeric class indices rather than config names.
            class_index = next((key for key, value in labels.items() if value == chosen_label), None)
            selected = next((item for item in outputs if str(item.get("label", "")).casefold() == str(class_index).casefold()), None)
    else:
        for item in outputs:
            output_label = str(item.get("label", "")).casefold()
            configured_label = normalized_labels.get(output_label, output_label)
            if any(word in configured_label.casefold() for word in FAKE_WORDS):
                selected = item
                break

    if selected is None:
        return None, None
    try:
        score = float(selected["score"])
    except (KeyError, TypeError, ValueError):
        return None, None
    if not np.isfinite(score) or not 0 <= score <= 1:
        return None, None
    return score, str(selected.get("label", ""))


def calibrate_probability(probability, threshold):
    if probability is None:
        return None
    threshold = float(threshold)
    if not 0 < threshold < 1:
        raise ValueError("Calibration thresholds must be greater than 0 and less than 1.")
    if probability <= threshold:
        return 0.5 * probability / threshold
    return 0.5 + 0.5 * (probability - threshold) / (1 - threshold)


class HuggingFaceDetector:
    def __init__(self, face_model_id=None, audio_model_id=None, *, face_fake_label=None,
                 audio_fake_label=None, face_threshold=0.5, audio_threshold=0.5,
                 hf_device="auto", audio_window_sec=2.0):
        self.face_model_id = face_model_id
        self.audio_model_id = audio_model_id
        self.face_fake_label = face_fake_label
        self.audio_fake_label = audio_fake_label
        self.face_threshold = float(face_threshold)
        self.audio_threshold = float(audio_threshold)
        self.hf_device = hf_device
        self.audio_window_sec = float(audio_window_sec)
        if not 0 < self.face_threshold < 1 or not 0 < self.audio_threshold < 1:
            raise ValueError("FACE_THRESHOLD and AUDIO_THRESHOLD must be between 0 and 1.")
        if self.audio_window_sec <= 0:
            raise ValueError("AUDIO_WINDOW_SEC must be positive.")
        self.device = None
        self.device_name = None
        self.face_pipeline = self.audio_pipeline = None
        self.face_labels = self.audio_labels = []
        self.face_fake_chosen = self.audio_fake_chosen = None
        self.load_seconds = {"face": None, "audio": None}

    async def load(self):
        if self.hf_device not in {"auto", "cpu", "cuda"}:
            raise ValueError("HF_DEVICE must be auto, cpu, or cuda.")
        use_cuda = torch.cuda.is_available()
        if self.hf_device == "cuda" and not use_cuda:
            raise RuntimeError("HF_DEVICE=cuda but CUDA is unavailable.")
        self.device = 0 if self.hf_device == "cuda" or (self.hf_device == "auto" and use_cuda) else -1
        self.device_name = "cuda" if self.device == 0 else "cpu"

        if self.face_model_id:
            started = time.perf_counter()
            self.face_pipeline = pipeline("image-classification", model=self.face_model_id, device=self.device, top_k=None)
            self.load_seconds["face"] = round(time.perf_counter() - started, 3)
            self.face_labels = self._labels(self.face_pipeline)
            warm_started = time.perf_counter()
            self.face_pipeline(Image.new("RGB", (224, 224), color="black"))
            logger.info("Face model load_seconds=%.3f warmup_seconds=%.3f", self.load_seconds["face"], time.perf_counter() - warm_started)
        if self.audio_model_id:
            started = time.perf_counter()
            self.audio_pipeline = pipeline("audio-classification", model=self.audio_model_id, device=self.device, top_k=None)
            self.load_seconds["audio"] = round(time.perf_counter() - started, 3)
            self.audio_labels = self._labels(self.audio_pipeline)
            warm_started = time.perf_counter()
            sample_rate = int(self.audio_pipeline.feature_extractor.sampling_rate)
            self.audio_pipeline({"raw": np.zeros(sample_rate, dtype=np.float32), "sampling_rate": sample_rate})
            logger.info("Audio model load_seconds=%.3f warmup_seconds=%.3f", self.load_seconds["audio"], time.perf_counter() - warm_started)

        self.face_fake_chosen = self._resolve_fake_name(self.face_labels, self.face_fake_label)
        self.audio_fake_chosen = self._resolve_fake_name(self.audio_labels, self.audio_fake_label)

    @staticmethod
    def _labels(model_pipeline):
        mapping = getattr(model_pipeline.model.config, "id2label", {}) or {}
        ordered = sorted(mapping.items(), key=lambda pair: (0, int(pair[0])) if str(pair[0]).isdigit() else (1, str(pair[0])))
        return [str(label) for _, label in ordered]

    @staticmethod
    def _resolve_fake_name(labels, setting):
        if setting:
            setting = str(setting).strip().casefold()
            for index, label in enumerate(labels):
                if setting in {label.casefold(), str(index), f"label_{index}"}:
                    return label
            return None
        return next((label for label in labels if any(word in label.casefold() for word in FAKE_WORDS)), None)

    def details(self):
        return {
            "device": self.device_name,
            "face_labels": self.face_labels,
            "audio_labels": self.audio_labels,
            "face_fake_label": self.face_fake_chosen,
            "audio_fake_label": self.audio_fake_chosen,
            "face_threshold": self.face_threshold,
            "audio_threshold": self.audio_threshold,
            "load_seconds": self.load_seconds,
        }

    def _score(self, modality, outputs):
        labels = self.face_labels if modality == "face" else self.audio_labels
        setting = self.face_fake_label if modality == "face" else self.audio_fake_label
        threshold = self.face_threshold if modality == "face" else self.audio_threshold
        raw_score, selected = fake_probability(outputs, {str(i): label for i, label in enumerate(labels)}, setting)
        if raw_score is None:
            env_name = "FACE_FAKE_LABEL" if modality == "face" else "AUDIO_FAKE_LABEL"
            logger.error("Could not map a fake class for %s model; set %s to one of its labels or class index. Labels: %s", modality, env_name, labels)
            return {"score": None, "raw_score": None, "note": "label_mapping_unknown"}
        self.face_fake_chosen = selected if modality == "face" else self.face_fake_chosen
        self.audio_fake_chosen = selected if modality == "audio" else self.audio_fake_chosen
        return {
            "score": calibrate_probability(raw_score, threshold),
            "raw_score": raw_score,
            "note": f"calibrated, threshold={threshold:g}",
        }

    async def detect(self, modality: str, data: bytes):
        if modality == "face":
            if not self.face_pipeline:
                return {"score": None, "raw_score": None, "note": "model_not_configured"}
            face = self._largest_face(data)
            if face is None:
                return {"score": None, "raw_score": None, "note": "no_face"}
            return self._score("face", self.face_pipeline(face))

        if modality == "audio":
            if not self.audio_pipeline:
                return {"score": None, "raw_score": None, "note": "model_not_configured"}
            try:
                samples, sample_rate = sf.read(io.BytesIO(data), dtype="float32", always_2d=True)
            except (RuntimeError, OSError, ValueError) as error:
                raise ValueError("Audio must be a readable WAV file.") from error
            if samples.size == 0 or sample_rate <= 0:
                raise ValueError("Audio WAV contains no readable samples.")
            mono = samples.mean(axis=1)
            if sample_rate != 16_000:
                mono = resample_poly(mono, 16_000, int(sample_rate)).astype(np.float32)
            target_length = max(1, round(self.audio_window_sec * 16_000))
            mono = mono[:target_length]
            if len(mono) < target_length:
                mono = np.pad(mono, (0, target_length - len(mono)))
            peak = float(np.max(np.abs(mono))) if mono.size else 0.0
            rms = float(np.sqrt(np.mean(np.square(mono)))) if mono.size else 0.0
            if rms < 1e-5:
                return {"score": None, "raw_score": None, "note": "silence"}
            mono = (mono / max(peak, 1e-8)).astype(np.float32)
            outputs = self.audio_pipeline({"raw": mono, "sampling_rate": 16_000})
            return self._score("audio", outputs)

        raise ValueError("Unsupported detection modality.")

    @staticmethod
    def _largest_face(data: bytes):
        import cv2

        try:
            with Image.open(io.BytesIO(data)) as image:
                if image.format != "JPEG":
                    raise ValueError("Frame must be a readable JPEG image.")
                image.load()
        except Exception as error:
            raise ValueError("Frame must be a readable JPEG image.") from error
        frame = cv2.imdecode(np.frombuffer(data, dtype=np.uint8), cv2.IMREAD_COLOR)
        if frame is None:
            raise ValueError("Frame must be a readable JPEG image.")
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        cascade = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
        faces = cascade.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=5, minSize=(60, 60))
        faces = [face for face in faces if face[2] >= 60 and face[3] >= 60]
        if not faces:
            return None
        x, y, width, height = max(faces, key=lambda box: int(box[2]) * int(box[3]))
        margin_x, margin_y = int(width * 0.12), int(height * 0.12)
        left, top = max(0, x - margin_x), max(0, y - margin_y)
        right, bottom = min(frame.shape[1], x + width + margin_x), min(frame.shape[0], y + height + margin_y)
        return Image.fromarray(cv2.cvtColor(frame[top:bottom, left:right], cv2.COLOR_BGR2RGB))
