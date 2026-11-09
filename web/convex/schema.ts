import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const challengeStep = v.union(
  v.literal("center"),
  v.literal("left"),
  v.literal("right"),
);

export default defineSchema({
  ...authTables,

  // One row per user. The face embeddings are AES-GCM encrypted before they
  // are written, so a database export alone does not reveal biometric data.
  faceProfiles: defineTable({
    userId: v.id("users"),
    encryptedTemplates: v.bytes(),
    templateCount: v.number(),
    model: v.string(),
    updatedAt: v.number(),
  }).index("by_user", ["userId"]),

  // A login session only unlocks the vault after its face check passes.
  faceSessions: defineTable({
    sessionId: v.id("authSessions"),
    userId: v.id("users"),
    verifiedAt: v.number(),
    expiresAt: v.number(),
  })
    .index("by_session", ["sessionId"])
    .index("by_user", ["userId"]),

  // Server-issued liveness challenge: which poses the camera must capture.
  faceChallenges: defineTable({
    userId: v.id("users"),
    sessionId: v.id("authSessions"),
    kind: v.union(v.literal("enroll"), v.literal("verify")),
    steps: v.array(challengeStep),
    expiresAt: v.number(),
    used: v.boolean(),
  }).index("by_user", ["userId"]),

  // Audit trail, also used to lock out repeated failed attempts.
  faceAttempts: defineTable({
    userId: v.id("users"),
    kind: v.union(v.literal("enroll"), v.literal("verify")),
    success: v.boolean(),
    reason: v.optional(v.string()),
    at: v.number(),
  }).index("by_user_at", ["userId", "at"]),

  folders: defineTable({
    userId: v.id("users"),
    name: v.string(),
    parentId: v.optional(v.id("folders")),
  }).index("by_user_parent", ["userId", "parentId"]),

  files: defineTable({
    userId: v.id("users"),
    folderId: v.optional(v.id("folders")),
    name: v.string(),
    size: v.number(),
    contentType: v.string(),
    storageKey: v.string(),
    // pending: upload reserved, not confirmed yet.
    // ready:   confirmed in the bucket and visible in the vault.
    // deleted: removed by the user while its upload form could still be
    //          reused. It keeps holding its quota until that form expires.
    status: v.union(
      v.literal("pending"),
      v.literal("ready"),
      v.literal("deleted"),
    ),
    createdAt: v.number(),
  })
    .index("by_user_folder", ["userId", "folderId"])
    .index("by_user", ["userId"])
    .index("by_status", ["status", "createdAt"]),
});
