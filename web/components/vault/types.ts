import type { Id } from "@/convex/_generated/dataModel";

export type VaultFile = {
  _id: Id<"files">;
  name: string;
  size: number;
  contentType: string;
  createdAt: number;
  folderId: Id<"folders"> | null;
};

export type VaultFolder = {
  _id: Id<"folders">;
  name: string;
  createdAt: number;
};

export type Item =
  | { kind: "file"; file: VaultFile }
  | { kind: "folder"; folder: VaultFolder };

export const itemKey = (item: Item) =>
  item.kind === "file" ? `file:${item.file._id}` : `folder:${item.folder._id}`;

export const itemName = (item: Item) =>
  item.kind === "file" ? item.file.name : item.folder.name;
