// The yes/no decision for a face check. This is plain data-in, data-out code
// so it can be unit tested without a camera, a network or a database.
//
// The face service only measures (where is the face, which way is it turned,
// what is its embedding, does it look like a live person). The rules below
// decide whether those measurements are good enough.

export type Step = "center" | "left" | "right";

/** What the face service reports for one camera frame. */
export type FrameAnalysis = {
  faceCount: number;
  detScore: number;
  /** Width of the detected face in pixels. */
  faceSize: number;
  /** Head turn. 0 is straight on, positive is the person's own left. */
  yaw: number;
  /** Head tilt. About 0.5 is level, lower is looking up, higher is looking down. */
  pitch: number;
  /** Probability from the anti-spoofing model that this is a live face. */
  liveScore: number;
  /** L2-normalised ArcFace embedding. */
  embedding: number[];
};

export type FailureReason =
  | "WRONG_FRAME_COUNT"
  | "NO_FACE"
  | "MULTIPLE_FACES"
  | "FACE_TOO_SMALL"
  | "POSE_MISMATCH"
  | "SPOOF_SUSPECTED"
  | "INCONSISTENT_IDENTITY"
  | "NO_MATCH";

export type Decision =
  | { ok: true; bestScore: number }
  | { ok: false; reason: FailureReason; step?: Step };

// Thresholds. The match values come from running this exact pipeline over
// the LFW benchmark (face-service/eval/LFW_REPORT.md): across 2,977 pairs of
// different people the highest similarity was 0.23, and at 0.40 there were
// no false accepts while 1.3% of same-person still photos were rejected.
export const THRESHOLDS = {
  minDetScore: 0.6,
  minFaceSize: 80,
  /** |yaw| must be below this for a "center" frame. */
  centerMaxYaw: 0.13,
  /** |yaw| must be above this, in the requested direction, for a turn. */
  turnMinYaw: 0.16,
  /** A "center" frame must be roughly level: pitch inside this range. */
  centerPitch: [0.28, 0.7],
  minLiveScore: 0.5,
  /** Cosine similarity needed between a straight-on frame and an enrolled template. */
  match: 0.4,
  /** Turned faces embed less reliably, so they get a slightly lower bar. */
  turnedMatch: 0.33,
  /** Frames within one submission must show the same person. */
  consistency: 0.35,
} as const;

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

function bestMatch(embedding: number[], templates: number[][]): number {
  let best = -1;
  for (const t of templates) best = Math.max(best, cosine(embedding, t));
  return best;
}

function poseMatches(step: Step, frame: FrameAnalysis): boolean {
  if (step === "center") {
    const [low, high] = THRESHOLDS.centerPitch;
    return (
      Math.abs(frame.yaw) <= THRESHOLDS.centerMaxYaw &&
      frame.pitch >= low &&
      frame.pitch <= high
    );
  }
  if (step === "left") return frame.yaw >= THRESHOLDS.turnMinYaw;
  return frame.yaw <= -THRESHOLDS.turnMinYaw;
}

/**
 * Checks that the frames are usable and really show a live person doing the
 * requested head movements. Shared by enrollment and verification.
 */
export function checkLiveness(
  steps: Step[],
  frames: FrameAnalysis[],
): Decision {
  if (frames.length !== steps.length || steps.length < 2) {
    return { ok: false, reason: "WRONG_FRAME_COUNT" };
  }
  for (let i = 0; i < steps.length; i++) {
    const f = frames[i];
    const step = steps[i];
    if (f.faceCount === 0 || f.detScore < THRESHOLDS.minDetScore) {
      return { ok: false, reason: "NO_FACE", step };
    }
    if (f.faceCount > 1) return { ok: false, reason: "MULTIPLE_FACES", step };
    if (f.faceSize < THRESHOLDS.minFaceSize) {
      return { ok: false, reason: "FACE_TOO_SMALL", step };
    }
    // A flat photo cannot change its yaw: turning a photo squeezes the whole
    // face evenly, so the nose never moves relative to the eyes.
    if (!poseMatches(step, f)) {
      return { ok: false, reason: "POSE_MISMATCH", step };
    }
    // The anti-spoofing model is trained on straight-on faces, so it is only
    // applied to the center frames.
    if (step === "center" && f.liveScore < THRESHOLDS.minLiveScore) {
      return { ok: false, reason: "SPOOF_SUSPECTED", step };
    }
  }
  // Every frame must be the same person, otherwise someone could mix a photo
  // of the owner with their own moving head.
  const anchor = frames[0].embedding;
  for (let i = 1; i < frames.length; i++) {
    if (cosine(anchor, frames[i].embedding) < THRESHOLDS.consistency) {
      return { ok: false, reason: "INCONSISTENT_IDENTITY", step: steps[i] };
    }
  }
  return { ok: true, bestScore: 1 };
}

/** Enrollment: liveness only, there is nothing to compare against yet. */
export function decideEnroll(steps: Step[], frames: FrameAnalysis[]): Decision {
  return checkLiveness(steps, frames);
}

/** Verification: liveness plus every frame must match the enrolled templates. */
export function decideVerify(
  steps: Step[],
  frames: FrameAnalysis[],
  templates: number[][],
): Decision {
  const live = checkLiveness(steps, frames);
  if (!live.ok) return live;
  if (templates.length === 0) return { ok: false, reason: "NO_MATCH" };

  let centerBest = -1;
  for (let i = 0; i < steps.length; i++) {
    const score = bestMatch(frames[i].embedding, templates);
    const needed =
      steps[i] === "center" ? THRESHOLDS.match : THRESHOLDS.turnedMatch;
    if (score < needed) return { ok: false, reason: "NO_MATCH", step: steps[i] };
    if (steps[i] === "center") centerBest = Math.max(centerBest, score);
  }
  return { ok: true, bestScore: centerBest };
}

/** Friendly text for each failure, shown on the face check screen. */
export const FAILURE_MESSAGES: Record<FailureReason, string> = {
  WRONG_FRAME_COUNT: "The capture was incomplete. Please try again.",
  NO_FACE: "We could not see a clear face. Check your lighting and try again.",
  MULTIPLE_FACES: "More than one face is in view. Make sure you are alone in the frame.",
  FACE_TOO_SMALL: "Move a little closer to the camera and try again.",
  POSE_MISMATCH: "The head movement did not match the instructions. Try again and follow the prompts.",
  SPOOF_SUSPECTED: "This did not look like a live face. Avoid screens or photos, and face the light.",
  INCONSISTENT_IDENTITY: "The frames did not look like the same person. Please try again.",
  NO_MATCH: "This face does not match the one enrolled for this account.",
};
