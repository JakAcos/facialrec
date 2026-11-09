"""HTTP wrapper around the face pipeline.

One real endpoint: POST /analyze. It is called server-to-server by Convex
with a shared secret, never directly by browsers. The service keeps no
state and stores no images.
"""

from __future__ import annotations

import base64
import binascii
import hmac
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, Header, HTTPException
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field

from .pipeline import MODEL_NAME, Pipeline, _thread_count, decode_image

MAX_FRAMES = 5
MAX_FRAME_BYTES = 1024 * 1024

state: dict[str, Pipeline] = {}


@asynccontextmanager
async def lifespan(_: FastAPI):
    state["pipeline"] = Pipeline()
    yield
    state.clear()


app = FastAPI(title="facialrec face service", lifespan=lifespan, docs_url=None, redoc_url=None)


class AnalyzeRequest(BaseModel):
    frames: list[str] = Field(min_length=1, max_length=MAX_FRAMES)


def _check_secret(provided: str | None) -> None:
    expected = os.environ.get("FACE_SERVICE_SECRET", "")
    if not expected:
        raise HTTPException(status_code=503, detail="Service secret is not configured")
    if provided is None or not hmac.compare_digest(provided.encode(), expected.encode()):
        raise HTTPException(status_code=401, detail="Unauthorized")


@app.get("/health")
async def health() -> dict:
    return {"ok": "pipeline" in state, "model": MODEL_NAME, "threads": _thread_count()}


@app.post("/analyze")
async def analyze(body: AnalyzeRequest, x_face_secret: str | None = Header(default=None)) -> dict:
    _check_secret(x_face_secret)
    images = []
    for frame in body.frames:
        try:
            raw = base64.b64decode(frame, validate=True)
        except (binascii.Error, ValueError):
            raise HTTPException(status_code=400, detail="Frames must be base64") from None
        if len(raw) > MAX_FRAME_BYTES:
            raise HTTPException(status_code=413, detail="Frame too large")
        image = decode_image(raw)
        if image is None:
            raise HTTPException(status_code=400, detail="Frame is not a valid image")
        images.append(image)

    pipeline = state["pipeline"]
    results = await run_in_threadpool(lambda: [pipeline.analyze(img) for img in images])
    return {"model": MODEL_NAME, "frames": [r.to_json() for r in results]}
