import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  MutationCtx,
  query,
  QueryCtx,
} from "./_generated/server";
import {
  assertFaceVerified,
  requireIdentity,
  requireVerified,
} from "./lib/access";
import { deleteObject, headObject, presignGet, presignPost } from "./lib/s3";

/** Storage allowance per account. */
export const STORAGE_LIMIT_BYTES = 100 * 1024 * 1024;
const MAX_NAME_LENGTH = 200;
const UPLOAD_URL_SECONDS = 15 * 60;
const VIEW_URL_SECONDS = 60 * 60;
const PENDING_UPLOAD_TTL_MS = 60 * 60 * 1000;

function cleanName(raw: string): string {
  const name = raw.trim();
  if (
    name.length === 0 ||
    name.length > MAX_NAME_LENGTH ||
    /[\\/\u0000-\u001f]/.test(name) ||
    name === "." ||
    name === ".."
  ) {
    throw new ConvexError({
      code: "BAD_NAME",
      message: "Names cannot be empty or contain slashes.",
    });
  }
  return name;
}

async function ownedFolder(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
  folderId: Id<"folders">,
): Promise<Doc<"folders">> {
  const folder = await ctx.db.get(folderId);
  if (folder === null || folder.userId !== userId) {
    throw new ConvexError({ code: "NOT_FOUND", message: "Folder not found." });
  }
  return folder;
}

async function ownedFile(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
  fileId: Id<"files">,
): Promise<Doc<"files">> {
  const file = await ctx.db.get(fileId);
  if (file === null || file.userId !== userId) {
    throw new ConvexError({ code: "NOT_FOUND", message: "File not found." });
  }
  return file;
}

async function usedBytes(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
): Promise<number> {
  const files = await ctx.db
    .query("files")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  return files.reduce((sum, f) => sum + f.size, 0);
}

function siblings(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
  folderId: Id<"folders"> | undefined,
) {
  return {
    folders: () =>
      ctx.db
        .query("folders")
        .withIndex("by_user_parent", (q) =>
          q.eq("userId", userId).eq("parentId", folderId),
        )
        .collect(),
    files: () =>
      ctx.db
        .query("files")
        .withIndex("by_user_folder", (q) =>
          q.eq("userId", userId).eq("folderId", folderId),
        )
        .collect(),
  };
}

