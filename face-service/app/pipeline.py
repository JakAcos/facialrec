"""Face measurement pipeline: detect, align, embed, and score liveness.

Everything runs on CPU through ONNX Runtime. The service only measures.
It never decides whether a login is allowed; Convex does that.

Models:
  det_10g.onnx    SCRFD face detector with 5 landmarks   (InsightFace buffalo_l)
  w600k_r50.onnx  ArcFace ResNet-50, 512-d embedding     (InsightFace buffalo_l)
  antispoof_*.onnx  MiniFASNet print/replay attack detectors (Silent-Face)
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np
import onnxruntime as ort

MODEL_NAME = "scrfd10g+arcface-r50-w600k+minifasnet"
MODEL_DIR = Path(os.environ.get("FACE_MODEL_DIR", Path(__file__).parent.parent / "models"))

# Where the 5 landmarks should sit in a 112x112 ArcFace crop.
ARCFACE_TEMPLATE = np.array(
    [
        [38.2946, 51.6963],
        [73.5318, 51.5014],
        [56.0252, 71.7366],
        [41.5493, 92.3655],
        [70.7299, 92.2041],
    ],
    dtype=np.float32,
)


def _thread_count() -> int:
    """How many CPU threads each model may use.

    Containers usually report the host's core count, not their own CPU
    limit. Letting ONNX Runtime start one thread per host core on a small
    container makes it dramatically slower, so the count is capped.
    """
    configured = int(os.environ.get("FACE_THREADS", "0"))
    if configured > 0:
        return configured
    available = len(os.sched_getaffinity(0)) if hasattr(os, "sched_getaffinity") else os.cpu_count() or 1
    try:
        quota, period = Path("/sys/fs/cgroup/cpu.max").read_text().split()
        if quota != "max":
            available = min(available, max(1, round(int(quota) / int(period))))
    except (OSError, ValueError):
        pass
    return max(1, min(4, available))


def _session(name: str) -> ort.InferenceSession:
    opts = ort.SessionOptions()
    opts.intra_op_num_threads = _thread_count()
    opts.inter_op_num_threads = 1
    # Idle threads should sleep rather than spin, so they do not fight over
    # a small CPU allowance.
    opts.add_session_config_entry("session.intra_op.allow_spinning", "0")
    return ort.InferenceSession(
        str(MODEL_DIR / name), sess_options=opts, providers=["CPUExecutionProvider"]
    )


@dataclass
class Face:
    bbox: np.ndarray  # x1, y1, x2, y2
    score: float
    landmarks: np.ndarray  # 5x2: left eye, right eye, nose, mouth left, mouth right

    @property
    def width(self) -> float:
        return float(self.bbox[2] - self.bbox[0])

    @property
    def yaw(self) -> float:
        """Head turn from the landmarks alone.

        How far the nose tip sits from the midpoint of the eyes, as a
        fraction of the distance between the eyes. Straight on is about 0.
        Positive means the nose moved toward the right of the image, which
        is the person's own left (camera images are not mirrored).

        A flat photo cannot fake this: tilting a photo squeezes the whole
        face evenly, so the nose stays centred between the eyes.
        """
        left_eye, right_eye, nose = self.landmarks[0], self.landmarks[1], self.landmarks[2]
        eye_vec = right_eye - left_eye
        eye_dist = float(np.linalg.norm(eye_vec))
        if eye_dist < 1e-6:
            return 0.0
        mid = (left_eye + right_eye) / 2
        # Project onto the eye line so a tilted head does not count as a turn.
        return float(np.dot(nose - mid, eye_vec / eye_dist) / eye_dist)

    @property
    def pitch(self) -> float:
        """Head tilt up or down, from the landmarks alone.

        Where the nose tip sits between the eye line (0) and the mouth line
        (1). Looking up gives a smaller value, looking down a larger one.
        """
        eye_mid = (self.landmarks[0] + self.landmarks[1]) / 2
        mouth_mid = (self.landmarks[3] + self.landmarks[4]) / 2
        axis = mouth_mid - eye_mid
        length = float(np.linalg.norm(axis))
        if length < 1e-6:
            return 0.5
        return float(np.dot(self.landmarks[2] - eye_mid, axis / length) / length)


class Detector:
    """SCRFD detector. Decoding follows the reference InsightFace implementation."""

    STRIDES = (8, 16, 32)
    ANCHORS_PER_CELL = 2

    def __init__(self, size: int = 640, score_threshold: float = 0.5, nms_threshold: float = 0.4):
        self.session = _session("det_10g.onnx")
        self.input_name = self.session.get_inputs()[0].name
        self.size = size
        self.score_threshold = score_threshold
        self.nms_threshold = nms_threshold

    def detect(self, image_bgr: np.ndarray) -> list[Face]:
        h, w = image_bgr.shape[:2]
        scale = self.size / max(h, w)
        new_w, new_h = int(round(w * scale)), int(round(h * scale))
        canvas = np.zeros((self.size, self.size, 3), dtype=np.uint8)
        canvas[:new_h, :new_w] = cv2.resize(image_bgr, (new_w, new_h))
        blob = cv2.dnn.blobFromImage(
            canvas, 1.0 / 128.0, (self.size, self.size), (127.5, 127.5, 127.5), swapRB=True
        )
        outputs = self.session.run(None, {self.input_name: blob})

        n = len(self.STRIDES)
        all_scores, all_boxes, all_points = [], [], []
        for i, stride in enumerate(self.STRIDES):
            scores = outputs[i].reshape(-1)
            box_dist = outputs[i + n].reshape(-1, 4) * stride
            point_dist = outputs[i + 2 * n].reshape(-1, 10) * stride

            cells = self.size // stride
            ys, xs = np.mgrid[:cells, :cells]
            centers = np.stack([xs, ys], axis=-1).astype(np.float32).reshape(-1, 2) * stride
            centers = np.repeat(centers, self.ANCHORS_PER_CELL, axis=0)

            keep = scores >= self.score_threshold
            if not keep.any():
                continue
            c = centers[keep]
            d = box_dist[keep]
            boxes = np.stack(
                [c[:, 0] - d[:, 0], c[:, 1] - d[:, 1], c[:, 0] + d[:, 2], c[:, 1] + d[:, 3]],
                axis=1,
            )
            points = point_dist[keep].reshape(-1, 5, 2) + c[:, None, :]
            all_scores.append(scores[keep])
            all_boxes.append(boxes)
            all_points.append(points)

        if not all_scores:
            return []
        scores = np.concatenate(all_scores)
        boxes = np.concatenate(all_boxes) / scale
        points = np.concatenate(all_points) / scale

        faces = []
        for i in self._nms(boxes, scores):
            faces.append(Face(bbox=boxes[i], score=float(scores[i]), landmarks=points[i]))
        return faces

    def _nms(self, boxes: np.ndarray, scores: np.ndarray) -> list[int]:
        x1, y1, x2, y2 = boxes.T
        areas = (x2 - x1 + 1) * (y2 - y1 + 1)
        order = scores.argsort()[::-1]
        keep = []
        while order.size > 0:
            i = int(order[0])
            keep.append(i)
            rest = order[1:]
            xx1 = np.maximum(x1[i], x1[rest])
            yy1 = np.maximum(y1[i], y1[rest])
            xx2 = np.minimum(x2[i], x2[rest])
            yy2 = np.minimum(y2[i], y2[rest])
            inter = np.maximum(0.0, xx2 - xx1 + 1) * np.maximum(0.0, yy2 - yy1 + 1)
            overlap = inter / (areas[i] + areas[rest] - inter)
            order = rest[overlap <= self.nms_threshold]
        return keep


def _similarity_transform(src: np.ndarray, dst: np.ndarray) -> np.ndarray:
    """Least-squares rotation + uniform scale + shift mapping src onto dst (Umeyama)."""
    src_mean, dst_mean = src.mean(axis=0), dst.mean(axis=0)
    src_c, dst_c = src - src_mean, dst - dst_mean
    cov = dst_c.T @ src_c / len(src)
    u, s, vt = np.linalg.svd(cov)
    d = np.ones(2)
    if np.linalg.det(cov) < 0:
        d[1] = -1
    rot = u @ np.diag(d) @ vt
    scale = (s * d).sum() / src_c.var(axis=0).sum()
    matrix = np.zeros((2, 3), dtype=np.float32)
    matrix[:, :2] = scale * rot
    matrix[:, 2] = dst_mean - scale * rot @ src_mean
    return matrix


class Embedder:
    """ArcFace: turns an aligned 112x112 face into a unit-length 512-d vector."""

    def __init__(self):
        self.session = _session("w600k_r50.onnx")
        self.input_name = self.session.get_inputs()[0].name

    def align(self, image_bgr: np.ndarray, face: Face) -> np.ndarray:
        matrix = _similarity_transform(face.landmarks.astype(np.float32), ARCFACE_TEMPLATE)
        return cv2.warpAffine(image_bgr, matrix, (112, 112), borderValue=0.0)

    def embed(self, image_bgr: np.ndarray, face: Face) -> np.ndarray:
        crop = self.align(image_bgr, face)
        blob = cv2.dnn.blobFromImage(
            crop, 1.0 / 127.5, (112, 112), (127.5, 127.5, 127.5), swapRB=True
        )
        vec = self.session.run(None, {self.input_name: blob})[0][0]
        return vec / np.linalg.norm(vec)


class AntiSpoof:
    """Two MiniFASNet models that look at the face at different zoom levels.

    Each outputs three classes; index 1 is "real". Their probabilities are
    averaged, as in the reference implementation.
    """

    MODELS = (("antispoof_v2_2.7.onnx", 2.7), ("antispoof_v1se_4.0.onnx", 4.0))

    def __init__(self):
        self.sessions = [(_session(name), scale) for name, scale in self.MODELS]

    @staticmethod
    def _crop(image: np.ndarray, bbox: np.ndarray, scale: float) -> np.ndarray:
        src_h, src_w = image.shape[:2]
        x, y = float(bbox[0]), float(bbox[1])
        box_w, box_h = float(bbox[2] - bbox[0]), float(bbox[3] - bbox[1])
        scale = min((src_h - 1) / box_h, (src_w - 1) / box_w, scale)
        new_w, new_h = box_w * scale, box_h * scale
        cx, cy = x + box_w / 2, y + box_h / 2
        left, top = cx - new_w / 2, cy - new_h / 2
        right, bottom = cx + new_w / 2, cy + new_h / 2
        if left < 0:
            right -= left
            left = 0
        if top < 0:
            bottom -= top
            top = 0
        if right > src_w - 1:
            left -= right - src_w + 1
            right = src_w - 1
        if bottom > src_h - 1:
            top -= bottom - src_h + 1
            bottom = src_h - 1
        crop = image[int(top) : int(bottom) + 1, int(left) : int(right) + 1]
        return cv2.resize(crop, (80, 80))

    def live_score(self, image_bgr: np.ndarray, face: Face) -> float:
        bbox = np.clip(face.bbox, 0, None)
        total = np.zeros(3, dtype=np.float64)
        for session, scale in self.sessions:
            crop = self._crop(image_bgr, bbox, scale)
            # These models expect raw 0-255 BGR values, channel first.
            blob = crop.astype(np.float32).transpose(2, 0, 1)[None]
            logits = session.run(None, {session.get_inputs()[0].name: blob})[0][0]
            exp = np.exp(logits - logits.max())
            total += exp / exp.sum()
        return float(total[1] / len(self.sessions))


@dataclass
class FrameResult:
    face_count: int
    det_score: float
    face_size: float
    yaw: float
    pitch: float
    live_score: float
    embedding: list[float] | None

    def to_json(self) -> dict:
        return {
            "face_count": self.face_count,
            "det_score": round(self.det_score, 4),
            "face_size": round(self.face_size, 1),
            "yaw": round(self.yaw, 4),
            "pitch": round(self.pitch, 4),
            "live_score": round(self.live_score, 4),
            "embedding": self.embedding,
        }


class Pipeline:
    # Faces this much smaller than the main one are background people, not a
    # second person trying to share the frame.
    SECONDARY_FACE_RATIO = 0.5

    def __init__(self):
        self.detector = Detector()
        self.embedder = Embedder()
        self.antispoof = AntiSpoof()

    def analyze(self, image_bgr: np.ndarray) -> FrameResult:
        faces = self.detector.detect(image_bgr)
        if not faces:
            return FrameResult(0, 0.0, 0.0, 0.0, 0.5, 0.0, None)
        faces.sort(key=lambda f: f.width, reverse=True)
        main = faces[0]
        count = sum(1 for f in faces if f.width >= main.width * self.SECONDARY_FACE_RATIO)
        return FrameResult(
            face_count=count,
            det_score=main.score,
            face_size=main.width,
            yaw=main.yaw,
            pitch=main.pitch,
            live_score=self.antispoof.live_score(image_bgr, main),
            embedding=[round(float(v), 6) for v in self.embedder.embed(image_bgr, main)],
        )


def decode_image(data: bytes, max_side: int = 1280) -> np.ndarray | None:
    """Decodes JPEG/PNG bytes, shrinking very large frames to keep things fast."""
    image = cv2.imdecode(np.frombuffer(data, dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        return None
    h, w = image.shape[:2]
    if max(h, w) > max_side:
        ratio = max_side / max(h, w)
        image = cv2.resize(image, (int(w * ratio), int(h * ratio)))
    return image
