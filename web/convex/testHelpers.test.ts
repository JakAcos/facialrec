import { convexTest } from "convex-test";
import { test } from "vitest";
import { Id } from "./_generated/dataModel";
import { FACE_SESSION_MS } from "./face";
import schema from "./schema";
import { modules } from "./test.setup";

export function setTestEnv() {
  process.env.FACE_SERVICE_URL = "https://face.test";
  process.env.FACE_SERVICE_SECRET = "shared-secret";
  // 32 zero bytes, base64. Only ever used inside these tests.
  process.env.FACE_ENC_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
  process.env.S3_ENDPOINT = "https://storage.test";
  process.env.S3_BUCKET = "bucket";
  process.env.S3_ACCESS_KEY_ID = "AKIATEST";
  process.env.S3_SECRET_ACCESS_KEY = "secret";
  process.env.S3_KEY_PREFIX = "test/";
}

export function newBackend() {
  return convexTest(schema, modules);
}

type Backend = ReturnType<typeof newBackend>;

/** Creates a user with one login session, optionally already face verified. */
export async function signedInUser(
  t: Backend,
  opts: { verified?: boolean; userId?: Id<"users"> } = {},
) {
  const { userId, sessionId } = await t.run(async (ctx) => {
    const userId = opts.userId ?? (await ctx.db.insert("users", {}));
    const sessionId = await ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 1e9,
    });
    if (opts.verified) {
      await ctx.db.insert("faceSessions", {
        sessionId,
        userId,
        verifiedAt: Date.now(),
        expiresAt: Date.now() + FACE_SESSION_MS,
      });
    }
    return { userId, sessionId };
  });
  return {
    userId,
    sessionId,
    as: t.withIdentity({ subject: `${userId}|${sessionId}` }),
  };
}

/** Reads the `code` out of a ConvexError thrown by a function call. */
export async function errorCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (e) {
    const data = (e as { data?: unknown }).data;
    const parsed = typeof data === "string" ? JSON.parse(data) : data;
    return (parsed as { code?: string })?.code ?? `threw: ${String(e)}`;
  }
  return "did not throw";
}

test("helpers load", () => {});
