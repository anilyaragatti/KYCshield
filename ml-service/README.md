# KYCShield ML service

FastAPI microservice for KYCShield's frame and audio detector. The default `mock` backend is for pipeline development only; its scores are simulated and are not real deepfake detection. The `hf` backend runs configured Hugging Face image and audio classification models.

## Python 3.12 setup

Run commands from `ml-service/`. Windows PowerShell:

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements-hf.txt
Copy-Item .env.example .env
```

If you already have a Python 3.12 virtual environment, activate it and skip the `venv` creation command. Mac/Linux:

```sh
python3.12 -m venv .venv
source .venv/bin/activate
pip install -r requirements-hf.txt
cp .env.example .env
```

`requirements-hf.txt` installs the base service dependencies plus PyTorch, Transformers, OpenCV, SoundFile, SciPy, and scikit-learn. For mock-only use, install `requirements.txt` instead.

## Configure and start real models

Edit `.env` and set:

```dotenv
DETECTOR_BACKEND=hf
FACE_MODEL_ID=your-image-classification-model-id
AUDIO_MODEL_ID=your-audio-classification-model-id
```

Use compatible Hugging Face image-classification and audio-classification model ids. Set `FACE_FAKE_LABEL` and/or `AUDIO_FAKE_LABEL` to an exact class label or class index such as `1` when the model's fake class is not detected automatically. Automatic mapping looks for `fake`, `deepfake`, `spoof`, `synthetic`, or `ai` in a class name. If no class maps safely, inference returns a null score with `label_mapping_unknown`; it does not guess.

`FACE_THRESHOLD` and `AUDIO_THRESHOLD` are raw model thresholds. Calibration maps the configured threshold to a returned score of `0.5`, preserving score ordering. `HF_DEVICE=auto` chooses CUDA when available and CPU otherwise; `cpu` and `cuda` force the device. Set `AUDIO_WINDOW_SEC` for the inference window duration (default 2 seconds). Both configured models load once at startup and are warmed up. A missing model id leaves only that modality unconfigured; the other can still run.

Start the service:

```powershell
uvicorn main:app --host 127.0.0.1 --port 8000
```

Then open <http://127.0.0.1:8000/health> or the interactive docs at <http://127.0.0.1:8000/docs>. In HF mode, `/health` and `/models` include device, model labels, selected fake labels, thresholds, and model load times. The service accepts JPEG frames at `POST /frame` and WAV audio at `POST /audio`; uploads remain in memory.

## Collect labeled samples

Place representative real and fake examples in `samples/face_real`, `samples/face_fake`, `samples/audio_real`, and `samples/audio_fake`. Those personal sample folders are ignored by Git; their `.gitkeep` files preserve the empty directories.

Extract frames from a video at two frames per second, up to 60 frames:

```powershell
python tools/extract_frames.py --video path\to\clip.mp4 --out samples\face_real --fps 2 --max-frames 60
```

Add `--jpeg-quality 40` to simulate compressed frames. Review the extracted frames and place only correctly labeled samples into the corresponding real or fake folder. Audio evaluation accepts WAV and FLAC. Keep real and fake samples representative of the expected camera, compression, lighting, and microphone conditions.

## Evaluate on your sample clips

With the virtual environment active, `DETECTOR_BACKEND` may remain unset; the evaluation script loads the HF backend directly using model settings from `.env`:

```powershell
python evaluate.py --face-real samples/face_real --face-fake samples/face_fake --audio-real samples/audio_real --audio-fake samples/audio_fake --out results
```

Every directory argument is optional, so evaluate one modality or one class at a time. Images can be JPG/JPEG/PNG. Audio WAV/FLAC files are converted to mono 16 kHz, split into `AUDIO_WINDOW_SEC` windows with a one-second hop, and silent windows are skipped. Input media is not copied to the results folder. The tool reports sample counts, mean class scores, accuracy at the configured raw threshold, ROC AUC, equal error rate (EER), Youden-J threshold, and mean/p50/p95 latency. It warns when either class has fewer than five scored samples; ROC AUC and EER require both classes.

The output folder contains:

- `results.md`: compact metrics table for project charts.
- `results.csv`: the same metrics in machine-readable form.
- `scores.csv`: one row per scored image or audio window, with file, modality, truth, raw score, and calibrated score.

Review each modality's Youden-J threshold suggestion (for example, `set FACE_THRESHOLD=0.42`) in the console or `results.md`. Add the selected raw threshold to `.env`, restart the service, and run evaluation again. Threshold recommendations from very small datasets are only preliminary; collect more varied samples before relying on them.

## Mock backend

Set `DETECTOR_BACKEND=mock` to use the lightweight scenario detector. It validates JPEG/WAV uploads and generates plausible simulated scores. `POST /mock/scenario` can change the face/audio scenario to `real` or `fake`. Use `python test_client.py` while the service is running to exercise the API.
