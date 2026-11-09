# LFW face matching report

Produced by `eval/lfw_eval.py` running the service's own models
(SCRFD detector, ArcFace ResNet-50 embedding, cosine similarity).
When a photo shows several people, the face nearest the centre is
used, because that is the person the LFW label refers to.

- Pairs scored: 6000 of 6000 (3000 same person, 3000 different people)
- Pairs left out because no face was detected: 0
- Accuracy on the scored pairs, LFW protocol (threshold tuned on nine folds, tested on the tenth): **99.85%** (std 0.17)
- The same, counting every left-out pair as a wrong answer: 99.85%
- Accuracy on the scored pairs at the threshold the app uses (0.40), with no tuning: **99.37%**
- Same-person similarity: mean 0.672, lowest 1% at 0.393
- Different-people similarity: mean 0.004, highest 0.231

## Error counts by match threshold

A false accept is two different people judged to be the same. A
false reject is the same person judged to be different. The last
column also counts the 0 same-person pairs where no face was
found, since the app would turn those people away too. Where no
error was seen, the percentage is the 95% upper bound for a sample
of this size (the rule of three), not a measured zero.

| Threshold | False accepts | Rate | False rejects | Rate | Rate incl. undetected |
|---|---|---|---|---|---|
| 0.25 | 0 / 3000 | 0 seen (under 0.10%) | 8 / 3000 | 0.27% | 0.27% |
| 0.30 | 0 / 3000 | 0 seen (under 0.10%) | 12 / 3000 | 0.40% | 0.40% |
| 0.35 | 0 / 3000 | 0 seen (under 0.10%) | 18 / 3000 | 0.60% | 0.60% |
| 0.40 (used by the app) | 0 / 3000 | 0 seen (under 0.10%) | 38 / 3000 | 1.27% | 1.27% |
| 0.45 | 0 / 3000 | 0 seen (under 0.10%) | 77 / 3000 | 2.57% | 2.57% |
| 0.50 | 0 / 3000 | 0 seen (under 0.10%) | 161 / 3000 | 5.37% | 5.37% |
| 0.55 | 0 / 3000 | 0 seen (under 0.10%) | 303 / 3000 | 10.10% | 10.10% |

## What this does and does not show

- It measures face matching only: whether two still photos are judged
  to be the same person. It is not a measurement of a whole login. A
  login also needs every captured frame to pass the pose, liveness and
  consistency checks, and that end-to-end rejection rate has not been
  measured.
- The app's match threshold (0.40) was chosen by looking at this
  same data, so the figures at that threshold are not an independent test.
- Only the straight-on match threshold is covered. The lower threshold
  for turned frames, the frame-to-frame consistency threshold and the
  liveness threshold were set by judgement and have not been evaluated.
- With 3000 different-person pairs, this cannot show a false accept
  rate below about 0.1%, however good the model is. The pairs
  are also random people, not look-alikes or relatives, who are harder.
- The anti-spoofing score on these photos (real faces, not replays)
  averaged 0.866, and 9.4% scored below 0.5. So most
  ordinary digital photos pass the anti-spoofing check. It is not a
  defence against image files sent straight to the backend. LFW has no
  attack samples, so spoof detection itself is not measured here.
