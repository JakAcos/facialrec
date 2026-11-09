# LFW accuracy report

Produced by `eval/lfw_eval.py` running the service's own pipeline
(SCRFD detector, ArcFace ResNet-50 embedding, cosine similarity).

- Pairs scored: 5957 of 6000 (2980 same person, 2977 different people)
- Pairs skipped because no face was detected: 43
- Accuracy, standard 10-fold protocol: **98.41%** (std 0.48)
- Same-person similarity: mean 0.654, lowest 1% at -0.010
- Different-people similarity: mean 0.004, highest 0.243

## Error rates by match threshold

FAR (false accept rate) is how often two different people are
accepted as the same. FRR (false reject rate) is how often the same
person is rejected.

| Threshold | FAR | False accepts | FRR | False rejects |
|---|---|---|---|---|
| 0.25 | 0.000% | 0 / 2977 | 3.15% | 94 / 2980 |
| 0.30 | 0.000% | 0 / 2977 | 3.29% | 98 / 2980 |
| 0.35 | 0.000% | 0 / 2977 | 3.49% | 104 / 2980 |
| 0.40 | 0.000% | 0 / 2977 | 4.13% | 123 / 2980 |
| 0.45 | 0.000% | 0 / 2977 | 5.40% | 161 / 2980 |
| 0.50 | 0.000% | 0 / 2977 | 7.95% | 237 / 2980 |
| 0.55 | 0.000% | 0 / 2977 | 12.58% | 375 / 2980 |

## Notes

- LFW photos are single still images of varied quality. A login here
  uses several live frames and several enrolled templates, so the real
  false reject rate is lower than the single-photo figure above.
- The anti-spoofing score on these photos (which are real faces, not
  replays) averaged 0.866; 9.4% scored below 0.5.
  LFW cannot measure spoof detection itself, since it has no attack samples.
