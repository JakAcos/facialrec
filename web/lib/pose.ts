// Turns MediaPipe's 478 face landmarks into the few numbers the capture
// screen needs. These mirror what the server measures, so that a frame the
// browser thinks is good is one the server will accept.

export type Point = { x: number; y: number };

export type Pose = {
  /** 0 is straight on. Positive is the person's own left. */
  yaw: number;
  /** About 0.5 is level. Lower is looking up, higher is looking down. */
  pitch: number;
  /**
   * Face width as a fraction of the frame's shorter side. Using the shorter
   * side keeps "too close" and "too far" meaning the same thing on a wide
   * laptop camera and on a tall phone camera.
   */
  faceWidth: number;
  /** Face centre, as fractions of the frame. */
  centerX: number;
  centerY: number;
};

// MediaPipe face mesh indices.
const NOSE_TIP = 1;
const IMAGE_LEFT_EYE = [33, 133];
const IMAGE_RIGHT_EYE = [362, 263];
const MOUTH_CORNERS = [61, 291];

function mid(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/**
 * `landmarks` are normalised 0..1 in the camera image (not mirrored).
 * Width and height are needed because a turn is measured in real pixels.
 */
export function measurePose(
  landmarks: Point[],
  width: number,
  height: number,
): Pose {
  const px = (i: number): Point => ({
    x: landmarks[i].x * width,
    y: landmarks[i].y * height,
  });
  const leftEye = mid(px(IMAGE_LEFT_EYE[0]), px(IMAGE_LEFT_EYE[1]));
  const rightEye = mid(px(IMAGE_RIGHT_EYE[0]), px(IMAGE_RIGHT_EYE[1]));
  const eyeMid = mid(leftEye, rightEye);
  const mouthMid = mid(px(MOUTH_CORNERS[0]), px(MOUTH_CORNERS[1]));
  const nose = px(NOSE_TIP);

  const eyeVec = { x: rightEye.x - leftEye.x, y: rightEye.y - leftEye.y };
  const eyeDist = Math.hypot(eyeVec.x, eyeVec.y) || 1;
  const yaw =
    ((nose.x - eyeMid.x) * eyeVec.x + (nose.y - eyeMid.y) * eyeVec.y) /
    (eyeDist * eyeDist);

  const axis = { x: mouthMid.x - eyeMid.x, y: mouthMid.y - eyeMid.y };
  const axisLen = Math.hypot(axis.x, axis.y) || 1;
  const pitch =
    ((nose.x - eyeMid.x) * axis.x + (nose.y - eyeMid.y) * axis.y) /
    (axisLen * axisLen);

  let minX = 1;
  let maxX = 0;
  let minY = 1;
  let maxY = 0;
  for (const p of landmarks) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return {
    yaw,
    pitch,
    faceWidth: ((maxX - minX) * width) / Math.min(width, height),
    centerX: (minX + maxX) / 2,
    centerY: (minY + maxY) / 2,
  };
}

export type Step = "center" | "left" | "right";

// The browser is deliberately stricter than the server (see
// convex/lib/faceDecision.ts) so a captured frame has room to spare.
export const CAPTURE = {
  centerMaxYaw: 0.07,
  centerPitch: [0.36, 0.62] as const,
  turnMinYaw: 0.28,
  turnMaxYaw: 0.85,
  minFaceWidth: 0.28,
  maxFaceWidth: 0.92,
  /** How many good readings in a row before a frame is taken. */
  holdTicks: 3,
};

export type Guidance = { ok: boolean; hint: string };

/** Decides whether the current pose satisfies a step, and what to tell the user. */
export function guide(step: Step, pose: Pose | null, faces: number): Guidance {
  if (!pose || faces === 0) {
    return { ok: false, hint: "Position your face inside the oval" };
  }
  if (faces > 1) {
    return { ok: false, hint: "Make sure only you are in the frame" };
  }
  if (pose.faceWidth < CAPTURE.minFaceWidth) {
    return { ok: false, hint: "Move a little closer" };
  }
  if (pose.faceWidth > CAPTURE.maxFaceWidth) {
    return { ok: false, hint: "Move back a little" };
  }
  if (Math.abs(pose.centerX - 0.5) > 0.22 || Math.abs(pose.centerY - 0.5) > 0.25) {
    return { ok: false, hint: "Center your face inside the oval" };
  }

  if (step === "center") {
    const [low, high] = CAPTURE.centerPitch;
    if (Math.abs(pose.yaw) > CAPTURE.centerMaxYaw) {
      return { ok: false, hint: "Look straight at the camera" };
    }
    if (pose.pitch < low) return { ok: false, hint: "Lower your chin a little" };
    if (pose.pitch > high) return { ok: false, hint: "Raise your chin a little" };
    return { ok: true, hint: "Hold still" };
  }

  const turn = step === "left" ? pose.yaw : -pose.yaw;
  const side = step === "left" ? "left" : "right";
  if (turn > CAPTURE.turnMaxYaw) {
    return { ok: false, hint: "Not quite so far" };
  }
  if (turn < CAPTURE.turnMinYaw) {
    return { ok: false, hint: `Slowly turn your head to your ${side}` };
  }
  return { ok: true, hint: "Hold it there" };
}
