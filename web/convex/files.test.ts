import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import {
  MAX_URLS_PER_CALL,
  STORAGE_LIMIT_BYTES,
  UPLOAD_FORM_LIFETIME_MS,
} from "./files";
import {
  errorCode,
  newBackend,
  setTestEnv,
  signedInUser,
} from "./testHelpers.test";

type Backend = ReturnType<typeof newBackend>;
type User = Awaited<ReturnType<typeof signedInUser>>;

const bucketCalls: { method: string; url: string }[] = [];

beforeEach(() => {
  setTestEnv();
  bucketCalls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: Request | string, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      bucketCalls.push({ method: req.method, url: req.url });
      return new Response(null, { status: 200, headers: { "content-length": "5" } });
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** Puts a finished file straight into the database. */
async function addFile(
  t: Backend,
  user: User,
  name: string,
  opts: { size?: number; folderId?: Id<"folders">; contentType?: string } = {},
) {
  return await t.run((ctx) =>
    ctx.db.insert("files", {
      userId: user.userId,
      folderId: opts.folderId,
      name,
      size: opts.size ?? 10,
      contentType: opts.contentType ?? "text/plain",
      storageKey: `test/users/${user.userId}/${name}`,
      status: "ready",
      createdAt: Date.now(),
    }),
  );
}

describe("folders and listing", () => {
  test("create, nest, list with breadcrumbs, and reject duplicates and bad names", async () => {
    const t = newBackend();
    const user = await signedInUser(t, { verified: true });
    const docs = await user.as.mutation(api.files.createFolder, { name: "Docs" });
    const taxes = await user.as.mutation(api.files.createFolder, { name: " Taxes ", parentId: docs });
    await addFile(t, user, "w2.pdf", { folderId: taxes });

    const root = await user.as.query(api.files.list, {});
    expect(root.folders.map((f) => f.name)).toEqual(["Docs"]);
    const inner = await user.as.query(api.files.list, { folderId: taxes });
    expect(inner.path.map((p) => p.name)).toEqual(["Docs", "Taxes"]);
    expect(inner.files.map((f) => f.name)).toEqual(["w2.pdf"]);

    expect(await errorCode(user.as.mutation(api.files.createFolder, { name: "Docs" }))).toBe("NAME_TAKEN");
    for (const bad of ["", "   ", "a/b", "..", "x".repeat(201)]) {
      expect(await errorCode(user.as.mutation(api.files.createFolder, { name: bad }))).toBe("BAD_NAME");
    }
  });

  test("one user can never see or change another user's items", async () => {
    const t = newBackend();
    const alice = await signedInUser(t, { verified: true });
    const bob = await signedInUser(t, { verified: true });
    const folder = await alice.as.mutation(api.files.createFolder, { name: "Private" });
    const file = await addFile(t, alice, "secret.txt", { folderId: folder });

    expect(await errorCode(bob.as.query(api.files.list, { folderId: folder }))).toBe("NOT_FOUND");
    expect(await errorCode(bob.as.mutation(api.files.rename, { target: { kind: "file", id: file }, name: "x" }))).toBe("NOT_FOUND");
    expect(await errorCode(bob.as.mutation(api.files.move, { fileIds: [file], folderIds: [] }))).toBe("NOT_FOUND");
    expect(await errorCode(bob.as.mutation(api.files.remove, { fileIds: [file], folderIds: [] }))).toBe("NOT_FOUND");
    expect(await errorCode(bob.as.mutation(api.files.remove, { fileIds: [], folderIds: [folder] }))).toBe("NOT_FOUND");
    expect(await errorCode(bob.as.action(api.files.getUrls, { fileIds: [file] }))).toBe("NOT_FOUND");
    expect(await errorCode(bob.as.mutation(api.files.createFolder, { name: "x", parentId: folder }))).toBe("NOT_FOUND");
    expect((await bob.as.query(api.files.search, { text: "secret" })).files).toEqual([]);
    expect((await alice.as.query(api.files.search, { text: "SECRET" })).files).toHaveLength(1);
  });
});

describe("move, rename and delete", () => {
  test("moving renames on conflict and refuses to put a folder inside itself", async () => {
    const t = newBackend();
    const user = await signedInUser(t, { verified: true });
    const a = await user.as.mutation(api.files.createFolder, { name: "A" });
    const b = await user.as.mutation(api.files.createFolder, { name: "B", parentId: a });
    await addFile(t, user, "note.txt", { folderId: a });
    const rootNote = await addFile(t, user, "note.txt");

    await user.as.mutation(api.files.move, { fileIds: [rootNote], folderIds: [], destinationId: a });
    const names = (await user.as.query(api.files.list, { folderId: a })).files.map((f) => f.name);
    expect(names).toEqual(["note (1).txt", "note.txt"]);

    expect(await errorCode(user.as.mutation(api.files.move, { fileIds: [], folderIds: [a], destinationId: b }))).toBe("BAD_MOVE");
    expect(await errorCode(user.as.mutation(api.files.move, { fileIds: [], folderIds: [a], destinationId: a }))).toBe("BAD_MOVE");

    await user.as.mutation(api.files.move, { fileIds: [], folderIds: [b] });
    expect((await user.as.query(api.files.list, {})).folders.map((f) => f.name)).toEqual(["A", "B"]);
  });

  test("rename checks for name clashes", async () => {
    const t = newBackend();
    const user = await signedInUser(t, { verified: true });
    const one = await addFile(t, user, "one.txt");
    await addFile(t, user, "two.txt");
    expect(await errorCode(user.as.mutation(api.files.rename, { target: { kind: "file", id: one }, name: "two.txt" }))).toBe("NAME_TAKEN");
    await user.as.mutation(api.files.rename, { target: { kind: "file", id: one }, name: "uno.txt" });
    expect((await user.as.query(api.files.list, {})).files.map((f) => f.name)).toEqual(["two.txt", "uno.txt"]);
  });

  test("deleting a folder removes everything inside it, from the bucket too", async () => {
    vi.useFakeTimers();
    const t = newBackend();
    const user = await signedInUser(t, { verified: true });
    const top = await user.as.mutation(api.files.createFolder, { name: "Top" });
    const inner = await user.as.mutation(api.files.createFolder, { name: "Inner", parentId: top });
    await addFile(t, user, "a.txt", { folderId: top });
    await addFile(t, user, "b.txt", { folderId: inner });
    await addFile(t, user, "keep.txt");

    await user.as.mutation(api.files.remove, { fileIds: [], folderIds: [top] });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const root = await user.as.query(api.files.list, {});
    expect(root.folders).toEqual([]);
    expect(root.files.map((f) => f.name)).toEqual(["keep.txt"]);
    const deleted = bucketCalls.filter((c) => c.method === "DELETE").map((c) => c.url);
    expect(deleted).toHaveLength(2);
    expect(deleted.every((u) => u.startsWith("https://bucket.storage.test/test/users/"))).toBe(true);
  });
});

describe("uploads and quota", () => {
  test("an upload is reserved, signed with a size limit, then confirmed", async () => {
    const t = newBackend();
    const user = await signedInUser(t, { verified: true });
    const form = await user.as.action(api.files.requestUpload, {
      name: "holiday photo.jpg",
      size: 5,
      contentType: "image/jpeg",
    });
    expect(form.url).toBe("https://bucket.storage.test");
    // The bucket key is built from ids, never from the user's file name.
    expect(form.fields.key).toBe(`test/users/${user.userId}/${form.fileId}`);
    const policy = JSON.parse(atob(form.fields.policy));
    // Exactly the reserved size: reusing the form can never store more.
    expect(policy.conditions).toContainEqual(["content-length-range", 5, 5]);
    expect(policy.conditions).toContainEqual({ key: form.fields.key });
    expect(form.fields["x-amz-signature"]).toMatch(/^[0-9a-f]{64}$/);

    // Not listed until the bucket confirms the object exists.
    expect((await user.as.query(api.files.list, {})).files).toEqual([]);
    await user.as.action(api.files.completeUpload, { fileId: form.fileId });
    expect(bucketCalls.at(-1)).toMatchObject({ method: "HEAD" });
    const listed = (await user.as.query(api.files.list, {})).files;
    expect(listed).toMatchObject([{ name: "holiday photo.jpg", size: 5, contentType: "image/jpeg" }]);

    const urls = await user.as.action(api.files.getUrls, { fileIds: [form.fileId], download: true });
    const link = new URL(urls[form.fileId]);
    expect(link.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    expect(link.searchParams.get("response-content-disposition")).toContain("holiday%20photo.jpg");
  });

  test("an upload that never reached the bucket keeps its quota until the form expires", async () => {
    vi.useFakeTimers();
    const t = newBackend();
    const user = await signedInUser(t, { verified: true });
    await addFile(t, user, "big.bin", { size: STORAGE_LIMIT_BYTES - 100 });
    const form = await user.as.action(api.files.requestUpload, { name: "ghost.bin", size: 80, contentType: "" });

    // "Completing" before uploading anything must not free the reservation:
    // the signed form is still valid and could be used afterwards.
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));
    expect(await errorCode(user.as.action(api.files.completeUpload, { fileId: form.fileId }))).toBe("UPLOAD_MISSING");
    expect((await t.run((ctx) => ctx.db.get(form.fileId)))?.status).toBe("pending");
    expect(
      await errorCode(user.as.action(api.files.requestUpload, { name: "more.bin", size: 80, contentType: "" })),
    ).toBe("QUOTA_EXCEEDED");

    // Once the form can no longer be used, the reservation and the key go.
    const deletes: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: Request) => {
        deletes.push(`${input.method} ${input.url}`);
        return new Response(null, { status: 204 });
      }),
    );
    vi.setSystemTime(Date.now() + UPLOAD_FORM_LIFETIME_MS + 1000);
    await t.mutation(internal.files.cleanupPending, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await t.run((ctx) => ctx.db.get(form.fileId))).toBeNull();
    expect(deletes).toEqual([`DELETE https://bucket.storage.test/${form.fields.key}`]);
    await user.as.action(api.files.requestUpload, { name: "more.bin", size: 80, contentType: "" });
  });

  test("an object that is not the announced size is refused and removed", async () => {
    const t = newBackend();
    const user = await signedInUser(t, { verified: true });
    const form = await user.as.action(api.files.requestUpload, { name: "claimed.bin", size: 3, contentType: "" });
    // The bucket (stubbed above) reports 5 bytes, not the 3 that were reserved.
    expect(await errorCode(user.as.action(api.files.completeUpload, { fileId: form.fileId }))).toBe("UPLOAD_SIZE_MISMATCH");
    expect(bucketCalls.at(-1)).toMatchObject({ method: "DELETE" });
    expect((await user.as.query(api.files.list, {})).files).toEqual([]);
  });

  test("deleting a fresh upload does not free quota while its form still works", async () => {
    vi.useFakeTimers();
    const t = newBackend();
    const user = await signedInUser(t, { verified: true });
    await addFile(t, user, "big.bin", { size: STORAGE_LIMIT_BYTES - 100 });
    const form = await user.as.action(api.files.requestUpload, { name: "five.bin", size: 5, contentType: "" });
    await user.as.action(api.files.completeUpload, { fileId: form.fileId });

    await user.as.mutation(api.files.remove, { fileIds: [form.fileId], folderIds: [] });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    // Gone from the vault, and the object was deleted from the bucket...
    expect((await user.as.query(api.files.list, {})).files.map((f) => f.name)).toEqual(["big.bin"]);
    expect(bucketCalls.filter((c) => c.method === "DELETE")).toHaveLength(1);
    expect(await errorCode(user.as.action(api.files.getUrls, { fileIds: [form.fileId] }))).toBe("NOT_FOUND");
    // ...but its 5 bytes stay reserved, so the form cannot be replayed for free space.
    expect((await user.as.query(api.files.usage, {})).reserved).toBe(5);
    expect(
      await errorCode(user.as.action(api.files.requestUpload, { name: "again.bin", size: 100, contentType: "" })),
    ).toBe("QUOTA_EXCEEDED");
    // The name is free again straight away.
    const same = await user.as.action(api.files.requestUpload, { name: "five.bin", size: 5, contentType: "" });
    expect(same.name).toBe("five.bin");

    // After the form expires the key is deleted once more and the quota returns.
    vi.setSystemTime(Date.now() + UPLOAD_FORM_LIFETIME_MS + 1000);
    await t.mutation(internal.files.cleanupPending, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await t.run((ctx) => ctx.db.get(form.fileId))).toBeNull();
    expect(
      bucketCalls.filter((c) => c.method === "DELETE" && c.url.endsWith(form.fields.key)),
    ).toHaveLength(2);
    await user.as.action(api.files.requestUpload, { name: "again.bin", size: 100, contentType: "" });
  });

  test("link requests are capped, and the cap is what the vault page batches by", async () => {
    const t = newBackend();
    const user = await signedInUser(t, { verified: true });
    const id = await addFile(t, user, "a.txt");
    const tooMany = Array.from({ length: MAX_URLS_PER_CALL + 1 }, () => id);
    expect(await errorCode(user.as.action(api.files.getUrls, { fileIds: tooMany }))).toBe("TOO_MANY");
    const atLimit = Array.from({ length: MAX_URLS_PER_CALL }, () => id);
    expect(Object.keys(await user.as.action(api.files.getUrls, { fileIds: atLimit }))).toEqual([id]);
    expect(MAX_URLS_PER_CALL).toBe(200);
  });

  test("the storage limit counts finished and in-progress uploads", async () => {
    const t = newBackend();
    const user = await signedInUser(t, { verified: true });
    await addFile(t, user, "big.bin", { size: STORAGE_LIMIT_BYTES - 100 });
    const request = (size: number, name = "more.bin") =>
      user.as.action(api.files.requestUpload, { name, size, contentType: "application/octet-stream" });

    expect(await errorCode(request(101))).toBe("QUOTA_EXCEEDED");
    await request(60);
    expect(await errorCode(request(60, "again.bin"))).toBe("QUOTA_EXCEEDED");
    expect(await errorCode(request(-1))).toBe("BAD_SIZE");
    expect(await errorCode(request(1.5))).toBe("BAD_SIZE");

    // The meter shows the 60 bytes still held by the unfinished upload.
    const usage = await user.as.query(api.files.usage, {});
    expect(usage).toMatchObject({
      used: STORAGE_LIMIT_BYTES - 100,
      reserved: 60,
      limit: STORAGE_LIMIT_BYTES,
      fileCount: 1,
    });
  });

  test("duplicate upload names get a numbered suffix", async () => {
    const t = newBackend();
    const user = await signedInUser(t, { verified: true });
    await addFile(t, user, "report.pdf");
    const form = await user.as.action(api.files.requestUpload, { name: "report.pdf", size: 1, contentType: "application/pdf" });
    expect(form.name).toBe("report (1).pdf");
  });

  test("stale unfinished uploads are cleaned up", async () => {
    vi.useFakeTimers();
    const t = newBackend();
    const user = await signedInUser(t, { verified: true });
    const form = await user.as.action(api.files.requestUpload, { name: "slow.bin", size: 5, contentType: "" });
    await t.run((ctx) => ctx.db.patch(form.fileId, { createdAt: Date.now() - UPLOAD_FORM_LIFETIME_MS - 1000 }));
    await t.mutation(internal.files.cleanupPending, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await t.run((ctx) => ctx.db.get(form.fileId))).toBeNull();
    expect(bucketCalls.some((c) => c.method === "DELETE")).toBe(true);
  });
});

