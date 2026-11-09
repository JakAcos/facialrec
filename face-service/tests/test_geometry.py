"""Tests for the maths that does not need any model files."""

import numpy as np

from app.pipeline import ARCFACE_TEMPLATE, AntiSpoof, Face, _similarity_transform


def face_with(landmarks) -> Face:
    return Face(bbox=np.array([0, 0, 100, 100.0]), score=0.9, landmarks=np.array(landmarks, float))


FRONTAL = [[30, 40], [70, 40], [50, 60], [35, 80], [65, 80]]


def test_frontal_face_has_no_yaw_and_mid_pitch():
    face = face_with(FRONTAL)
    assert abs(face.yaw) < 1e-9
    assert abs(face.pitch - 0.5) < 1e-9


def test_yaw_sign_positive_when_nose_moves_to_image_right():
    turned = [row[:] for row in FRONTAL]
    turned[2] = [62, 60]
    assert face_with(turned).yaw > 0.25
    turned[2] = [38, 60]
    assert face_with(turned).yaw < -0.25


def test_yaw_ignores_head_roll():
    # Rotate every landmark of a frontal face by 20 degrees in the image plane.
    angle = np.deg2rad(20)
    rot = np.array([[np.cos(angle), -np.sin(angle)], [np.sin(angle), np.cos(angle)]])
    rolled = (np.array(FRONTAL, float) - 50) @ rot.T + 50
    assert abs(face_with(rolled).yaw) < 1e-6


def test_squeezed_photo_keeps_zero_yaw():
    # Turning a flat photo squeezes it horizontally. The yaw must not change,
    # which is what makes the head-turn challenge a liveness test.
    squeezed = np.array(FRONTAL, float)
    squeezed[:, 0] = (squeezed[:, 0] - 50) * 0.6 + 50
    assert abs(face_with(squeezed).yaw) < 1e-9


def test_pitch_changes_when_looking_up_or_down():
    up = [row[:] for row in FRONTAL]
    up[2] = [50, 46]
    down = [row[:] for row in FRONTAL]
    down[2] = [50, 72]
    assert face_with(up).pitch < 0.3
    assert face_with(down).pitch > 0.7


def test_similarity_transform_recovers_known_mapping():
    angle, scale, shift = np.deg2rad(17), 2.3, np.array([40.0, -12.0])
    rot = np.array([[np.cos(angle), -np.sin(angle)], [np.sin(angle), np.cos(angle)]])
    src = (ARCFACE_TEMPLATE - shift) @ rot / scale  # inverse of dst = s*R*src + t
    matrix = _similarity_transform(src.astype(np.float32), ARCFACE_TEMPLATE)
    mapped = src @ matrix[:, :2].T + matrix[:, 2]
    assert np.allclose(mapped, ARCFACE_TEMPLATE, atol=1e-3)


def test_antispoof_crop_stays_inside_image_and_is_80px():
    image = np.zeros((240, 320, 3), dtype=np.uint8)
    for bbox in ([5, 5, 60, 70], [250, 170, 318, 238], [100, 60, 200, 180]):
        for scale in (2.7, 4.0):
            crop = AntiSpoof._crop(image, np.array(bbox, float), scale)
            assert crop.shape == (80, 80, 3)
