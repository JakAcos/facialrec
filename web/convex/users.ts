import { v } from "convex/values";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { mutation, MutationCtx, query } from "./_generated/server";
import { UPLOAD_FORM_LIFETIME_MS } from "./files";
import { getIdentity, requireVerified } from "./lib/access";

/** The signed-in user's profile, or null when signed out. */
export const me = query({
  args: {},
  handler: async (ctx) => {
    const identity = await getIdentity(ctx);
    if (identity === null) return null;
    const user = await ctx.db.get(identity.userId);
    if (user === null) return null;
    return {
      _id: user._id,
      name: user.name ?? null,
      email: user.email ?? null,
      image: user.image ?? null,
      joinedAt: user._creationTime,
    };
  },
});

/** Whether the test-only password login is switched on for this deployment. */
export const testLoginEnabled = query({
  args: {},
  handler: async () => process.env.ENABLE_TEST_LOGIN === "true",
});

/** Removes every trace of one user: files, folders, face data and logins. */
export async function purgeUser(ctx: MutationCtx, userId: Id<"users">) {
  const files = await ctx.db
    .query("files")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  const keys = files.map((f) => f.storageKey).filter((k) => k.length > 0);
  for (const f of files) await ctx.db.delete(f._id);
  if (keys.length > 0) {
    await ctx.scheduler.runAfter(0, internal.files.deleteObjects, { keys });
  }
  // A recent upload form could still write to its key after the account is
  // gone, so those keys are deleted once more when the forms have expired.
  const recent = files
    .filter((f) => f.createdAt + UPLOAD_FORM_LIFETIME_MS > Date.now())
    .map((f) => f.storageKey)
    .filter((k) => k.length > 0);
  if (recent.length > 0) {
    await ctx.scheduler.runAfter(
      UPLOAD_FORM_LIFETIME_MS,
      internal.files.deleteObjects,
      { keys: recent },
    );
  }

  const folders = await ctx.db
    .query("folders")
    .withIndex("by_user_parent", (q) => q.eq("userId", userId))
    .collect();
  for (const f of folders) await ctx.db.delete(f._id);

  for (const table of ["faceProfiles", "faceSessions", "faceChallenges"] as const) {
    const rows = await ctx.db
      .query(table)
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    for (const r of rows) await ctx.db.delete(r._id);
  }
  const attempts = await ctx.db
    .query("faceAttempts")
    .withIndex("by_user_at", (q) => q.eq("userId", userId))
    .collect();
  for (const a of attempts) await ctx.db.delete(a._id);

  const sessions = await ctx.db
    .query("authSessions")
    .withIndex("userId", (q) => q.eq("userId", userId))
    .collect();
  for (const s of sessions) {
    const tokens = await ctx.db
      .query("authRefreshTokens")
      .withIndex("sessionId", (q) => q.eq("sessionId", s._id))
      .collect();
    for (const t of tokens) await ctx.db.delete(t._id);
    await ctx.db.delete(s._id);
  }
  const accounts = await ctx.db
    .query("authAccounts")
    .withIndex("userIdAndProvider", (q) => q.eq("userId", userId))
    .collect();
  for (const a of accounts) await ctx.db.delete(a._id);
  await ctx.db.delete(userId);
}

/**
 * Permanently deletes the account: files, folders, face data and logins.
 * Biometric data should always be removable by its owner.
 */
export const deleteAccount = mutation({
  args: { confirm: v.literal("DELETE") },
  handler: async (ctx) => {
    const { userId } = await requireVerified(ctx);
    await purgeUser(ctx, userId);
  },
});