describe("account deletion", () => {
  test("removes files, folders, face data and logins for that user only", async () => {
    vi.useFakeTimers();
    const t = newBackend();
    const user = await signedInUser(t, { verified: true });
    const other = await signedInUser(t, { verified: true });
    await user.as.mutation(api.files.createFolder, { name: "F" });
    await addFile(t, user, "a.txt");
    await addFile(t, other, "theirs.txt");

    await user.as.mutation(api.users.deleteAccount, { confirm: "DELETE" });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const left = await t.run(async (ctx) => ({
      users: (await ctx.db.query("users").collect()).map((u) => u._id),
      files: (await ctx.db.query("files").collect()).map((f) => f.name),
      folders: await ctx.db.query("folders").collect(),
      faceSessions: (await ctx.db.query("faceSessions").collect()).map((s) => s.userId),
      sessions: (await ctx.db.query("authSessions").collect()).map((s) => s.userId),
    }));
    expect(left.users).toEqual([other.userId]);
    expect(left.files).toEqual(["theirs.txt"]);
    expect(left.folders).toEqual([]);
    expect(left.faceSessions).toEqual([other.userId]);
    expect(left.sessions).toEqual([other.userId]);
    // The one object is deleted at once, and once more after its upload
    // form can no longer be used, in case it is used after the account is gone.
    const deletes = () => bucketCalls.filter((c) => c.method === "DELETE").map((c) => c.url);
    expect(deletes()).toHaveLength(1);
    expect(await t.run((ctx) => ctx.db.query("objectDeletes").collect())).toHaveLength(1);
    vi.setSystemTime(Date.now() + UPLOAD_FORM_LIFETIME_MS + 1000);
    await t.action(internal.files.processDeletes, {});
    expect(deletes()).toHaveLength(2);
    expect(new Set(deletes()).size).toBe(1);
    expect(await t.run((ctx) => ctx.db.query("objectDeletes").collect())).toEqual([]);
  });
});

