"""Evaluate configured HF models directly against labeled sample directories."""

import argparse
import asyncio
import csv
import io
import os
import statistics
import time
from pathlib import Path

import numpy as np
import soundfile as sf
from PIL import Image
from sklearn.metrics import roc_auc_score, roc_curve

from dotenv import load_dotenv

load_dotenv()


def read_audio(path):
    samples, sample_rate = sf.read(path, dtype="float32", always_2d=True)
    if not len(samples) or sample_rate <= 0:
        return np.empty(0, dtype=np.float32), int(sample_rate or 0)
    return samples.mean(axis=1), int(sample_rate)


def wav_bytes(samples, sample_rate):
    buffer = io.BytesIO()
    sf.write(buffer, samples, sample_rate, format="WAV", subtype="PCM_16")
    return buffer.getvalue()


def media_samples(real_dir, fake_dir, modality, window_sec):
    rows = []
    if modality == "face":
        extensions = {".jpg", ".jpeg", ".png"}
        for truth, directory in ((0, real_dir), (1, fake_dir)):
            if not directory:
                continue
            for path in sorted(Path(directory).glob("**/*")):
                if path.is_file() and path.suffix.lower() in extensions:
                    with Image.open(path) as image:
                        converted = image.convert("RGB")
                        out = io.BytesIO()
                        converted.save(out, format="JPEG", quality=90)
                        rows.append((path, truth, out.getvalue()))
        return rows

    window_length = max(1, int(round(window_sec * 16_000)))
    hop_length = 16_000
    for truth, directory in ((0, real_dir), (1, fake_dir)):
        if not directory:
            continue
        for path in sorted(Path(directory).glob("**/*")):
            if not path.is_file() or path.suffix.lower() not in {".wav", ".flac"}:
                continue
            samples, rate = read_audio(path)
            if rate <= 0:
                continue
            if rate != 16_000:
                from scipy.signal import resample_poly
                from math import gcd
                divisor = gcd(rate, 16_000)
                samples = resample_poly(samples, 16_000 // divisor, rate // divisor).astype(np.float32)
            if len(samples) == 0:
                continue
            offsets = range(0, max(1, len(samples)), hop_length)
            for offset in offsets:
                window = samples[offset:offset + window_length]
                if len(window) == 0:
                    continue
                if len(window) < window_length:
                    window = np.pad(window, (0, window_length - len(window)))
                rms = float(np.sqrt(np.mean(np.square(window))))
                if rms < 1e-5:
                    continue
                rows.append((f"{path}#window_{offset / 16_000:.1f}s", truth, wav_bytes(window, 16_000)))
                if offset + window_length >= len(samples):
                    break
    return rows


def metric_summary(rows, threshold):
    usable = [row for row in rows if row["raw_score"] is not None]
    y_true = np.array([row["truth"] for row in usable], dtype=int)
    raw = np.array([row["raw_score"] for row in usable], dtype=float)
    real = raw[y_true == 0]
    fake = raw[y_true == 1]
    accuracy = float(np.mean((raw >= threshold).astype(int) == y_true)) if len(usable) else None
    auc = eer = youden = None
    if len(np.unique(y_true)) == 2:
        auc = float(roc_auc_score(y_true, raw))
        fpr, tpr, thresholds = roc_curve(y_true, raw)
        fnr = 1 - tpr
        eer_index = int(np.argmin(np.abs(fpr - fnr)))
        eer = float((fpr[eer_index] + fnr[eer_index]) / 2)
        youden_index = int(np.argmax(tpr - fpr))
        youden = float(thresholds[youden_index])
    latencies = [row["latency_ms"] for row in rows]
    def percentile(values, value):
        return float(np.percentile(values, value)) if values else None
    return {
        "n_real": int(len(real)), "n_fake": int(len(fake)),
        "mean_real": float(np.mean(real)) if len(real) else None,
        "mean_fake": float(np.mean(fake)) if len(fake) else None,
        "accuracy": accuracy, "auc": auc, "eer": eer, "youden": youden,
        "latency_mean": statistics.fmean(latencies) if latencies else None,
        "latency_p50": percentile(latencies, 50), "latency_p95": percentile(latencies, 95),
        "ignored": len(rows) - len(usable),
    }


async def evaluate_modality(detector, modality, samples):
    results = []
    for filename, truth, data in samples:
        started = time.perf_counter()
        try:
            output = await detector.detect(modality, data)
        except Exception as error:
            print(f"Skipped {filename}: {error}")
            latency = (time.perf_counter() - started) * 1000
            results.append({
                "file": str(filename), "modality": modality,
                "truth": "fake" if truth else "real",
                "raw_score": None, "score": None, "latency_ms": latency,
            })
            continue
        latency = (time.perf_counter() - started) * 1000
        results.append({
            "file": str(filename), "modality": modality,
            "truth": "fake" if truth else "real",
            "raw_score": output.get("raw_score"), "score": output.get("score"),
            "latency_ms": latency,
        })
    return results


def fmt(value, digits=4):
    return "n/a" if value is None else f"{value:.{digits}f}"


async def main():
    parser = argparse.ArgumentParser(description="Evaluate the configured HF detector on labeled clips.")
    parser.add_argument("--face-real")
    parser.add_argument("--face-fake")
    parser.add_argument("--audio-real")
    parser.add_argument("--audio-fake")
    parser.add_argument("--out", default="results")
    args = parser.parse_args()

    from backends.hf import HuggingFaceDetector
    detector = HuggingFaceDetector(
        os.getenv("FACE_MODEL_ID", "").strip() or None,
        os.getenv("AUDIO_MODEL_ID", "").strip() or None,
        face_fake_label=os.getenv("FACE_FAKE_LABEL", "").strip() or None,
        audio_fake_label=os.getenv("AUDIO_FAKE_LABEL", "").strip() or None,
        face_threshold=float(os.getenv("FACE_THRESHOLD", "0.5")),
        audio_threshold=float(os.getenv("AUDIO_THRESHOLD", "0.5")),
        hf_device=os.getenv("HF_DEVICE", "auto").strip().lower(),
        audio_window_sec=float(os.getenv("AUDIO_WINDOW_SEC", "2")),
    )
    await detector.load()

    all_rows = []
    summaries = []
    for modality, real_dir, fake_dir, threshold in (
        ("face", args.face_real, args.face_fake, detector.face_threshold),
        ("audio", args.audio_real, args.audio_fake, detector.audio_threshold),
    ):
        if not real_dir and not fake_dir:
            continue
        if (modality == "face" and not detector.face_pipeline) or (modality == "audio" and not detector.audio_pipeline):
            print(f"Skipping {modality}: configure its model id in .env first.")
            continue
        samples = media_samples(real_dir, fake_dir, modality, detector.audio_window_sec)
        results = await evaluate_modality(detector, modality, samples)
        all_rows.extend(results)
        stats = metric_summary(results, threshold)
        stats.update({"modality": modality, "threshold": threshold})
        summaries.append(stats)
        print(f"\n{modality.upper()} ({detector.device_name})")
        print(f"Samples: real={stats['n_real']}, fake={stats['n_fake']}; ignored/no score={stats['ignored']}")
        if stats["n_real"] < 5 or stats["n_fake"] < 5:
            print("Warning: too few samples to trust these numbers (fewer than 5 in a class).")
        print(f"Mean score: real={fmt(stats['mean_real'])}, fake={fmt(stats['mean_fake'])}")
        print(f"Accuracy at configured raw threshold {threshold:g}: {fmt(stats['accuracy'])}")
        print(f"ROC AUC={fmt(stats['auc'])}; EER={fmt(stats['eer'])}")
        suggestion = "FACE_THRESHOLD" if modality == "face" else "AUDIO_THRESHOLD"
        print(f"Youden-J threshold: {fmt(stats['youden'])}; set {suggestion}={fmt(stats['youden'])}")
        print(f"Latency ms/sample: mean={fmt(stats['latency_mean'], 2)}, p50={fmt(stats['latency_p50'], 2)}, p95={fmt(stats['latency_p95'], 2)}")

    output_dir = Path(args.out)
    output_dir.mkdir(parents=True, exist_ok=True)
    with (output_dir / "scores.csv").open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=("file", "modality", "truth", "raw_score", "score"))
        writer.writeheader()
        for row in all_rows:
            writer.writerow({key: row[key] for key in writer.fieldnames})
    with (output_dir / "results.csv").open("w", newline="", encoding="utf-8") as handle:
        fields = ("modality", "n_real", "n_fake", "mean_real", "mean_fake", "accuracy", "auc", "eer", "youden", "threshold", "latency_mean", "latency_p50", "latency_p95", "ignored")
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        writer.writerows(summaries)
    lines = ["# KYCShield model evaluation", "", f"Device: {detector.device_name}", "", "Lower calibration starts at the configured raw threshold and maps it to score 0.5. Use the Youden-J raw threshold suggestion in `.env`, then restart the service.", "", "| Modality | Real n | Fake n | Mean real | Mean fake | Accuracy | ROC AUC | EER | Youden-J threshold | Latency mean / p50 / p95 (ms) |", "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|"]
    for item in summaries:
        lines.append(f"| {item['modality']} | {item['n_real']} | {item['n_fake']} | {fmt(item['mean_real'])} | {fmt(item['mean_fake'])} | {fmt(item['accuracy'])} | {fmt(item['auc'])} | {fmt(item['eer'])} | {fmt(item['youden'])} | {fmt(item['latency_mean'], 2)} / {fmt(item['latency_p50'], 2)} / {fmt(item['latency_p95'], 2)} |")
        if item["n_real"] < 5 or item["n_fake"] < 5:
            lines.append("")
            lines.append(f"Warning for {item['modality']}: too few samples to trust these numbers; one class has fewer than 5 samples.")
    lines.extend(["", "Files: `results.csv` contains modality metrics; `scores.csv` contains per-sample raw and calibrated scores."])
    (output_dir / "results.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


if __name__ == "__main__":
    asyncio.run(main())
