"""Generate in-memory image/audio samples and call the local detector API."""

import io
import math
import os
import struct
import wave

import requests
from PIL import Image

BASE_URL = os.getenv("KYCSHIELD_ML_URL", "http://127.0.0.1:8000")


def make_jpeg():
    image = Image.new("RGB", (160, 120), color=(180, 160, 145))
    output = io.BytesIO()
    image.save(output, format="JPEG")
    return output.getvalue()


def make_wav():
    sample_rate = 16_000
    duration_seconds = 2
    frequency = 440
    output = io.BytesIO()
    with wave.open(output, "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(sample_rate)
        samples = bytearray()
        for index in range(sample_rate * duration_seconds):
            value = int(12_000 * math.sin(2 * math.pi * frequency * index / sample_rate))
            samples.extend(struct.pack("<h", value))
        wav_file.writeframes(samples)
    return output.getvalue()


def post_file(path, name, payload, content_type):
    response = requests.post(
        f"{BASE_URL}{path}",
        files={"file": (name, payload, content_type)},
        timeout=30,
    )
    response.raise_for_status()
    return response.json()


def main():
    health = requests.get(f"{BASE_URL}/health", timeout=10)
    health.raise_for_status()
    health_data = health.json()
    print("health:", health_data)

    frame_result = post_file("/frame", "test.jpg", make_jpeg(), "image/jpeg")
    audio_result = post_file("/audio", "test.wav", make_wav(), "audio/wav")
    print("frame:", frame_result)
    print("audio:", audio_result)

    if health_data["backend"] == "mock":
        scenario = requests.post(
            f"{BASE_URL}/mock/scenario",
            json={"face": "fake", "audio": "fake"},
            timeout=10,
        )
        scenario.raise_for_status()
        print("scenario:", scenario.json())
        print("fake frame:", post_file("/frame", "test.jpg", make_jpeg(), "image/jpeg"))
        print("fake audio:", post_file("/audio", "test.wav", make_wav(), "audio/wav"))


if __name__ == "__main__":
    main()
