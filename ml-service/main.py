"""In-memory FastAPI service for KYCShield detector backends."""

import logging
import os
import time
from email import policy
from email.parser import BytesParser
from typing import Any

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

load_dotenv()

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
logger = logging.getLogger("kycshield.ml")

DETECTOR_BACKEND = os.getenv("DETECTOR_BACKEND", "mock").strip().lower()
if DETECTOR_BACKEND not in {"mock", "hf"}:
    raise RuntimeError("DETECTOR_BACKEND must be 'mock' or 'hf'.")

FACE_MODEL_ID = os.getenv("FACE_MODEL_ID", "").strip() or None
AUDIO_MODEL_ID = os.getenv("AUDIO_MODEL_ID", "").strip() or None
MAX_FRAME_BYTES = int(os.getenv("MAX_FRAME_BYTES", "2000000"))
MAX_AUDIO_BYTES = int(os.getenv("MAX_AUDIO_BYTES", "1500000"))
HOST = os.getenv("HOST", "127.0.0.1")
PORT = int(os.getenv("PORT", "8000"))

if MAX_FRAME_BYTES < 1 or MAX_AUDIO_BYTES < 1:
    raise RuntimeError("Upload size limits must be positive integers.")

app = FastAPI(title="KYCShield detector service", version="1.0.0")
detector: Any = None

UPLOAD_DOC = {
    "requestBody": {
        "required": True,
        "content": {
            "multipart/form-data": {
                "schema": {
                    "type": "object",
                    "required": ["file"],
                    "properties": {"file": {"type": "string", "format": "binary"}},
                }
            }
        },
    }
}


@app.middleware("http")
async def request_logging(request: Request, call_next):
    started = time.perf_counter()
    status = 500
    try:
        response = await call_next(request)
        status = response.status_code
        return response
    except Exception:
        logger.exception("Request failed: %s %s", request.method, request.url.path)
        raise
    finally:
        latency_ms = (time.perf_counter() - started) * 1000
        logger.info("%s %s status=%s latency_ms=%.2f", request.method, request.url.path, status, latency_ms)


@app.on_event("startup")
async def load_detector():
    global detector
    if DETECTOR_BACKEND == "mock":
        from backends.mock import MockDetector

        detector = MockDetector()
        return

    from backends.hf import HuggingFaceDetector

    detector = HuggingFaceDetector(FACE_MODEL_ID, AUDIO_MODEL_ID)
    await detector.load()


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "backend": DETECTOR_BACKEND,
        "face_model": FACE_MODEL_ID,
        "audio_model": AUDIO_MODEL_ID,
    }


async def read_multipart_file(request: Request, limit: int) -> bytes:
    """Read one multipart file entirely in memory, with bounded request size."""
    content_type = request.headers.get("content-type", "")
    if not content_type.lower().startswith("multipart/form-data;"):
        raise HTTPException(status_code=400, detail="Expected multipart/form-data with a file field named 'file'.")

    # Leave room for normal MIME headers/boundaries without allowing an unbounded body.
    body_limit = limit + 64 * 1024
    chunks = bytearray()
    async for chunk in request.stream():
        if len(chunks) + len(chunk) > body_limit:
            raise HTTPException(status_code=413, detail=f"Upload exceeds the {limit} byte limit.")
        chunks.extend(chunk)

    try:
        message = BytesParser(policy=policy.default).parsebytes(
            f"Content-Type: {content_type}\r\nMIME-Version: 1.0\r\n\r\n".encode("ascii") + chunks
        )
        parts = list(message.iter_parts())
    except (UnicodeError, ValueError, TypeError) as error:
        raise HTTPException(status_code=400, detail="Could not read the multipart upload.") from error

    file_parts = [part for part in parts if part.get_content_disposition() == "form-data" and part.get_param("name", header="content-disposition") == "file"]
    if len(file_parts) != 1 or not file_parts[0].get_filename():
        raise HTTPException(status_code=400, detail="Multipart upload must contain exactly one file field named 'file'.")

    data = file_parts[0].get_payload(decode=True)
    if not data:
        raise HTTPException(status_code=400, detail="Uploaded file is empty or unreadable.")
    if len(data) > limit:
        raise HTTPException(status_code=413, detail=f"Upload exceeds the {limit} byte limit.")
    return data


def make_result(score: float | None, latency_ms: float, note: str | None = None) -> dict[str, Any]:
    label = "unknown" if score is None else ("fake" if score >= 0.5 else "real")
    result: dict[str, Any] = {
        "score": score,
        "label": label,
        "backend": DETECTOR_BACKEND,
        "latency_ms": round(latency_ms, 2),
    }
    if note:
        result["note"] = note
    return result


async def run_detection(modality: str, data: bytes) -> dict[str, Any]:
    started = time.perf_counter()
    try:
        score, note = await detector.detect(modality, data)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except Exception as error:
        logger.exception("Detector inference failed for modality=%s", modality)
        raise HTTPException(status_code=500, detail="Detector inference failed.") from error
    return make_result(score, (time.perf_counter() - started) * 1000, note)


def validate_upload(modality: str, data: bytes):
    # Validate before model configuration checks so malformed uploads always get HTTP 400.
    from backends.mock import MockDetector

    if modality == "face":
        MockDetector._validate_image(data)
    else:
        MockDetector._validate_wav(data)


@app.post("/frame", openapi_extra=UPLOAD_DOC)
async def detect_frame(request: Request):
    data = await read_multipart_file(request, MAX_FRAME_BYTES)
    try:
        validate_upload("face", data)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    return await run_detection("face", data)


@app.post("/audio", openapi_extra=UPLOAD_DOC)
async def detect_audio(request: Request):
    data = await read_multipart_file(request, MAX_AUDIO_BYTES)
    try:
        validate_upload("audio", data)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    return await run_detection("audio", data)


@app.post("/mock/scenario")
async def set_mock_scenario(request: Request):
    if DETECTOR_BACKEND != "mock":
        raise HTTPException(status_code=404, detail="Not found.")
    try:
        payload = await request.json()
    except Exception as error:
        raise HTTPException(status_code=400, detail="Body must be a JSON object.") from error
    if not isinstance(payload, dict) or not payload:
        raise HTTPException(status_code=400, detail="Provide 'face' and/or 'audio' as 'real' or 'fake'.")
    for modality in ("face", "audio"):
        if modality in payload and (
            not isinstance(payload[modality], str) or payload[modality] not in {"real", "fake"}
        ):
            raise HTTPException(status_code=400, detail=f"'{modality}' must be 'real' or 'fake'.")
    unexpected = set(payload) - {"face", "audio"}
    if unexpected:
        raise HTTPException(status_code=400, detail="Only 'face' and 'audio' scenario fields are accepted.")
    detector.set_scenario(payload)
    return {"face": detector.scenario["face"], "audio": detector.scenario["audio"]}


@app.exception_handler(HTTPException)
async def clear_http_errors(_request: Request, error: HTTPException):
    return JSONResponse(status_code=error.status_code, content={"detail": error.detail}, headers=error.headers)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host=HOST, port=PORT, reload=False)
