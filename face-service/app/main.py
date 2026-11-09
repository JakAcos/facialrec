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

# Largest request this service will read: five frames of MAX_FRAME_BYTES,
# base64 encoded (which adds a third), plus a little JSON around them.
MAX_BODY_BYTES = MAX_FRAMES * MAX_FRAME_BYTES * 4 // 3 + 4096


def _secret_ok(provided: str | None) -> bool:
    expected = os.environ.get("FACE_SERVICE_SECRET", "")
    return bool(expected) and provided is not None and hmac.compare_digest(
        provided.encode(), expected.encode()
    )


class GuardAnalyze:
    """Rejects bad /analyze requests before any of the body is read.

    FastAPI would otherwise download and parse the whole JSON body before
    the handler gets to check the secret, so anyone on the internet could
    make this public service buffer an enormous request.
    """

    def __init__(self, inner):
        self.inner = inner

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["path"] != "/analyze":
            return await self.inner(scope, receive, send)
        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope["headers"]}

        if not os.environ.get("FACE_SERVICE_SECRET"):
            return await self._reject(send, 503, "Service secret is not configured")
        if not _secret_ok(headers.get("x-face-secret")):
            return await self._reject(send, 401, "Unauthorized")
        length = headers.get("content-length")
        if length is None or not length.isdigit():
            return await self._reject(send, 411, "Content-Length is required")
        if int(length) > MAX_BODY_BYTES:
            return await self._reject(send, 413, "Request too large")

        # Content-Length is only a claim, so count what actually arrives.
        received = 0

        async def limited_receive():
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > MAX_BODY_BYTES:
                    raise HTTPException(status_code=413, detail="Request too large")
            return message

        return await self.inner(scope, limited_receive, send)

    @staticmethod
    async def _reject(send, status: int, detail: str) -> None:
        body = ('{"detail":"%s"}' % detail).encode()
        await send(
            {
                "type": "http.response.start",
                "status": status,
                "headers": [
                    (b"content-type", b"application/json"),
                    (b"content-length", str(len(body)).encode()),
                ],
            }
        )
        await send({"type": "http.response.body", "body": body})


app.add_middleware(GuardAnalyze)


class AnalyzeRequest(BaseModel):
    frames: list[str] = Field(min_length=1, max_length=MAX_FRAMES)


def _check_secret(provided: str | None) -> None:
    # The middleware has already checked this. It is checked again here so
    # the handler stays safe if it is ever mounted without the middleware.
    if not os.environ.get("FACE_SERVICE_SECRET"):
        raise HTTPException(status_code=503, detail="Service secret is not configured")
    if not _secret_ok(provided):
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
