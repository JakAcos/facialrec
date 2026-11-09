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
