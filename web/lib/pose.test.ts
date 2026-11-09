import { describe, expect, test } from "vitest";
import { guide, measurePose, type Point } from "./pose";

/**
 * Builds a fake set of MediaPipe landmarks for a face `faceW` wide (in
 * pixels) in a frame of the given size. `nose` shifts the nose tip as a
 * fraction of the eye distance, which is what a head turn does.
 */
function face(
  frameW: number,
  frameH: number,
  faceW: number,
  nose: { dx?: number; dy?: number } = {},
  center = { x: 0.5, y: 0.5 },
): Point[] {
  const cx = center.x * frameW;
  const cy = center.y * frameH;
  const eye = faceW * 0.4; // distance between eye centres
  const at = (x: number, y: number): Point => ({ x: x / frameW, y: y / frameH });
  const points: Point[] = Array.from({ length: 478 }, () => at(cx, cy));
  const eyeY = cy - faceW * 0.15;
  const mouthY = eyeY + eye; // mouth line one eye-distance below the eyes
  points[33] = at(cx - eye / 2 - 10, eyeY);
  points[133] = at(cx - eye / 2 + 10, eyeY);
  points[362] = at(cx + eye / 2 - 10, eyeY);
  points[263] = at(cx + eye / 2 + 10, eyeY);
  points[61] = at(cx - eye / 3, mouthY);
  points[291] = at(cx + eye / 3, mouthY);
  points[1] = at(cx + (nose.dx ?? 0) * eye, eyeY + (0.5 + (nose.dy ?? 0)) * eye);
  // Outline, so the bounding box has the requested width.
  points[234] = at(cx - faceW / 2, cy);
  points[454] = at(cx + faceW / 2, cy);
  points[10] = at(cx, cy - faceW * 0.65);
  points[152] = at(cx, cy + faceW * 0.65);
  return points;
}

describe("measurePose", () => {
  test("a straight, level face reads as yaw 0 and pitch 0.5", () => {
    const pose = measurePose(face(1280, 720, 300), 1280, 720);
    expect(pose.yaw).toBeCloseTo(0);
    expect(pose.pitch).toBeCloseTo(0.5);
    expect(pose.centerX).toBeCloseTo(0.5);
  });

  test("yaw is positive when the nose moves toward the right of the image", () => {
    expect(measurePose(face(1280, 720, 300, { dx: 0.4 }), 1280, 720).yaw).toBeCloseTo(0.4);
    expect(measurePose(face(1280, 720, 300, { dx: -0.4 }), 1280, 720).yaw).toBeCloseTo(-0.4);
  });

  test("face size means the same on a wide camera and a tall phone camera", () => {
    const wide = measurePose(face(1280, 720, 360), 1280, 720);
    const tall = measurePose(face(720, 1280, 360), 720, 1280);
    expect(wide.faceWidth).toBeCloseTo(0.5);
    expect(tall.faceWidth).toBeCloseTo(0.5);
  });
});

describe("guide", () => {
  const pose = (frameW: number, frameH: number, faceW: number, nose = {}, center?: { x: number; y: number }) =>
    measurePose(face(frameW, frameH, faceW, nose, center), frameW, frameH);

  test("asks for a face, and for only one", () => {
    expect(guide("center", null, 0)).toMatchObject({ ok: false, hint: "Position your face inside the oval" });
    expect(guide("center", pose(1280, 720, 300), 2)).toMatchObject({ ok: false, hint: "Make sure only you are in the frame" });
  });

  test("coaches distance and centring", () => {
    expect(guide("center", pose(1280, 720, 120), 1).hint).toBe("Move a little closer");
    expect(guide("center", pose(1280, 720, 700), 1).hint).toBe("Move back a little");
    expect(guide("center", pose(1280, 720, 300, {}, { x: 0.15, y: 0.5 }), 1).hint).toBe("Center your face inside the oval");
    // A normal selfie distance on a phone in portrait must not be "too close".
    expect(guide("center", pose(720, 1280, 430), 1).ok).toBe(true);
  });

  test("the center step needs a straight, level look", () => {
    expect(guide("center", pose(1280, 720, 300), 1)).toEqual({ ok: true, hint: "Hold still" });
    expect(guide("center", pose(1280, 720, 300, { dx: 0.2 }), 1).hint).toBe("Look straight at the camera");
    expect(guide("center", pose(1280, 720, 300, { dy: -0.3 }), 1).hint).toBe("Lower your chin a little");
    expect(guide("center", pose(1280, 720, 300, { dy: 0.3 }), 1).hint).toBe("Raise your chin a little");
  });

  test("turn steps need a clear turn in the requested direction", () => {
    const left = pose(1280, 720, 300, { dx: 0.45 });
    const right = pose(1280, 720, 300, { dx: -0.45 });
    expect(guide("left", left, 1)).toEqual({ ok: true, hint: "Hold it there" });
    expect(guide("right", right, 1).ok).toBe(true);
    expect(guide("left", right, 1)).toEqual({ ok: false, hint: "Slowly turn your head to your left" });
    expect(guide("right", pose(1280, 720, 300), 1).hint).toBe("Slowly turn your head to your right");
    expect(guide("left", pose(1280, 720, 300, { dx: 0.95 }), 1).hint).toBe("Not quite so far");
  });
});
