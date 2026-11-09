import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { MAX_FAILED_VERIFIES } from "./face";
import {
  errorCode,
  newBackend,
  setTestEnv,
  signedInUser,
} from "./testHelpers.test";

function embedding(identity: number, similarity = 1): number[] {
  const v = new Array(512).fill(0);
  v[identity] = similarity;
  v[identity + 100] = Math.sqrt(1 - similarity * similarity);
  return v;
}

type Pose = "center" | "left" | "right";
const YAW: Record<Pose, number> = { center: 0, left: 0.4, right: -0.4 };

function serviceFrame(pose: Pose, identity: number) {
  return {
    face_count: 1,
    det_score: 0.9,
    face_size: 170,
    yaw: YAW[pose],
    pitch: 0.48,
    live_score: 0.99,
    embedding: embedding(identity, pose === "center" ? 1 : 0.8),
  };
}

/** Stands in for the face service: answers with whatever frames the test queues. */
let nextFrames: ReturnType<typeof serviceFrame>[] = [];
const fetchMock = vi.fn(async () =>
  Response.json({ model: "test-model", frames: nextFrames }),
);

const jpeg = () => new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer;

beforeEach(() => {
  setTestEnv();
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

type User = Awaited<ReturnType<typeof signedInUser>>;

/** Runs one whole face check as `person` (the face in front of the camera). */
async function faceCheck(user: User, person: number, reenroll = false) {
  const challenge = await user.as.mutation(api.face.startChallenge, { reenroll });
  nextFrames = challenge.steps.map((s) => serviceFrame(s, person));
  const result = await user.as.action(api.face.submit, {
    challengeId: challenge.challengeId,
    frames: challenge.steps.map(jpeg),
  });
  return { challenge, result };
}

describe("face enrollment and verification", () => {
  test("a signed-in but unverified session cannot touch files", async () => {
    const t = newBackend();
    const user = await signedInUser(t);
    expect(await errorCode(user.as.query(api.files.list, {}))).toBe("FACE_NOT_VERIFIED");
    expect(await errorCode(user.as.mutation(api.files.createFolder, { name: "x" }))).toBe("FACE_NOT_VERIFIED");
    expect(
      await errorCode(
        user.as.action(api.files.requestUpload, { name: "a.txt", size: 1, contentType: "text/plain" }),
      ),
    ).toBe("FACE_NOT_VERIFIED");
  });

  test("signed-out callers get nothing", async () => {
    const t = newBackend();
    expect(await t.query(api.face.status, {})).toBeNull();
    expect(await errorCode(t.query(api.files.list, {}))).toBe("UNAUTHENTICATED");
    expect(await errorCode(t.mutation(api.face.startChallenge, {}))).toBe("UNAUTHENTICATED");
  });

  test("first check enrolls three poses, encrypts them and unlocks the session", async () => {
    const t = newBackend();
    const user = await signedInUser(t);

    const { challenge, result } = await faceCheck(user, 0);
    expect(challenge.kind).toBe("enroll");
    expect(challenge.steps).toEqual(["center", "left", "right"]);
    expect(result).toEqual({ ok: true, kind: "enroll" });

    const status = await user.as.query(api.face.status, {});
    expect(status).toMatchObject({ enrolled: true, verified: true });
    expect((await user.as.query(api.files.list, {})).files).toEqual([]);

    // The face service was called server-to-server with the shared secret.
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://face.test/analyze");
    expect((init.headers as Record<string, string>)["x-face-secret"]).toBe("shared-secret");

    // Stored templates are ciphertext: the raw embedding bytes do not appear.
    const profile = await t.run((ctx) => ctx.db.query("faceProfiles").unique());
    expect(profile!.templateCount).toBe(3);
    const stored = new Uint8Array(profile!.encryptedTemplates);
    const raw = new Uint8Array(new Float32Array(embedding(0)).buffer);
    expect(stored.byteLength).toBe(12 + 3 * 512 * 4 + 16);
    const window = Array.from(raw.slice(0, 16)).join(",");
    expect(Array.from(stored).join(",")).not.toContain(window);
  });

  test("a new login session starts locked and unlocks only for the enrolled face", async () => {
    const t = newBackend();
    const first = await signedInUser(t);
    await faceCheck(first, 0);

    const second = await signedInUser(t, { userId: first.userId });
    expect(await second.as.query(api.face.status, {})).toMatchObject({ enrolled: true, verified: false });
    expect(await errorCode(second.as.query(api.files.list, {}))).toBe("FACE_NOT_VERIFIED");

    const { challenge, result } = await faceCheck(second, 0);
    expect(challenge.kind).toBe("verify");
    expect(challenge.steps).toHaveLength(2);
    expect(challenge.steps[0]).toBe("center");
    expect(result.ok).toBe(true);
    expect(await second.as.query(api.face.status, {})).toMatchObject({ verified: true });
  });

  test("a different person is rejected and the vault stays locked", async () => {
    const t = newBackend();
    const owner = await signedInUser(t);
    await faceCheck(owner, 0);

    const thief = await signedInUser(t, { userId: owner.userId });
    const { result } = await faceCheck(thief, 7);
    expect(result).toMatchObject({ ok: false, kind: "verify", reason: "NO_MATCH" });
    expect(await errorCode(thief.as.query(api.files.list, {}))).toBe("FACE_NOT_VERIFIED");
  });

  test("a static photo of the owner is rejected: it cannot turn its head", async () => {
    const t = newBackend();
    const owner = await signedInUser(t);
    await faceCheck(owner, 0);

    const attacker = await signedInUser(t, { userId: owner.userId });
    const challenge = await attacker.as.mutation(api.face.startChallenge, {});
    nextFrames = challenge.steps.map(() => serviceFrame("center", 0));
    const result = await attacker.as.action(api.face.submit, {
      challengeId: challenge.challengeId,
      frames: challenge.steps.map(jpeg),
    });
    expect(result).toMatchObject({ ok: false, reason: "POSE_MISMATCH" });
    expect(await attacker.as.query(api.face.status, {})).toMatchObject({ verified: false });
  });

  test("a challenge works once, and only for the session that asked for it", async () => {
    const t = newBackend();
    const user = await signedInUser(t);
    const { challenge } = await faceCheck(user, 0);
    expect(
      await errorCode(
        user.as.action(api.face.submit, { challengeId: challenge.challengeId, frames: [jpeg(), jpeg(), jpeg()] }),
      ),
    ).toBe("CHALLENGE_EXPIRED");

    const other = await signedInUser(t);
    const mine = await user.as.mutation(api.face.startChallenge, {});
    expect(
      await errorCode(
        other.as.action(api.face.submit, { challengeId: mine.challengeId, frames: [jpeg(), jpeg()] }),
      ),
    ).toBe("CHALLENGE_EXPIRED");
  });

  test("an expired challenge is refused", async () => {
    const t = newBackend();
    const user = await signedInUser(t);
    const challenge = await user.as.mutation(api.face.startChallenge, {});
    await t.run((ctx) => ctx.db.patch(challenge.challengeId, { expiresAt: Date.now() - 1 }));
    expect(
      await errorCode(
        user.as.action(api.face.submit, { challengeId: challenge.challengeId, frames: [jpeg(), jpeg(), jpeg()] }),
      ),
    ).toBe("CHALLENGE_EXPIRED");
  });

  test("repeated failures lock the account, even for the real owner", async () => {
    const t = newBackend();
    const owner = await signedInUser(t);
    await faceCheck(owner, 0);
    const session = await signedInUser(t, { userId: owner.userId });
    for (let i = 0; i < MAX_FAILED_VERIFIES; i++) {
      expect((await faceCheck(session, 7)).result.ok).toBe(false);
    }
    expect(await errorCode(session.as.mutation(api.face.startChallenge, {}))).toBe("LOCKED");
    const status = await session.as.query(api.face.status, {});
    expect(status!.lockedUntil).toBeGreaterThan(Date.now());
  });

  test("the face cannot be replaced from a locked session", async () => {
    const t = newBackend();
    const owner = await signedInUser(t);
    await faceCheck(owner, 0);

    const thief = await signedInUser(t, { userId: owner.userId });
    expect(await errorCode(thief.as.mutation(api.face.startChallenge, { reenroll: true }))).toBe("FACE_NOT_VERIFIED");

    // The verified owner can re-enroll, and the new face then replaces the old.
    const { challenge, result } = await faceCheck(owner, 3, true);
    expect(challenge.kind).toBe("enroll");
    expect(result.ok).toBe(true);
    const next = await signedInUser(t, { userId: owner.userId });
    expect((await faceCheck(next, 0)).result.ok).toBe(false);
    expect((await faceCheck(next, 3)).result.ok).toBe(true);
  });

  test("an enrollment challenge issued before a face existed cannot overwrite it later", async () => {
    const t = newBackend();
    const owner = await signedInUser(t);
    const thief = await signedInUser(t, { userId: owner.userId });

    // Both sessions ask to enroll while the account has no face yet.
    const stale = await thief.as.mutation(api.face.startChallenge, {});
    expect(stale.kind).toBe("enroll");
    expect((await faceCheck(owner, 0)).result.ok).toBe(true);

    // The thief's old challenge is still unexpired, but must not work now.
    nextFrames = stale.steps.map((s) => serviceFrame(s, 7));
    expect(
      await errorCode(
        thief.as.action(api.face.submit, { challengeId: stale.challengeId, frames: stale.steps.map(jpeg) }),
      ),
    ).toBe("FACE_NOT_VERIFIED");
    expect(await thief.as.query(api.face.status, {})).toMatchObject({ verified: false });
    const next = await signedInUser(t, { userId: owner.userId });
    expect((await faceCheck(next, 0)).result.ok).toBe(true);
  });

  test("two enrollments racing each other: only the first one is kept", async () => {
    const t = newBackend();
    const a = await signedInUser(t);
    const b = await signedInUser(t, { userId: a.userId });
    const ca = await a.as.mutation(api.face.startChallenge, {});
    const cb = await b.as.mutation(api.face.startChallenge, {});
    // Both pass the start-of-attempt checks before either has finished.
    const begin = (u: typeof a, challengeId: typeof ca.challengeId) =>
      t.mutation(internal.face.beginAttempt, { challengeId, userId: u.userId, sessionId: u.sessionId });
    const [attemptA, attemptB] = [await begin(a, ca.challengeId), await begin(b, cb.challengeId)];
    const profile = { encryptedTemplates: new ArrayBuffer(8), templateCount: 3, model: "m" };
    const finish = (u: typeof a, attempt: typeof attemptA) =>
      t.mutation(internal.face.finishAttempt, {
        attemptId: attempt.attemptId,
        userId: u.userId,
        sessionId: u.sessionId,
        kind: "enroll",
        outcome: "success",
        profileUpdatedAt: attempt.profileUpdatedAt,
        newProfile: profile,
      });
    expect(await finish(a, attemptA)).toBe(true);
    expect(await finish(b, attemptB)).toBe(false);
    expect(await a.as.query(api.face.status, {})).toMatchObject({ enrolled: true, verified: true });
    expect(await b.as.query(api.face.status, {})).toMatchObject({ enrolled: true, verified: false });
  });

  test("a replacement challenge stops working once its session is locked", async () => {
    const t = newBackend();
    const owner = await signedInUser(t);
    await faceCheck(owner, 0);
    const challenge = await owner.as.mutation(api.face.startChallenge, { reenroll: true });
    await owner.as.mutation(api.face.lock, {});
    nextFrames = challenge.steps.map((s) => serviceFrame(s, 7));
    expect(
      await errorCode(
        owner.as.action(api.face.submit, { challengeId: challenge.challengeId, frames: challenge.steps.map(jpeg) }),
      ),
    ).toBe("FACE_NOT_VERIFIED");
    const next = await signedInUser(t, { userId: owner.userId });
    expect((await faceCheck(next, 0)).result.ok).toBe(true);
  });

  test("attempts sent at the same time cannot exceed the limit", async () => {
    const t = newBackend();
    const owner = await signedInUser(t);
    await faceCheck(owner, 0);
    const session = await signedInUser(t, { userId: owner.userId });
    const ids: Id<"faceChallenges">[] = [];
    for (let i = 0; i < MAX_FAILED_VERIFIES + 1; i++) {
      ids.push((await session.as.mutation(api.face.startChallenge, {})).challengeId);
    }
    // Start them all before any has an answer from the face service.
    const begin = (challengeId: Id<"faceChallenges">) =>
      t.mutation(internal.face.beginAttempt, {
        challengeId,
        userId: session.userId,
        sessionId: session.sessionId,
      });
    for (const id of ids.slice(0, MAX_FAILED_VERIFIES)) await begin(id);
    expect(await errorCode(begin(ids[MAX_FAILED_VERIFIES]))).toBe("LOCKED");
  });

  test("unreadable frames count as failed attempts", async () => {
    const t = newBackend();
    const owner = await signedInUser(t);
    await faceCheck(owner, 0);
    const session = await signedInUser(t, { userId: owner.userId });
    fetchMock.mockImplementation(async () => new Response("bad image", { status: 400 }));
    for (let i = 0; i < MAX_FAILED_VERIFIES; i++) {
      const challenge = await session.as.mutation(api.face.startChallenge, {});
      const result = await session.as.action(api.face.submit, {
        challengeId: challenge.challengeId,
        frames: challenge.steps.map(jpeg),
      });
      expect(result).toMatchObject({ ok: false, reason: "BAD_IMAGE" });
    }
    expect(await errorCode(session.as.mutation(api.face.startChallenge, {}))).toBe("LOCKED");
  });

  test("a face service outage does not use up attempts", async () => {
    const t = newBackend();
    const owner = await signedInUser(t);
    await faceCheck(owner, 0);
    const session = await signedInUser(t, { userId: owner.userId });
    fetchMock.mockImplementation(async () => new Response("down", { status: 503 }));
    for (let i = 0; i < MAX_FAILED_VERIFIES + 2; i++) {
      const challenge = await session.as.mutation(api.face.startChallenge, {});
      expect(
        await errorCode(
          session.as.action(api.face.submit, { challengeId: challenge.challengeId, frames: challenge.steps.map(jpeg) }),
        ),
      ).toBe("FACE_SERVICE_UNAVAILABLE");
    }
    fetchMock.mockImplementation(async () => Response.json({ model: "test-model", frames: nextFrames }));
    expect((await faceCheck(session, 0)).result.ok).toBe(true);
  });

  test("locking the vault and an expired face session both block access", async () => {
    const t = newBackend();
    const user = await signedInUser(t, { verified: true });
    await user.as.query(api.files.list, {});
    await user.as.mutation(api.face.lock, {});
    expect(await errorCode(user.as.query(api.files.list, {}))).toBe("FACE_NOT_VERIFIED");

    const stale = await signedInUser(t, { verified: true });
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("faceSessions")
        .withIndex("by_session", (q) => q.eq("sessionId", stale.sessionId))
        .unique();
      await ctx.db.patch(row!._id, { expiresAt: Date.now() - 1 });
    });
    expect(await errorCode(stale.as.query(api.files.list, {}))).toBe("FACE_NOT_VERIFIED");
  });

  test("after sign-out, a copied login token no longer opens the vault", async () => {
    const t = newBackend();
    const user = await signedInUser(t, { verified: true });
    await user.as.query(api.files.list, {});
    // Signing out deletes the login session. The token itself (what
    // `user.as` stands for) would still be accepted for a while.
    await t.run((ctx) => ctx.db.delete(user.sessionId));
    expect(await errorCode(user.as.query(api.files.list, {}))).toBe("FACE_NOT_VERIFIED");
    expect(await user.as.query(api.face.status, {})).toMatchObject({ verified: false });
  });

  test("a wrong frame count fails without calling the face service", async () => {
    const t = newBackend();
    const user = await signedInUser(t);
    const challenge = await user.as.mutation(api.face.startChallenge, {});
    const result = await user.as.action(api.face.submit, {
      challengeId: challenge.challengeId,
      frames: [jpeg()],
    });
    expect(result).toMatchObject({ ok: false, reason: "WRONG_FRAME_COUNT" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
