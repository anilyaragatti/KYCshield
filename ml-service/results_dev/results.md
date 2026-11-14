# KYCShield model evaluation

Device: cuda

Lower calibration starts at the configured raw threshold and maps it to score 0.5. Use the Youden-J raw threshold suggestion in `.env`, then restart the service.

| Modality | Real n | Fake n | Mean real | Mean fake | Accuracy | ROC AUC | EER | Youden-J threshold | Latency mean / p50 / p95 (ms) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| face | 71 | 54 | 0.2180 | 0.3795 | 0.5920 | 0.7342 | 0.3286 | 0.0795 | 143.17 / 109.96 / 308.35 |

Files: `results.csv` contains modality metrics; `scores.csv` contains per-sample raw and calibrated scores.
