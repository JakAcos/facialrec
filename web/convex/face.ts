import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import {
  action,
  internalMutation,
  mutation,
  query,
} from "./_generated/server";
import { getIdentity, isFaceVerified, requireIdentity } from "./lib/access";
import { decryptTemplates, encryptTemplates } from "./lib/faceCrypto";
import {
  decideEnroll,
  decideVerify,
  Decision,
  FAILURE_MESSAGES,
  FrameAnalysis,
  Step,
} from "./lib/faceDecision";

/** How long a passed face check keeps the vault unlocked. */
export const FACE_SESSION_MS = 12 * 60 * 60 * 1000;
/** A challenge must be answered quickly so frames cannot be prepared offline. */
export const CHALLENGE_MS = 2 * 60 * 1000;
/** After this many failed checks inside the window, the account is locked for the rest of it. */
export const MAX_FAILED_VERIFIES = 5;
export const MAX_FAILED_ENROLLS = 20;
export const LOCK_WINDOW_MS = 10 * 60 * 1000;
const MAX_FRAME_BYTES = 600 * 1024;

type Kind = "enroll" | "verify";

async function lockedUntil(
  ctx: { db: import("./_generated/server").QueryCtx["db"] },
  userId: Id<"users">,
  kind: Kind,
): Promise<number | null> {
  const since = Date.now() - LOCK_WINDOW_MS;
  const recent = await ctx.db
    .query("faceAttempts")
    .withIndex("by_user_at", (q) => q.eq("userId", userId).gt("at", since))
    .collect();
  const failures = recent.filter((a) => a.kind === kind && !a.success);
  const limit = kind === "verify" ? MAX_FAILED_VERIFIES : MAX_FAILED_ENROLLS;
  if (failures.length < limit) return null;
  // Locked until the oldest counted failure leaves the window.
  const counted = failures.slice(-limit);
  return counted[0].at + LOCK_WINDOW_MS;
}

/** Everything the UI needs to decide which screen to show. */
export const status = query({
  args: {},
  handler: async (ctx) => {
    const identity = await getIdentity(ctx);
    if (identity === null) return null;
    const profile = await ctx.db
      .query("faceProfiles")
      .withIndex("by_user", (q) => q.eq("userId", identity.userId))
      .unique();
    const session = await ctx.db
      .query("faceSessions")
      .withIndex("by_session", (q) => q.eq("sessionId", identity.sessionId))
      .unique();
    const verified = await isFaceVerified(ctx, identity);
    return {
      enrolled: profile !== null,
      enrolledAt: profile?.updatedAt ?? null,
      verified,
      verifiedUntil: verified ? session!.expiresAt : null,
      lockedUntil: await lockedUntil(
        ctx,
        identity.userId,
        profile ? "verify" : "enroll",
      ),
    };
  },
});

/**
 * Starts a face check. The server, not the browser, picks which way the head
 * must turn, so a recording made in advance is unlikely to match.
 */
export const startChallenge = mutation({
  args: { reenroll: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    const profile = await ctx.db
      .query("faceProfiles")
      .withIndex("by_user", (q) => q.eq("userId", identity.userId))
      .unique();

    let kind: Kind = profile ? "verify" : "enroll";
    if (args.reenroll && profile) {
      // Replacing the enrolled face is only allowed from an unlocked session.
      // Otherwise someone with only the Google login could enroll their own face.
      if (!(await isFaceVerified(ctx, identity))) {
        throw new ConvexError({
          code: "FACE_NOT_VERIFIED",
          message: "Verify your face before replacing it.",
        });
      }
      kind = "enroll";
    }

    const locked = await lockedUntil(ctx, identity.userId, kind);
    if (locked !== null) {
      throw new ConvexError({
        code: "LOCKED",
        message: "Too many failed attempts. Try again in a few minutes.",
        lockedUntil: locked,
      });
    }

    const turn: Step = Math.random() < 0.5 ? "left" : "right";
    const steps: Step[] =
      kind === "enroll" ? ["center", "left", "right"] : ["center", turn];
    const expiresAt = Date.now() + CHALLENGE_MS;
    const challengeId = await ctx.db.insert("faceChallenges", {
      userId: identity.userId,
      sessionId: identity.sessionId,
      kind,
      steps,
      expiresAt,
      used: false,
    });
    return { challengeId, kind, steps, expiresAt };
  },
});

/** Marks a challenge as used (each one works once) and loads what the check needs. */
export const beginAttempt = internalMutation({
  args: {
    challengeId: v.id("faceChallenges"),
    userId: v.id("users"),
    sessionId: v.id("authSessions"),
  },
  handler: async (ctx, args) => {
    const challenge = await ctx.db.get(args.challengeId);
    if (
      challenge === null ||
      challenge.userId !== args.userId ||
      challenge.sessionId !== args.sessionId ||
      challenge.used ||
      challenge.expiresAt < Date.now()
    ) {
      throw new ConvexError({
        code: "CHALLENGE_EXPIRED",
        message: "That face check expired. Please start again.",
      });
    }
    const locked = await lockedUntil(ctx, args.userId, challenge.kind);
    if (locked !== null) {
      throw new ConvexError({
        code: "LOCKED",
        message: "Too many failed attempts. Try again in a few minutes.",
        lockedUntil: locked,
      });
    }
    await ctx.db.patch(challenge._id, { used: true });
    const profile = await ctx.db
      .query("faceProfiles")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .unique();
    return {
      kind: challenge.kind,
      steps: challenge.steps,
      encryptedTemplates: profile?.encryptedTemplates ?? null,
    };
  },
});

