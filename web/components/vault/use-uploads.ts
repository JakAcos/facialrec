"use client";

import { useAction } from "convex/react";
import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { errorMessage } from "@/lib/utils";

export type Upload = {
  id: number;
  name: string;
  size: number;
  progress: number;
  status: "queued" | "uploading" | "done" | "error";
  error?: string;
};

/** Posts the file straight to the bucket, reporting progress as it goes. */
function postToBucket(
  url: string,
  fields: Record<string, string>,
  file: File,
  onProgress: (fraction: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.append(key, value);
    form.append("file", file); // the file must be the last field
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error(`Upload failed (${xhr.status})`));
    xhr.onerror = () => reject(new Error("Network error during upload"));
    xhr.send(form);
  });
}

/**
 * Upload queue. Files go one at a time: ask Convex for a signed form,
 * send the bytes directly to the bucket, then ask Convex to confirm.
 */
export function useUploads() {
  const requestUpload = useAction(api.files.requestUpload);
  const completeUpload = useAction(api.files.completeUpload);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const nextId = useRef(1);
  const chain = useRef<Promise<void>>(Promise.resolve());

  const patch = (id: number, change: Partial<Upload>) =>
    setUploads((list) => list.map((u) => (u.id === id ? { ...u, ...change } : u)));

  const addFiles = useCallback(
    (files: File[], folderId: Id<"folders"> | undefined) => {
      const entries = files.map((file) => ({ file, id: nextId.current++ }));
      setUploads((list) => [
        ...list,
        ...entries.map(({ file, id }) => ({
          id,
          name: file.name,
          size: file.size,
          progress: 0,
          status: "queued" as const,
        })),
      ]);

      for (const { file, id } of entries) {
        chain.current = chain.current.then(async () => {
          patch(id, { status: "uploading" });
          try {
            const contentType = file.type || "application/octet-stream";
            const form = await requestUpload({
              name: file.name,
              size: file.size,
              contentType,
              folderId,
            });
            await postToBucket(form.url, form.fields, file, (progress) =>
              patch(id, { progress }),
            );
            await completeUpload({ fileId: form.fileId });
            patch(id, { status: "done", progress: 1, name: form.name });
          } catch (error) {
            const message = errorMessage(
              error,
              error instanceof Error ? error.message : "Upload failed.",
            );
            patch(id, { status: "error", error: message });
            toast.error(`${file.name}: ${message}`);
          }
        });
      }
    },
    [requestUpload, completeUpload],
  );

  const clearFinished = useCallback(
    () => setUploads((list) => list.filter((u) => u.status === "queued" || u.status === "uploading")),
    [],
  );

  return { uploads, addFiles, clearFinished };
}
