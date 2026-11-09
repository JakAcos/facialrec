"""End-to-end checks with the real models. Skipped when they are not downloaded."""

from pathlib import Path

import cv2
import numpy as np
import pytest

from app.pipeline import MODEL_DIR, Pipeline

pytestmark = pytest.mark.skipif(
    not (MODEL_DIR / "w600k_r50.onnx").exists(), reason="models not downloaded"
)


@pytest.fixture(scope="module")
def pipeline():
    return Pipeline()


@pytest.fixture(scope="module")
def lfw_people():
    datasets = pytest.importorskip("sklearn.datasets")
    try:
        data = datasets.fetch_lfw_people(
            min_faces_per_person=20, color=True, resize=1.0, slice_=None, download_if_missing=False
        )
    except OSError:
        pytest.skip("LFW is not cached locally (run eval/lfw_eval.py once)")
    return data


def bgr(image):
    if image.max() <= 1.0:
        image = image * 255.0
    return cv2.cvtColor(image.astype(np.uint8), cv2.COLOR_RGB2BGR)


def test_blank_image_has_no_face(pipeline):
    result = pipeline.analyze(np.full((480, 640, 3), 200, np.uint8))
    assert result.face_count == 0
    assert result.embedding is None


def test_same_person_scores_higher_than_different_people(pipeline, lfw_people):
    images, target = lfw_people.images, lfw_people.target
    first, second = np.unique(target)[:2]
    a1, a2 = (bgr(img) for img in images[target == first][:2])
    b1 = bgr(images[target == second][0])
    ea1, ea2, eb1 = (np.array(pipeline.analyze(i).embedding) for i in (a1, a2, b1))
    assert ea1.shape == (512,)
    assert abs(np.linalg.norm(ea1) - 1) < 1e-3
    assert ea1 @ ea2 > 0.45
    assert ea1 @ eb1 < 0.3


def test_mirrored_face_flips_yaw_sign(pipeline, lfw_people):
    image = bgr(lfw_people.images[0])
    original = pipeline.analyze(image)
    mirrored = pipeline.analyze(cv2.flip(image, 1))
    assert original.face_count == 1 and mirrored.face_count == 1
    assert abs(original.yaw + mirrored.yaw) < 0.08


def test_a_face_filling_the_frame_is_still_found(pipeline, lfw_people):
    # Someone sitting close to the camera. Cropping to the face and enlarging
    # it gives a face too big for the detector's first pass, so this relies
    # on the second look at half size.
    image = bgr(lfw_people.images[0])
    face = pipeline.detector.detect(image)[0]
    x1, y1, x2, y2 = (int(v) for v in face.bbox)
    pad = 12
    crop = image[max(0, y1 - pad) : y2 + pad, max(0, x1 - pad) : x2 + pad]
    close_up = cv2.resize(crop, None, fx=5, fy=5, interpolation=cv2.INTER_CUBIC)
    assert pipeline.detector._detect_at(close_up, pipeline.detector.size) == []
    found = pipeline.detector.detect(close_up)
    assert len(found) == 1
    assert found[0].width > 0.6 * close_up.shape[1]