/** Records the outcome and, on success, unlocks this login session. */
export const finishAttempt = internalMutation({
  args: {
    userId: v.id("users"),
    sessionId: v.id("authSessions"),
    kind: v.union(v.literal("enroll"), v.literal("verify")),
    success: v.boolean(),
    reason: v.optional(v.string()),
    newProfile: v.optional(
      v.object({
        encryptedTemplates: v.bytes(),
        templateCount: v.number(),
        model: v.string(),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    await ctx.db.insert("faceAttempts", {
      userId: args.userId,
      kind: args.kind,
      success: args.success,
      reason: args.reason,
      at: now,
    });
    if (!args.success) return;

    if (args.newProfile) {
      const existing = await ctx.db
        .query("faceProfiles")
        .withIndex("by_user", (q) => q.eq("userId", args.userId))
        .unique();
      const doc = { userId: args.userId, ...args.newProfile, updatedAt: now };
      if (existing) await ctx.db.replace(existing._id, doc);
      else await ctx.db.insert("faceProfiles", doc);
    }

    const session = await ctx.db
      .query("faceSessions")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .unique();
    const fields = {
      sessionId: args.sessionId,
      userId: args.userId,
      verifiedAt: now,
      expiresAt: now + FACE_SESSION_MS,
    };
    if (session) await ctx.db.replace(session._id, fields);
    else await ctx.db.insert("faceSessions", fields);
  },
});

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

type ServiceFrame = {
  face_count: number;
  det_score: number;
  face_size: number;
  yaw: number;
  pitch: number;
  live_score: number;
  embedding: number[] | null;
};

/** Sends the frames to the face service, which only measures and decides nothing. */
async function analyzeFrames(
  frames: ArrayBuffer[],
): Promise<{ frames: FrameAnalysis[]; model: string }> {
  const url = process.env.FACE_SERVICE_URL;
  const secret = process.env.FACE_SERVICE_SECRET;
  if (!url || !secret) throw new Error("Face service is not configured");
  const res = await fetch(`${url.replace(/\/$/, "")}/analyze`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-face-secret": secret },
    body: JSON.stringify({ frames: frames.map(toBase64) }),
  });
  if (!res.ok) throw new Error(`Face service returned ${res.status}`);
  const body = (await res.json()) as { model: string; frames: ServiceFrame[] };
  return {
    model: body.model,
    frames: body.frames.map((f) => ({
      faceCount: f.face_count,
      detScore: f.det_score,
      faceSize: f.face_size,
      yaw: f.yaw,
      pitch: f.pitch,
      liveScore: f.live_score,
      embedding: f.embedding ?? [],
    })),
  };
}

/**
 * The face check itself. The browser sends the frames it captured for the
 * challenge. All the trust decisions happen here on the server.
 */
export const submit = action({
  args: {
    challengeId: v.id("faceChallenges"),
    frames: v.array(v.bytes()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ ok: boolean; kind: Kind; reason?: string; message?: string }> => {
    const identity = await requireIdentity(ctx);
    if (
      args.frames.length === 0 ||
      args.frames.length > 5 ||
      args.frames.some((f) => f.byteLength > MAX_FRAME_BYTES)
    ) {
      throw new ConvexError({ code: "BAD_FRAMES", message: "Invalid capture." });
    }

    const attempt = await ctx.runMutation(internal.face.beginAttempt, {
      challengeId: args.challengeId,
      ...identity,
    });
    const steps = attempt.steps as Step[];

    let decision: Decision;
    let analysis: { frames: FrameAnalysis[]; model: string } | null = null;
    if (args.frames.length !== steps.length) {
      decision = { ok: false, reason: "WRONG_FRAME_COUNT" };
    } else {
      analysis = await analyzeFrames(args.frames);
      if (attempt.kind === "enroll") {
        decision = decideEnroll(steps, analysis.frames);
      } else {
        const templates = attempt.encryptedTemplates
          ? await decryptTemplates(attempt.encryptedTemplates)
          : [];
        decision = decideVerify(steps, analysis.frames, templates);
      }
    }

    let newProfile;
    if (decision.ok && attempt.kind === "enroll" && analysis) {
      const templates = analysis.frames.map((f) => f.embedding);
      newProfile = {
        encryptedTemplates: await encryptTemplates(templates),
        templateCount: templates.length,
        model: analysis.model,
      };
    }

    await ctx.runMutation(internal.face.finishAttempt, {
      ...identity,
      kind: attempt.kind,
      success: decision.ok,
      reason: decision.ok ? undefined : decision.reason,
      newProfile,
    });

    if (decision.ok) return { ok: true, kind: attempt.kind };
    return {
      ok: false,
      kind: attempt.kind,
      reason: decision.reason,
      message: FAILURE_MESSAGES[decision.reason],
    };
  },
});

/** Locks the vault again without signing out of Google. */
export const lock = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await requireIdentity(ctx);
    const session = await ctx.db
      .query("faceSessions")
      .withIndex("by_session", (q) => q.eq("sessionId", identity.sessionId))
      .unique();
    if (session) await ctx.db.delete(session._id);
  },
});

/** Housekeeping: drop expired challenges, sessions and old attempt records. */
export const cleanup = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    for (const c of await ctx.db.query("faceChallenges").take(500)) {
      if (c.expiresAt < now) await ctx.db.delete(c._id);
    }
    for (const s of await ctx.db.query("faceSessions").take(500)) {
      if (s.expiresAt < now) await ctx.db.delete(s._id);
    }
    const monthAgo = now - 30 * 24 * 60 * 60 * 1000;
    for (const a of await ctx.db.query("faceAttempts").take(500)) {
      if (a.at < monthAgo) await ctx.db.delete(a._id);
    }
  },
});
