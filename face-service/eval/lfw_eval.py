"""Measure how accurate the face matcher is on the public LFW benchmark.

LFW ("Labeled Faces in the Wild") has 6,000 labelled pairs of photos: half
show the same person, half show two different people. Running our exact
pipeline (detect, align, embed, cosine similarity) over those pairs tells us
the real error rates for any match threshold, instead of guessing one.

Usage:
    python eval/lfw_eval.py [--limit N] [--out eval]

Writes LFW_REPORT.md and lfw_scores.json into the output directory.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
from pathlib import Path

import cv2
import numpy as np
from sklearn.datasets import fetch_lfw_pairs

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app.pipeline import Pipeline  # noqa: E402


def to_bgr(image: np.ndarray) -> np.ndarray:
    if image.max() <= 1.0:
        image = image * 255.0
    return cv2.cvtColor(image.astype(np.uint8), cv2.COLOR_RGB2BGR)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=0, help="only use the first N pairs")
    parser.add_argument("--out", type=Path, default=Path(__file__).parent)
    args = parser.parse_args()

    # Full 250x250 colour images, uncropped, so our own detector does the work.
    data = fetch_lfw_pairs(subset="10_folds", color=True, resize=1.0, slice_=None)
    pairs, labels = data.pairs, data.target
    if args.limit:
        # Take from both ends so same and different pairs are both present.
        idx = np.r_[: args.limit // 2, len(pairs) - args.limit // 2 : len(pairs)]
        pairs, labels = pairs[idx], labels[idx]

    pipeline = Pipeline()
    cache: dict[str, tuple[np.ndarray | None, float]] = {}

    def embed(image: np.ndarray) -> tuple[np.ndarray | None, float]:
        key = hashlib.sha1(image.tobytes()).hexdigest()
        if key not in cache:
            result = pipeline.analyze(to_bgr(image))
            vec = np.array(result.embedding) if result.embedding else None
            cache[key] = (vec, result.live_score)
        return cache[key]

    scores, kept_labels, live_scores = [], [], []
    undetected = 0
    started = time.time()
    for i, (pair, label) in enumerate(zip(pairs, labels)):
        (a, live_a), (b, live_b) = embed(pair[0]), embed(pair[1])
        if a is None or b is None:
            undetected += 1
            continue
        scores.append(float(a @ b))
        kept_labels.append(int(label))
        live_scores += [live_a, live_b]
        if (i + 1) % 500 == 0:
            print(f"{i + 1}/{len(pairs)} pairs, {time.time() - started:.0f}s", flush=True)

    scores_arr = np.array(scores)
    labels_arr = np.array(kept_labels)
    same = scores_arr[labels_arr == 1]
    diff = scores_arr[labels_arr == 0]

    # Standard LFW protocol: 10 folds, pick the best threshold on 9, test on 1.
    order = np.arange(len(scores_arr))
    folds = np.array_split(order, 10)
    candidates = np.arange(0.0, 1.0, 0.005)
    fold_acc = []
    for k in range(10):
        test = folds[k]
        train = np.concatenate([folds[j] for j in range(10) if j != k])
        train_acc = [
            ((scores_arr[train] >= t) == (labels_arr[train] == 1)).mean() for t in candidates
        ]
        best = candidates[int(np.argmax(train_acc))]
        fold_acc.append(((scores_arr[test] >= best) == (labels_arr[test] == 1)).mean())

    rows = []
    for t in (0.25, 0.30, 0.35, 0.40, 0.45, 0.50, 0.55):
        far = float((diff >= t).mean())
        frr = float((same < t).mean())
        rows.append((t, far, int((diff >= t).sum()), frr, int((same < t).sum())))

    live = np.array(live_scores)
    summary = {
        "pairs_total": int(len(pairs)),
        "pairs_scored": int(len(scores_arr)),
        "pairs_without_detected_face": undetected,
        "same_pairs": int(len(same)),
        "different_pairs": int(len(diff)),
        "accuracy_10fold_mean": float(np.mean(fold_acc)),
        "accuracy_10fold_std": float(np.std(fold_acc)),
        "same_score_mean": float(same.mean()),
        "same_score_p01": float(np.percentile(same, 1)),
        "different_score_mean": float(diff.mean()),
        "different_score_max": float(diff.max()),
        "different_score_p999": float(np.percentile(diff, 99.9)),
        "thresholds": [
            {"threshold": t, "far": far, "false_accepts": fa, "frr": frr, "false_rejects": fr}
            for t, far, fa, frr, fr in rows
        ],
        "live_score_mean_on_lfw_photos": float(live.mean()),
        "live_score_below_half_fraction": float((live < 0.5).mean()),
        "seconds": round(time.time() - started, 1),
    }

    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "lfw_scores.json").write_text(json.dumps(summary, indent=2) + "\n")

    lines = [
        "# LFW accuracy report",
        "",
        "Produced by `eval/lfw_eval.py` running the service's own pipeline",
        "(SCRFD detector, ArcFace ResNet-50 embedding, cosine similarity).",
        "",
        f"- Pairs scored: {len(scores_arr)} of {len(pairs)} "
        f"({len(same)} same person, {len(diff)} different people)",
        f"- Pairs skipped because no face was detected: {undetected}",
        f"- Accuracy, standard 10-fold protocol: "
        f"**{np.mean(fold_acc) * 100:.2f}%** (std {np.std(fold_acc) * 100:.2f})",
        f"- Same-person similarity: mean {same.mean():.3f}, lowest 1% at {np.percentile(same, 1):.3f}",
        f"- Different-people similarity: mean {diff.mean():.3f}, highest {diff.max():.3f}",
        "",
        "## Error rates by match threshold",
        "",
        "FAR (false accept rate) is how often two different people are",
        "accepted as the same. FRR (false reject rate) is how often the same",
        "person is rejected.",
        "",
        "| Threshold | FAR | False accepts | FRR | False rejects |",
        "|---|---|---|---|---|",
    ]
    for t, far, fa, frr, fr in rows:
        lines.append(f"| {t:.2f} | {far * 100:.3f}% | {fa} / {len(diff)} | {frr * 100:.2f}% | {fr} / {len(same)} |")
    lines += [
        "",
        "## Notes",
        "",
        "- LFW photos are single still images of varied quality. A login here",
        "  uses several live frames and several enrolled templates, so the real",
        "  false reject rate is lower than the single-photo figure above.",
        "- The anti-spoofing score on these photos (which are real faces, not",
        f"  replays) averaged {live.mean():.3f}; {(live < 0.5).mean() * 100:.1f}% scored below 0.5.",
        "  LFW cannot measure spoof detection itself, since it has no attack samples.",
        "",
    ]
    (args.out / "LFW_REPORT.md").write_text("\n".join(lines))
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