/** "photo.jpg" becomes "photo (1).jpg" when the name is already taken. */
function uniqueName(name: string, taken: Set<string>): string {
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let i = 1; ; i++) {
    const candidate = `${base} (${i})${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
}

function publicFile(f: Doc<"files">) {
  return {
    _id: f._id,
    name: f.name,
    size: f.size,
    contentType: f.contentType,
    createdAt: f.createdAt,
    folderId: f.folderId ?? null,
  };
}

/** Contents of one folder (or the root), plus the breadcrumb trail to it. */
export const list = query({
  args: { folderId: v.optional(v.id("folders")) },
  handler: async (ctx, args) => {
    const { userId } = await requireVerified(ctx);
    const path: { _id: Id<"folders">; name: string }[] = [];
    let cursor = args.folderId;
    while (cursor) {
      const folder = await ownedFolder(ctx, userId, cursor);
      path.unshift({ _id: folder._id, name: folder.name });
      cursor = folder.parentId;
    }
    const here = siblings(ctx, userId, args.folderId);
    const folders = await here.folders();
    const files = (await here.files()).filter((f) => f.status === "ready");
    return {
      path,
      folders: folders
        .map((f) => ({ _id: f._id, name: f.name, createdAt: f._creationTime }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      files: files.map(publicFile).sort((a, b) => a.name.localeCompare(b.name)),
    };
  },
});

/** Finds files and folders by name across the whole vault. */
export const search = query({
  args: { text: v.string() },
  handler: async (ctx, args) => {
    const { userId } = await requireVerified(ctx);
    const needle = args.text.trim().toLowerCase();
    if (needle.length === 0) return { folders: [], files: [] };
    const files = await ctx.db
      .query("files")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    const folders = await ctx.db
      .query("folders")
      .withIndex("by_user_parent", (q) => q.eq("userId", userId))
      .collect();
    return {
      folders: folders
        .filter((f) => f.name.toLowerCase().includes(needle))
        .map((f) => ({ _id: f._id, name: f.name, createdAt: f._creationTime })),
      files: files
        .filter(
          (f) => f.status === "ready" && f.name.toLowerCase().includes(needle),
        )
        .map(publicFile),
    };
  },
});

/** Every folder the user owns, for the "move to" picker. */
export const folderTree = query({
  args: {},
  handler: async (ctx) => {
    const { userId } = await requireVerified(ctx);
    const folders = await ctx.db
      .query("folders")
      .withIndex("by_user_parent", (q) => q.eq("userId", userId))
      .collect();
    return folders.map((f) => ({
      _id: f._id,
      name: f.name,
      parentId: f.parentId ?? null,
    }));
  },
});

function category(contentType: string): string {
  if (contentType.startsWith("image/")) return "Images";
  if (contentType.startsWith("video/")) return "Videos";
  if (contentType.startsWith("audio/")) return "Audio";
  if (
    contentType === "application/pdf" ||
    contentType.startsWith("text/") ||
    contentType.includes("document") ||
    contentType.includes("sheet") ||
    contentType.includes("presentation")
  ) {
    return "Documents";
  }
  return "Other";
}

/** Storage used, the limit, and a breakdown by kind of file. */
export const usage = query({
  args: {},
  handler: async (ctx) => {
    const { userId } = await requireVerified(ctx);
    const files = (
      await ctx.db
        .query("files")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .collect()
    ).filter((f) => f.status === "ready");
    const byKind = new Map<string, { bytes: number; count: number }>();
    for (const f of files) {
      const kind = category(f.contentType);
      const entry = byKind.get(kind) ?? { bytes: 0, count: 0 };
      entry.bytes += f.size;
      entry.count += 1;
      byKind.set(kind, entry);
    }
    return {
      used: files.reduce((sum, f) => sum + f.size, 0),
      limit: STORAGE_LIMIT_BYTES,
      fileCount: files.length,
      byKind: [...byKind.entries()]
        .map(([kind, e]) => ({ kind, ...e }))
        .sort((a, b) => b.bytes - a.bytes),
    };
  },
});

export const createFolder = mutation({
  args: { name: v.string(), parentId: v.optional(v.id("folders")) },
  handler: async (ctx, args) => {
    const { userId } = await requireVerified(ctx);
    const name = cleanName(args.name);
    if (args.parentId) await ownedFolder(ctx, userId, args.parentId);
    const existing = await siblings(ctx, userId, args.parentId).folders();
    if (existing.some((f) => f.name === name)) {
      throw new ConvexError({
        code: "NAME_TAKEN",
        message: "A folder with that name already exists here.",
      });
    }
    return await ctx.db.insert("folders", {
      userId,
      name,
      parentId: args.parentId,
    });
  },
});

export const rename = mutation({
  args: {
    target: v.union(
      v.object({ kind: v.literal("file"), id: v.id("files") }),
      v.object({ kind: v.literal("folder"), id: v.id("folders") }),
    ),
    name: v.string(),
  },
  handler: async (ctx, args) => {
    const { userId } = await requireVerified(ctx);
    const name = cleanName(args.name);
    if (args.target.kind === "file") {
      const file = await ownedFile(ctx, userId, args.target.id);
      const others = await siblings(ctx, userId, file.folderId).files();
      if (others.some((f) => f._id !== file._id && f.name === name)) {
        throw new ConvexError({
          code: "NAME_TAKEN",
          message: "A file with that name already exists here.",
        });
      }
      await ctx.db.patch(file._id, { name });
    } else {
      const folder = await ownedFolder(ctx, userId, args.target.id);
      const others = await siblings(ctx, userId, folder.parentId).folders();
      if (others.some((f) => f._id !== folder._id && f.name === name)) {
        throw new ConvexError({
          code: "NAME_TAKEN",
          message: "A folder with that name already exists here.",
        });
      }
      await ctx.db.patch(folder._id, { name });
    }
  },
});

/**
 * Moves files and folders into another folder (or the root). Because the
 * bucket key does not contain the folder path, a move is only a database
 * update: no bytes are copied.
 */
export const move = mutation({
  args: {
    fileIds: v.array(v.id("files")),
    folderIds: v.array(v.id("folders")),
    destinationId: v.optional(v.id("folders")),
  },
  handler: async (ctx, args) => {
    const { userId } = await requireVerified(ctx);

    // Collect the destination and all of its ancestors, to stop a folder
    // being moved inside itself.
    const destinationChain = new Set<Id<"folders">>();
    let cursor = args.destinationId;
    while (cursor) {
      const folder = await ownedFolder(ctx, userId, cursor);
      destinationChain.add(folder._id);
      cursor = folder.parentId;
    }

    const here = siblings(ctx, userId, args.destinationId);
    const takenFolders = new Set((await here.folders()).map((f) => f.name));
    const takenFiles = new Set((await here.files()).map((f) => f.name));

    for (const folderId of args.folderIds) {
      const folder = await ownedFolder(ctx, userId, folderId);
      if (destinationChain.has(folder._id)) {
        throw new ConvexError({
          code: "BAD_MOVE",
          message: "A folder cannot be moved into itself.",
        });
      }
      if (folder.parentId === args.destinationId) continue;
      const name = uniqueName(folder.name, takenFolders);
      takenFolders.add(name);
      await ctx.db.patch(folder._id, { parentId: args.destinationId, name });
    }
    for (const fileId of args.fileIds) {
      const file = await ownedFile(ctx, userId, fileId);
      if (file.folderId === args.destinationId) continue;
      const name = uniqueName(file.name, takenFiles);
      takenFiles.add(name);
      await ctx.db.patch(file._id, { folderId: args.destinationId, name });
    }
  },
});

/** Deletes files and folders, including everything inside the folders. */
export const remove = mutation({
  args: { fileIds: v.array(v.id("files")), folderIds: v.array(v.id("folders")) },
  handler: async (ctx, args) => {
    const { userId } = await requireVerified(ctx);
    const keys: string[] = [];

    const queue: Id<"folders">[] = [];
    for (const folderId of args.folderIds) {
      await ownedFolder(ctx, userId, folderId);
      queue.push(folderId);
    }
    while (queue.length > 0) {
      const folderId = queue.pop()!;
      const inside = siblings(ctx, userId, folderId);
      for (const child of await inside.folders()) queue.push(child._id);
      for (const file of await inside.files()) {
        keys.push(file.storageKey);
        await ctx.db.delete(file._id);
      }
      await ctx.db.delete(folderId);
    }
    for (const fileId of args.fileIds) {
      const file = await ctx.db.get(fileId);
      if (file === null) continue; // already removed with its folder
      if (file.userId !== userId) {
        throw new ConvexError({ code: "NOT_FOUND", message: "File not found." });
      }
      keys.push(file.storageKey);
      await ctx.db.delete(file._id);
    }

    // The database rows are gone now; the bucket objects follow right after.
    if (keys.length > 0) {
      await ctx.scheduler.runAfter(0, internal.files.deleteObjects, { keys });
    }
  },
});

export const deleteObjects = internalAction({
  args: { keys: v.array(v.string()) },
  handler: async (_ctx, args) => {
    for (const key of args.keys) await deleteObject(key);
  },
});

/** Reserves quota and a bucket key for one upload. */
export const reserveUpload = internalMutation({
  args: {
    userId: v.id("users"),
    sessionId: v.id("authSessions"),
    name: v.string(),
    size: v.number(),
    contentType: v.string(),
    folderId: v.optional(v.id("folders")),
  },
  handler: async (ctx, args) => {
    const { userId } = args;
    await assertFaceVerified(ctx, { userId, sessionId: args.sessionId });
    const cleaned = cleanName(args.name);
    if (!Number.isInteger(args.size) || args.size < 0) {
      throw new ConvexError({ code: "BAD_SIZE", message: "Invalid file size." });
    }
    if (args.folderId) await ownedFolder(ctx, userId, args.folderId);

    const remaining = STORAGE_LIMIT_BYTES - (await usedBytes(ctx, userId));
    if (args.size > remaining) {
      throw new ConvexError({
        code: "QUOTA_EXCEEDED",
        message: "Not enough storage left for this file.",
        remaining,
      });
    }

    const taken = new Set(
      (await siblings(ctx, userId, args.folderId).files()).map((f) => f.name),
    );
    const name = uniqueName(cleaned, taken);
    const fileId = await ctx.db.insert("files", {
      userId,
      folderId: args.folderId,
      name,
      size: args.size,
      contentType: args.contentType || "application/octet-stream",
      storageKey: "",
      status: "pending",
      createdAt: Date.now(),
    });
    // The key is built from ids only, never from the user's file name.
    const prefix = process.env.S3_KEY_PREFIX ?? "";
    const storageKey = `${prefix}users/${userId}/${fileId}`;
    await ctx.db.patch(fileId, { storageKey });
    return { fileId, storageKey, name };
  },
});

/** Step 1 of an upload: get a signed form the browser can post the file to. */
export const requestUpload = action({
  args: {
    name: v.string(),
    size: v.number(),
    contentType: v.string(),
    folderId: v.optional(v.id("folders")),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    fileId: Id<"files">;
    name: string;
    url: string;
    fields: Record<string, string>;
  }> => {
    const identity = await requireIdentity(ctx);
    const contentType = args.contentType || "application/octet-stream";
    const reserved = await ctx.runMutation(internal.files.reserveUpload, {
      ...identity,
      ...args,
      contentType,
    });
    const form = await presignPost(reserved.storageKey, {
      expiresIn: UPLOAD_URL_SECONDS,
      // The bucket rejects anything larger than what was reserved.
      maxBytes: args.size,
      contentType,
    });
    return { fileId: reserved.fileId, name: reserved.name, ...form };
  },
});

export const pendingUpload = internalQuery({
  args: {
    userId: v.id("users"),
    sessionId: v.id("authSessions"),
    fileId: v.id("files"),
  },
  handler: async (ctx, args) => {
    await assertFaceVerified(ctx, args);
    return await ownedFile(ctx, args.userId, args.fileId);
  },
});

export const finalizeUpload = internalMutation({
  args: { fileId: v.id("files"), size: v.union(v.number(), v.null()) },
  handler: async (ctx, args) => {
    const file = await ctx.db.get(args.fileId);
    if (file === null) return;
    if (args.size === null) {
      await ctx.db.delete(file._id);
      return;
    }
    await ctx.db.patch(file._id, { size: args.size, status: "ready" });
  },
});

/** Step 2 of an upload: confirm the object really landed in the bucket. */
export const completeUpload = action({
  args: { fileId: v.id("files") },
  handler: async (ctx, args): Promise<{ ok: boolean }> => {
    const identity = await requireIdentity(ctx);
    const file = await ctx.runQuery(internal.files.pendingUpload, {
      ...identity,
      fileId: args.fileId,
    });
    if (file.status === "ready") return { ok: true };
    // Trust the bucket, not the browser, for the real size.
    const size = await headObject(file.storageKey);
    await ctx.runMutation(internal.files.finalizeUpload, {
      fileId: file._id,
      size,
    });
    if (size === null) {
      throw new ConvexError({
        code: "UPLOAD_MISSING",
        message: "The upload did not finish. Please try again.",
      });
    }
    return { ok: true };
  },
});

export const filesForUrls = internalQuery({
  args: {
    userId: v.id("users"),
    sessionId: v.id("authSessions"),
    fileIds: v.array(v.id("files")),
  },
  handler: async (ctx, args) => {
    await assertFaceVerified(ctx, args);
    const out = [];
    for (const fileId of args.fileIds) {
      const file = await ownedFile(ctx, args.userId, fileId);
      if (file.status === "ready") out.push(file);
    }
    return out;
  },
});

/** Short-lived links for viewing or downloading files straight from the bucket. */
export const getUrls = action({
  args: { fileIds: v.array(v.id("files")), download: v.optional(v.boolean()) },
  handler: async (ctx, args): Promise<Record<string, string>> => {
    const identity = await requireIdentity(ctx);
    if (args.fileIds.length > 200) {
      throw new ConvexError({ code: "TOO_MANY", message: "Too many files." });
    }
    const files: Doc<"files">[] = await ctx.runQuery(
      internal.files.filesForUrls,
      { ...identity, fileIds: args.fileIds },
    );
    const urls: Record<string, string> = {};
    for (const file of files) {
      urls[file._id] = await presignGet(file.storageKey, {
        expiresIn: VIEW_URL_SECONDS,
        downloadName: args.download ? file.name : undefined,
        contentType: file.contentType,
      });
    }
    return urls;
  },
});

/** Every file under a folder with its relative path, for zip downloads. */
export const folderContents = query({
  args: { folderId: v.id("folders") },
  handler: async (ctx, args) => {
    const { userId } = await requireVerified(ctx);
    const root = await ownedFolder(ctx, userId, args.folderId);
    const out: { fileId: Id<"files">; path: string; size: number }[] = [];
    const queue = [{ id: root._id, path: root.name }];
    while (queue.length > 0) {
      const { id, path } = queue.pop()!;
      const inside = siblings(ctx, userId, id);
      for (const child of await inside.folders()) {
        queue.push({ id: child._id, path: `${path}/${child.name}` });
      }
      for (const file of await inside.files()) {
        if (file.status === "ready") {
          out.push({
            fileId: file._id,
            path: `${path}/${file.name}`,
            size: file.size,
          });
        }
      }
    }
    return { name: root.name, files: out };
  },
});

/** Housekeeping: uploads that were reserved but never finished. */
export const cleanupPending = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - PENDING_UPLOAD_TTL_MS;
    const stale = await ctx.db
      .query("files")
      .withIndex("by_status", (q) =>
        q.eq("status", "pending").lt("createdAt", cutoff),
      )
      .take(200);
    const keys = stale.map((f) => f.storageKey).filter((k) => k.length > 0);
    for (const file of stale) await ctx.db.delete(file._id);
    if (keys.length > 0) {
      await ctx.scheduler.runAfter(0, internal.files.deleteObjects, { keys });
    }
  },
});