describe("bucket delete queue", () => {
  test("a failed delete stays queued and is retried, without holding up other keys", async () => {
    vi.useFakeTimers();
    const t = newBackend();
    const user = await signedInUser(t, { verified: true });
    await addFile(t, user, "a.txt");
    await addFile(t, user, "b.txt");
    await addFile(t, user, "c.txt");

    // The bucket refuses to delete b.txt; the other two go through.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: Request) => {
        bucketCalls.push({ method: input.method, url: input.url });
        const fail = input.url.endsWith("/b.txt");
        return new Response(null, { status: fail ? 500 : 204 });
      }),
    );
    const all = (await user.as.query(api.files.list, {})).files.map((f) => f._id);
    await user.as.mutation(api.files.remove, { fileIds: all, folderIds: [] });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const tried = new Set(bucketCalls.filter((c) => c.method === "DELETE").map((c) => c.url.split("/").pop()));
    expect(tried).toEqual(new Set(["a.txt", "b.txt", "c.txt"]));
    const queued = await t.run((ctx) => ctx.db.query("objectDeletes").collect());
    expect(queued.map((q) => q.storageKey.split("/").pop())).toEqual(["b.txt"]);

    // Not retried straight away, so a key that keeps failing is not hammered...
    bucketCalls.length = 0;
    await t.action(internal.files.processDeletes, {});
    expect(bucketCalls).toEqual([]);

    // ...but a later run (the timer) deletes it once the bucket works again.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: Request) => {
        bucketCalls.push({ method: input.method, url: input.url });
        return new Response(null, { status: 204 });
      }),
    );
    vi.setSystemTime(Date.now() + 11 * 60 * 1000);
    await t.action(internal.files.processDeletes, {});
    expect(bucketCalls.map((c) => c.url.split("/").pop())).toEqual(["b.txt"]);
    expect(await t.run((ctx) => ctx.db.query("objectDeletes").collect())).toEqual([]);
  });
});
