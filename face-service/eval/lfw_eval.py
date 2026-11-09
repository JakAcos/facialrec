"""Measure how well the face matcher tells people apart, on the LFW benchmark.

LFW ("Labeled Faces in the Wild") has 6,000 labelled pairs of photos: half
show the same person, half show two different people. Running our models
(detect, align, embed, cosine similarity) over those pairs gives measured
error rates for any match threshold, instead of a guess.

Usage:
    python eval/lfw_eval.py                 compute scores, then write the report
    python eval/lfw_eval.py --report-only   rewrite the report from cached scores
    python eval/lfw_eval.py --limit 40      quick smoke run on a few pairs

Writes LFW_REPORT.md and lfw_scores.json into --out (default: this folder).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import time
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

CACHE = HERE / ".cache" / "lfw_scores.npz"
DECISION_FILE = HERE.parent.parent / "web" / "convex" / "lib" / "faceDecision.ts"


def deployed_threshold() -> float:
    """The match threshold the app really uses, read from the backend source."""
    match = re.search(r"^\s*match:\s*([0-9.]+),", DECISION_FILE.read_text(), re.MULTILINE)
    if not match:
        raise SystemExit(f"could not find the match threshold in {DECISION_FILE}")
    return float(match.group(1))


def compute(limit: int) -> dict[str, np.ndarray]:
    import cv2
    from sklearn.datasets import fetch_lfw_pairs

    from app.pipeline import Pipeline

    # Full 250x250 colour images, uncropped, so our own detector does the work.
    data = fetch_lfw_pairs(subset="10_folds", color=True, resize=1.0, slice_=None)
    pairs, labels = data.pairs, data.target
    # LFW defines ten folds of equal size, in order. Each pair keeps its
    # original fold even when other pairs are dropped for having no
    # detectable face, so the split stays the benchmark's own.
    folds = np.minimum(np.arange(len(pairs)) // (len(pairs) // 10), 9)
    if limit:
        # Take from both ends so same and different pairs are both present.
        idx = np.r_[: limit // 2, len(pairs) - limit // 2 : len(pairs)]
        pairs, labels, folds = pairs[idx], labels[idx], folds[idx]

    pipeline = Pipeline()
    cache: dict[str, tuple[np.ndarray | None, float]] = {}

    def embed(image: np.ndarray) -> tuple[np.ndarray | None, float]:
        key = hashlib.sha1(image.tobytes()).hexdigest()
        if key not in cache:
            scaled = image * 255.0 if image.max() <= 1.0 else image
            bgr = cv2.cvtColor(scaled.astype(np.uint8), cv2.COLOR_RGB2BGR)
            faces = pipeline.detector.detect(bgr)
            if not faces:
                cache[key] = (None, 0.0)
            else:
                # Many LFW photos show several people, and the label refers
                # to the one in the middle. (The live service instead uses
                # the largest face: the person sitting at the camera.)
                h, w = bgr.shape[:2]
                face = min(
                    faces,
                    key=lambda f: np.hypot(
                        (f.bbox[0] + f.bbox[2]) / 2 - w / 2, (f.bbox[1] + f.bbox[3]) / 2 - h / 2
                    ),
                )
                cache[key] = (
                    pipeline.embedder.embed(bgr, face),
                    pipeline.antispoof.live_score(bgr, face),
                )
        return cache[key]

    scores, kept_labels, kept_folds, live = [], [], [], []
    started = time.time()
    for i, (pair, label) in enumerate(zip(pairs, labels)):
        (a, live_a), (b, live_b) = embed(pair[0]), embed(pair[1])
        if (i + 1) % 500 == 0:
            print(f"{i + 1}/{len(pairs)} pairs, {time.time() - started:.0f}s", flush=True)
        if a is None or b is None:
            continue
        scores.append(float(a @ b))
        kept_labels.append(int(label))
        kept_folds.append(int(folds[i]))
        live += [live_a, live_b]

    return {
        "scores": np.array(scores),
        "labels": np.array(kept_labels),
        "folds": np.array(kept_folds),
        "live": np.array(live),
        "total_pairs": np.array(len(pairs)),
    }


def report(data: dict[str, np.ndarray], out: Path) -> dict:
    scores, labels, folds, live = data["scores"], data["labels"], data["folds"], data["live"]
    total = int(data["total_pairs"])
    undetected = total - len(scores)
    same = scores[labels == 1]
    diff = scores[labels == 0]
    threshold = deployed_threshold()

    # LFW protocol: pick the best threshold on nine folds, test on the tenth.
    candidates = np.arange(0.0, 1.0, 0.005)
    fold_acc, fold_sizes = [], []
    for k in range(10):
        test = folds == k
        train = ~test
        if not test.any() or not train.any():
            continue
        train_acc = [((scores[train] >= t) == (labels[train] == 1)).mean() for t in candidates]
        best = candidates[int(np.argmax(train_acc))]
        fold_acc.append(((scores[test] >= best) == (labels[test] == 1)).mean())
        fold_sizes.append(int(test.sum()))
    protocol_accuracy = float(np.mean(fold_acc))
    # The same result if every pair without a detected face counts as wrong.
    strict_accuracy = float(np.dot(fold_acc, fold_sizes) / total)
    # Accuracy at the one fixed threshold the app uses, with no tuning.
    deployed_accuracy = float(((scores >= threshold) == (labels == 1)).mean())

    def bound(errors: int, n: int) -> str:
        """An observed rate, or for zero errors the 95% upper bound (rule of three)."""
        if errors == 0:
            return f"0 seen (under {3 / n * 100:.2f}%)"
        return f"{errors / n * 100:.2f}%"

    rows = []
    for t in (0.25, 0.30, 0.35, 0.40, 0.45, 0.50, 0.55):
        fa, fr = int((diff >= t).sum()), int((same < t).sum())
        rows.append({"threshold": t, "false_accepts": fa, "false_rejects": fr})

    summary = {
        "pairs_total": total,
        "pairs_scored": int(len(scores)),
        "pairs_without_detected_face": undetected,
        "same_pairs": int(len(same)),
        "different_pairs": int(len(diff)),
        "accuracy_lfw_protocol_on_scored_pairs": protocol_accuracy,
        "accuracy_lfw_protocol_std": float(np.std(fold_acc)),
        "accuracy_counting_undetected_as_errors": strict_accuracy,
        "deployed_threshold": threshold,
        "accuracy_at_deployed_threshold": deployed_accuracy,
        "same_score_mean": float(same.mean()),
        "same_score_p01": float(np.percentile(same, 1)),
        "different_score_mean": float(diff.mean()),
        "different_score_max": float(diff.max()),
        "thresholds": rows,
        "live_score_mean_on_lfw_photos": float(live.mean()),
        "live_score_below_half_fraction": float((live < 0.5).mean()),
    }

    lines = [
        "# LFW face matching report",
        "",
        "Produced by `eval/lfw_eval.py` running the service's own models",
        "(SCRFD detector, ArcFace ResNet-50 embedding, cosine similarity).",
        "When a photo shows several people, the face nearest the centre is",
        "used, because that is the person the LFW label refers to.",
        "",
        f"- Pairs scored: {len(scores)} of {total} "
        f"({len(same)} same person, {len(diff)} different people)",
        f"- Pairs left out because no face was detected: {undetected}",
        f"- Accuracy on the scored pairs, LFW protocol (threshold tuned on nine "
        f"folds, tested on the tenth): **{protocol_accuracy * 100:.2f}%** "
        f"(std {np.std(fold_acc) * 100:.2f})",
        f"- The same, counting every left-out pair as a wrong answer: {strict_accuracy * 100:.2f}%",
        f"- Accuracy on the scored pairs at the threshold the app uses "
        f"({threshold:.2f}), with no tuning: **{deployed_accuracy * 100:.2f}%**",
        f"- Same-person similarity: mean {same.mean():.3f}, lowest 1% at {np.percentile(same, 1):.3f}",
        f"- Different-people similarity: mean {diff.mean():.3f}, highest {diff.max():.3f}",
        "",
        "## Error counts by match threshold",
        "",
        "A false accept is two different people judged to be the same. A",
        "false reject is the same person judged to be different. Where no",
        "error was seen, the percentage is the 95% upper bound for a sample",
        "of this size (the rule of three), not a measured zero.",
        "",
        "| Threshold | False accepts | Rate | False rejects | Rate |",
        "|---|---|---|---|---|",
    ]
    for row in rows:
        mark = " (used by the app)" if abs(row["threshold"] - threshold) < 1e-9 else ""
        lines.append(
            f"| {row['threshold']:.2f}{mark} | {row['false_accepts']} / {len(diff)} | "
            f"{bound(row['false_accepts'], len(diff))} | {row['false_rejects']} / {len(same)} | "
            f"{bound(row['false_rejects'], len(same))} |"
        )
    lines += [
        "",
        "## What this does and does not show",
        "",
        "- It measures face matching only: whether two still photos are judged",
        "  to be the same person. It is not a measurement of a whole login. A",
        "  login also needs every captured frame to pass the pose, liveness and",
        "  consistency checks, and that end-to-end rejection rate has not been",
        "  measured.",
        f"- The app's threshold ({threshold:.2f}) was chosen by looking at this same",
        "  data, so the figures at that threshold are not an independent test.",
        "- Only the straight-on match threshold is covered. The lower threshold",
        "  used for turned frames has not been evaluated.",
        f"- With {len(diff)} different-person pairs, this cannot show a false accept",
        f"  rate below about {3 / len(diff) * 100:.1f}%, however good the model is.",
        "- The anti-spoofing score on these photos (real faces, not replays)",
        f"  averaged {live.mean():.3f}, and {(live < 0.5).mean() * 100:.1f}% scored below 0.5. So most",
        "  ordinary digital photos pass the anti-spoofing check. It is not a",
        "  defence against image files sent straight to the backend. LFW has no",
        "  attack samples, so spoof detection itself is not measured here.",
        "",
    ]
    out.mkdir(parents=True, exist_ok=True)
    (out / "lfw_scores.json").write_text(json.dumps(summary, indent=2) + "\n")
    (out / "LFW_REPORT.md").write_text("\n".join(lines))
    return summary


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=0, help="only use N pairs (smoke run)")
    parser.add_argument("--report-only", action="store_true", help="reuse cached scores")
    parser.add_argument("--out", type=Path, default=HERE)
    args = parser.parse_args()

    if args.report_only:
        if not CACHE.exists():
            raise SystemExit("no cached scores yet: run once without --report-only")
        data = dict(np.load(CACHE))
    else:
        data = compute(args.limit)
        if not args.limit:
            CACHE.parent.mkdir(parents=True, exist_ok=True)
            np.savez(CACHE, **data)
    print(json.dumps(report(data, args.out), indent=2))


if __name__ == "__main__":
    main()
