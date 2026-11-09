import { describe, expect, test } from "vitest";
import {
  cosine,
  decideEnroll,
  decideVerify,
  FrameAnalysis,
  Step,
  THRESHOLDS,
} from "./faceDecision";

/** A unit vector that is `similarity` (cosine) away from the base identity. */
function embedding(identity: number, similarity = 1): number[] {
  const v = new Array(512).fill(0);
  v[identity] = similarity;
  v[identity + 100] = Math.sqrt(1 - similarity * similarity);
  return v;
}

function frame(over: Partial<FrameAnalysis> = {}): FrameAnalysis {
  return {
    faceCount: 1,
    detScore: 0.85,
    faceSize: 160,
    yaw: 0,
    pitch: 0.48,
    liveScore: 0.99,
    embedding: embedding(0),
    ...over,
  };
}

const VERIFY: Step[] = ["center", "left"];
const good = () => [frame(), frame({ yaw: 0.4, embedding: embedding(0, 0.8) })];
const templates = [embedding(0), embedding(0, 0.8)];

describe("cosine", () => {
  test("identical is 1, unrelated is 0", () => {
    expect(cosine(embedding(0), embedding(0))).toBeCloseTo(1);
    expect(cosine(embedding(0), embedding(1))).toBeCloseTo(0);
  });
});

describe("decideVerify", () => {
  test("accepts the enrolled person doing the requested turn", () => {
    expect(decideVerify(VERIFY, good(), templates)).toMatchObject({ ok: true });
  });

  test("rejects a different person even with perfect liveness", () => {
    const impostor = [
      frame({ embedding: embedding(1) }),
      frame({ yaw: 0.4, embedding: embedding(1, 0.8) }),
    ];
    expect(decideVerify(VERIFY, impostor, templates)).toEqual({
      ok: false,
      reason: "NO_MATCH",
      step: "center",
    });
  });

  test("rejects a similarity just under the threshold and accepts just over", () => {
    const under = [frame({ embedding: embedding(0, THRESHOLDS.match - 0.01) }), good()[1]];
    const over = [frame({ embedding: embedding(0, THRESHOLDS.match + 0.01) }), good()[1]];
    expect(decideVerify(VERIFY, under, [embedding(0)]).ok).toBe(false);
    expect(decideVerify(VERIFY, over, [embedding(0)]).ok).toBe(true);
  });

  test("rejects a static photo: the head never turns", () => {
    const photo = [frame(), frame({ yaw: 0.01 })];
    expect(decideVerify(VERIFY, photo, templates)).toEqual({
      ok: false,
      reason: "POSE_MISMATCH",
      step: "left",
    });
  });

  test("rejects a turn in the wrong direction", () => {
    const wrongWay = [frame(), frame({ yaw: -0.4, embedding: embedding(0, 0.8) })];
    expect(decideVerify(VERIFY, wrongWay, templates)).toMatchObject({
      ok: false,
      reason: "POSE_MISMATCH",
    });
    expect(decideVerify(["center", "right"], wrongWay, templates).ok).toBe(true);
  });

  test("rejects a center frame that is not straight or not level", () => {
    for (const bad of [{ yaw: 0.2 }, { pitch: 0.1 }, { pitch: 0.85 }]) {
      expect(decideVerify(VERIFY, [frame(bad), good()[1]], templates)).toEqual({
        ok: false,
        reason: "POSE_MISMATCH",
        step: "center",
      });
    }
  });

  test("rejects when the anti-spoofing model flags the center frame", () => {
    const spoof = [frame({ liveScore: 0.2 }), good()[1]];
    expect(decideVerify(VERIFY, spoof, templates)).toMatchObject({
      ok: false,
      reason: "SPOOF_SUSPECTED",
    });
  });

  test("rejects mixed identities: owner's photo plus someone else's turn", () => {
    const mixed = [frame(), frame({ yaw: 0.4, embedding: embedding(1) })];
    expect(decideVerify(VERIFY, mixed, [...templates, embedding(1)])).toMatchObject({
      ok: false,
      reason: "INCONSISTENT_IDENTITY",
    });
  });

  test("rejects missing faces, extra faces and tiny faces", () => {
    expect(decideVerify(VERIFY, [frame({ faceCount: 0 }), good()[1]], templates)).toMatchObject({ reason: "NO_FACE" });
    expect(decideVerify(VERIFY, [frame({ detScore: 0.3 }), good()[1]], templates)).toMatchObject({ reason: "NO_FACE" });
    expect(decideVerify(VERIFY, [frame({ faceCount: 2 }), good()[1]], templates)).toMatchObject({ reason: "MULTIPLE_FACES" });
    expect(decideVerify(VERIFY, [frame({ faceSize: 40 }), good()[1]], templates)).toMatchObject({ reason: "FACE_TOO_SMALL" });
  });

  test("rejects the wrong number of frames and an empty enrollment", () => {
    expect(decideVerify(VERIFY, [frame()], templates)).toMatchObject({ reason: "WRONG_FRAME_COUNT" });
    expect(decideVerify(VERIFY, good(), [])).toMatchObject({ reason: "NO_MATCH" });
  });
});

describe("decideEnroll", () => {
  const steps: Step[] = ["center", "left", "right"];
  const frames = () => [
    frame(),
    frame({ yaw: 0.4, embedding: embedding(0, 0.8) }),
    frame({ yaw: -0.4, embedding: embedding(0, 0.8) }),
  ];

  test("accepts a live person completing all three poses", () => {
    expect(decideEnroll(steps, frames()).ok).toBe(true);
  });

  test("rejects when a pose is skipped", () => {
    const f = frames();
    f[2] = frame({ yaw: 0.4, embedding: embedding(0, 0.8) });
    expect(decideEnroll(steps, f)).toMatchObject({ reason: "POSE_MISMATCH", step: "right" });
  });
});
