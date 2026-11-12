"""Scenario-driven mock detector used before pretrained models are configured."""

import io
import random
import wave

from PIL import Image


class MockDetector:
    def __init__(self):
        self.scenario = {"face": "real", "audio": "real"}

    def set_scenario(self, values):
        self.scenario.update(values)

    async def detect(self, modality: str, data: bytes):
        if modality == "face":
            self._validate_image(data)
        elif modality == "audio":
            self._validate_wav(data)
        else:
            raise ValueError("Unsupported detection modality.")

        if self.scenario[modality] == "fake":
            score = random.uniform(0.70, 0.95)
        else:
            score = random.uniform(0.05, 0.25)
        return round(score, 4), "mock scores, not real detection"

    @staticmethod
    def _validate_image(data: bytes):
        try:
            with Image.open(io.BytesIO(data)) as image:
                if image.format != "JPEG":
                    raise ValueError("Frame must be a readable JPEG image.")
                image.load()
        except Exception as error:
            if isinstance(error, ValueError) and str(error) == "Frame must be a readable JPEG image.":
                raise
            raise ValueError("Frame must be a readable JPEG image.") from error

    @staticmethod
    def _validate_wav(data: bytes):
        try:
            with wave.open(io.BytesIO(data), "rb") as wav_file:
                if wav_file.getnframes() < 1 or wav_file.getframerate() < 1:
                    raise ValueError("Audio WAV contains no readable samples.")
                wav_file.readframes(wav_file.getnframes())
        except (wave.Error, EOFError, OSError) as error:
            raise ValueError("Audio must be a readable WAV file.") from error
