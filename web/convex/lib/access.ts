import { getAuthSessionId, getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError } from "convex/values";
import { Id } from "../_generated/dataModel";
import { MutationCtx, QueryCtx } from "../_generated/server";

export type Identity = { userId: Id<"users">; sessionId: Id<"authSessions"> };

/** The signed-in user and login session, or null. */
export async function getIdentity(ctx: {
  auth: QueryCtx["auth"];
}): Promise<Identity | null> {
  const userId = await getAuthUserId(ctx);
  const sessionId = await getAuthSessionId(ctx);
  if (userId === null || sessionId === null) return null;
  return { userId, sessionId };
}

export async function requireIdentity(ctx: {
  auth: QueryCtx["auth"];
}): Promise<Identity> {
  const identity = await getIdentity(ctx);
  if (identity === null) {
    throw new ConvexError({ code: "UNAUTHENTICATED", message: "Sign in first." });
  }
  return identity;
}

/**
 * True when this login session has passed its face check, the check has not
 * expired, and the login session itself still exists.
 *
 * The last part matters after signing out: a login token stays technically
 * valid for a while, so a copy of it taken earlier must stop opening the
 * vault as soon as the session it belongs to is gone.
 */
export async function isFaceVerified(
  ctx: QueryCtx | MutationCtx,
  identity: Identity,
): Promise<boolean> {
  const now = Date.now();
  const login = await ctx.db.get(identity.sessionId);
  if (
    login === null ||
    login.userId !== identity.userId ||
    login.expirationTime < now
  ) {
    return false;
  }
  const row = await ctx.db
    .query("faceSessions")
    .withIndex("by_session", (q) => q.eq("sessionId", identity.sessionId))
    .unique();
  return row !== null && row.userId === identity.userId && row.expiresAt > now;
}

export async function assertFaceVerified(
  ctx: QueryCtx | MutationCtx,
  identity: Identity,
): Promise<void> {
  if (!(await isFaceVerified(ctx, identity))) {
    throw new ConvexError({
      code: "FACE_NOT_VERIFIED",
      message: "Verify your face to unlock your files.",
    });
  }
}

/**
 * Gate for everything that touches a user's files. Being signed in with
 * Google is not enough: the session must also have passed the face check.
 */
export async function requireVerified(
  ctx: QueryCtx | MutationCtx,
): Promise<Identity> {
  const identity = await requireIdentity(ctx);
  await assertFaceVerified(ctx, identity);
  return identity;
}
