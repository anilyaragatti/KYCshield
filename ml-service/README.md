# KYCShield ML service

Small FastAPI service called by the Node.js application. The default mock backend validates uploads and returns scenario-driven sample scores. Mock scores are not real deepfake detection.

## Requirements

- Python 3.10 or later
- Node.js can call this service over HTTP; no CORS configuration is needed

## Windows setup

From the repository root in PowerShell:

```powershell
cd ml-service
py -3.10 -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
Copy-Item .env.example .env
uvicorn main:app --host 127.0.0.1 --port 8000
```

If the project already has a virtual environment, activate it and skip the `py -3.10 -m venv .venv` command. Edit `.env` to change the backend, model ids, limits, host, or port. The default `HOST` and `PORT` match the run command above.

## Mac/Linux setup

From the repository root:

```sh
cd ml-service
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
uvicorn main:app --host 127.0.0.1 --port 8000
```

Open the interactive API docs at <http://127.0.0.1:8000/docs>. With the service running, use a second terminal in `ml-service/` with the same environment activated and run:

```sh
python test_client.py
```

`test_client.py` uses the `requests` package installed by `requirements.txt`, creates an in-memory JPEG and two-second 16 kHz mono WAV, and calls `/health`, `/frame`, and `/audio`. With the mock backend, it also switches both scenarios to fake and prints the new results.

## API responses

- `GET /health` reports the selected backend and configured model ids.
- `POST /frame` accepts one multipart `file` JPEG.
- `POST /audio` accepts one multipart `file` WAV.
- `POST /mock/scenario` accepts optional `face` and `audio` values of `real` or `fake`. This endpoint returns 404 unless `DETECTOR_BACKEND=mock`.

Scores are probabilities that the input is fake: `0.0` means real and `1.0` means fake. The label is `unknown` when no score is available. Uploads are bounded by `MAX_FRAME_BYTES` and `MAX_AUDIO_BYTES`, processed in memory, and never written to application-managed files. The service logs request method, path, status, and latency only.

## Switching to real models

```sh
pip install -r requirements-hf.txt
```

Set `DETECTOR_BACKEND=hf`, set `FACE_MODEL_ID` and `AUDIO_MODEL_ID` to compatible Hugging Face image-classification and audio-classification model ids in `.env`, then restart uvicorn. Each configured model is loaded once at startup, using CUDA when available and CPU otherwise. An empty model id leaves that modality unconfigured and returns a null score. Check each model's label convention and adjust `fake_probability()` in `backends/hf.py` if needed.

The image backend uses OpenCV's built-in Haar face detector; the audio backend reads WAV data with SoundFile and resamples it to the model's expected sample rate.
