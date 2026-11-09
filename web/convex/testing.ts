// Helpers for the automated browser tests. They are internal functions, so
// they cannot be called from a browser at all, only by someone with admin
// access to the deployment (`npx convex run`). On top of that they refuse to
// run unless ENABLE_TEST_LOGIN is on, which production never sets.

import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction, internalMutation } from "./_generated/server";
import { encryptTemplates } from "./lib/faceCrypto";
import { purgeUser } from "./users";

const TEST_EMAIL_SUFFIX = "@example.test";

function assertTestDeployment() {
  if (process.env.ENABLE_TEST_LOGIN !== "true") {
    throw new Error("Test helpers are disabled on this deployment");
  }
}

/**
 * Enrolls a test account with someone else's face templates. This is how
 * the tests set up "the person at the camera is not the account owner".
 */
export const seedFaceProfile = internalAction({
  args: { email: v.string(), templates: v.array(v.array(v.number())) },
  handler: async (ctx, args) => {
    assertTestDeployment();
    await ctx.runMutation(internal.testing.writeFaceProfile, {
      email: args.email,
      encryptedTemplates: await encryptTemplates(args.templates),
      templateCount: args.templates.length,
    });
  },
});

export const writeFaceProfile = internalMutation({
  args: {
    email: v.string(),
    encryptedTemplates: v.bytes(),
    templateCount: v.number(),
  },
  handler: async (ctx, args) => {
    assertTestDeployment();
    if (!args.email.endsWith(TEST_EMAIL_SUFFIX)) {
      throw new Error("Only test accounts can be seeded");
    }
    const user = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", args.email))
      .unique();
    if (user === null) throw new Error("No such test user");
    const existing = await ctx.db
      .query("faceProfiles")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .unique();
    if (existing) await ctx.db.delete(existing._id);
    await ctx.db.insert("faceProfiles", {
      userId: user._id,
      encryptedTemplates: args.encryptedTemplates,
      templateCount: args.templateCount,
      model: "seeded-for-test",
      updatedAt: Date.now(),
    });
  },
});

/** Removes every account the tests created (emails ending in @example.test). */
export const purgeTestUsers = internalMutation({
  args: {},
  handler: async (ctx) => {
    assertTestDeployment();
    const users = await ctx.db.query("users").collect();
    let removed = 0;
    for (const user of users) {
      if (user.email?.endsWith(TEST_EMAIL_SUFFIX)) {
        await purgeUser(ctx, user._id);
        removed += 1;
      }
    }
    return removed;
  },
});
