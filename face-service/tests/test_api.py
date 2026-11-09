"""API tests with a stand-in pipeline, so they run without model files."""

import base64

import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient

from app import main
from app.pipeline import FrameResult


class FakePipeline:
    def analyze(self, image):
        return FrameResult(1, 0.9, float(image.shape[1]), 0.0, 0.5, 0.99, [0.0] * 512)


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("FACE_SERVICE_SECRET", "test-secret")
    monkeypatch.setattr(main, "Pipeline", FakePipeline)
    with TestClient(main.app) as test_client:
        yield test_client


def jpeg(width=64, height=48) -> str:
    ok, buf = cv2.imencode(".jpg", np.full((height, width, 3), 127, np.uint8))
    assert ok
    return base64.b64encode(buf.tobytes()).decode()


def test_health_is_public(client):
    assert client.get("/health").json()["ok"] is True


def test_analyze_rejects_missing_or_wrong_secret(client):
    assert client.post("/analyze", json={"frames": [jpeg()]}).status_code == 401
    wrong = client.post("/analyze", json={"frames": [jpeg()]}, headers={"x-face-secret": "nope"})
    assert wrong.status_code == 401


def test_analyze_fails_closed_when_secret_not_configured(client, monkeypatch):
    monkeypatch.delenv("FACE_SERVICE_SECRET")
    res = client.post("/analyze", json={"frames": [jpeg()]}, headers={"x-face-secret": ""})
    assert res.status_code == 503


def test_analyze_returns_one_result_per_frame(client):
    res = client.post(
        "/analyze",
        json={"frames": [jpeg(64), jpeg(80)]},
        headers={"x-face-secret": "test-secret"},
    )
    assert res.status_code == 200
    frames = res.json()["frames"]
    assert [f["face_size"] for f in frames] == [64.0, 80.0]
    assert len(frames[0]["embedding"]) == 512
    assert set(frames[0]) == {"face_count", "det_score", "face_size", "yaw", "pitch", "live_score", "embedding"}


def test_analyze_rejects_bad_input(client):
    headers = {"x-face-secret": "test-secret"}
    assert client.post("/analyze", json={"frames": ["not base64!!"]}, headers=headers).status_code == 400
    not_image = base64.b64encode(b"hello").decode()
    assert client.post("/analyze", json={"frames": [not_image]}, headers=headers).status_code == 400
    assert client.post("/analyze", json={"frames": []}, headers=headers).status_code == 422
    assert client.post("/analyze", json={"frames": [jpeg()] * 6}, headers=headers).status_code == 422


def test_wrong_secret_is_refused_before_the_body_is_read(client):
    # A body far over the limit, with a bad secret: must be 401, not 413 or
    # a parse error, which shows the secret is checked before the body.
    huge = b"x" * (main.MAX_BODY_BYTES + 1000)
    res = client.post(
        "/analyze",
        content=huge,
        headers={"x-face-secret": "nope", "content-type": "application/json"},
    )
    assert res.status_code == 401


def test_oversized_request_is_refused(client):
    huge = b"x" * (main.MAX_BODY_BYTES + 1000)
    res = client.post(
        "/analyze",
        content=huge,
        headers={"x-face-secret": "test-secret", "content-type": "application/json"},
    )
    assert res.status_code == 413


def test_request_without_a_length_is_refused(client):
    def chunks():
        yield b'{"frames": ['
        yield b"]}"

    res = client.post(
        "/analyze",
        content=chunks(),
        headers={"x-face-secret": "test-secret", "content-type": "application/json"},
    )
    assert res.status_code == 411


def test_largest_legitimate_request_fits_under_the_limit():
    frame = base64.b64encode(b"\0" * main.MAX_FRAME_BYTES)
    body = b'{"frames":[' + b",".join(b'"' + frame + b'"' for _ in range(main.MAX_FRAMES)) + b"]}"
    assert len(body) <= main.MAX_BODY_BYTES


def test_decompression_bomb_is_refused_without_decoding(monkeypatch):
    from app import pipeline

    # A solid-colour image compresses to a few kilobytes however large it is.
    side = int(pipeline.MAX_IMAGE_PIXELS**0.5) + 400
    blank = np.zeros((side, side, 3), np.uint8)
    for ext in (".png", ".jpg"):
        ok, buf = cv2.imencode(ext, blank)
        assert ok and len(buf) < 400_000
        assert pipeline.image_size(buf.tobytes()) == (side, side)

        def fail(*args, **kwargs):
            raise AssertionError("the oversized image was decoded")

        monkeypatch.setattr(pipeline.cv2, "imdecode", fail)
        assert pipeline.decode_image(buf.tobytes()) is None
        monkeypatch.undo()


def test_normal_frames_decode_and_other_formats_are_refused():
    from app.pipeline import decode_image, image_size

    frame = np.zeros((480, 640, 3), np.uint8)
    for ext in (".jpg", ".png"):
        ok, buf = cv2.imencode(ext, frame)
        assert image_size(buf.tobytes()) == (640, 480)
        assert decode_image(buf.tobytes()).shape == (480, 640, 3)
    ok, bmp = cv2.imencode(".bmp", frame)
    assert decode_image(bmp.tobytes()) is None
    assert decode_image(b"") is None
    assert decode_image(b"\xff\xd8\xff") is None


def test_extremely_thin_image_is_refused_not_a_server_error(client):
    # 1x2000 would shrink to zero pixels wide when scaled down to 1280.
    ok, buf = cv2.imencode(".png", np.zeros((2000, 1, 3), np.uint8))
    assert ok
    thin = base64.b64encode(buf.tobytes()).decode()
    res = client.post("/analyze", json={"frames": [thin]}, headers={"x-face-secret": "test-secret"})
    assert res.status_code == 400
