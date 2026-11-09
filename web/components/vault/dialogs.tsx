"use client";

import { useAction, useQuery } from "convex/react";
import { ChevronRight, Download, Home, Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { cn, fileKind, formatBytes } from "@/lib/utils";
import { FolderIcon } from "./file-icon";
import type { VaultFile } from "./types";

/** One text field and a confirm button: used for "new folder" and "rename". */
export function NameDialog({
  open,
  title,
  initial,
  action,
  onClose,
  onSubmit,
}: {
  open: boolean;
  title: string;
  initial: string;
  action: string;
  onClose: () => void;
  onSubmit: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);

  return (
    <Dialog open={open} onClose={onClose} title={title} testId="name-dialog">
      <form
        className="flex flex-col gap-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await onSubmit(name);
          } finally {
            setBusy(false);
          }
        }}
      >
        <input
          data-autofocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onFocus={(e) => {
            // Select the name but not the extension, like a desktop file manager.
            const dot = e.target.value.lastIndexOf(".");
            e.target.setSelectionRange(0, dot > 0 ? dot : e.target.value.length);
          }}
          maxLength={200}
          aria-label="Name"
          data-testid="name-input"
          className="h-11 rounded-lg border border-border bg-background px-3"
        />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={busy} disabled={name.trim().length === 0} data-testid="name-submit">
            {action}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function ConfirmDialog({
  open,
  title,
  body,
  action,
  onClose,
  onConfirm,
}: {
  open: boolean;
  title: string;
  body: string;
  action: string;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onClose={onClose} title={title} testId="confirm-dialog">
      <p className="text-sm text-muted">{body}</p>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="danger"
          loading={busy}
          data-testid="confirm-submit"
          onClick={async () => {
            setBusy(true);
            try {
              await onConfirm();
            } finally {
              setBusy(false);
            }
          }}
        >
          {action}
        </Button>
      </div>
    </Dialog>
  );
}

/** Folder picker for moving items. `blocked` folders (and what is inside them) cannot be chosen. */
export function MoveDialog({
  open,
  count,
  blocked,
  onClose,
  onMove,
}: {
  open: boolean;
  count: number;
  blocked: Id<"folders">[];
  onClose: () => void;
  onMove: (destination: Id<"folders"> | undefined) => Promise<void>;
}) {
  const tree = useQuery(api.files.folderTree, open ? {} : "skip");
  const [current, setCurrent] = useState<Id<"folders"> | null>(null);
  const [busy, setBusy] = useState(false);

  const byId = useMemo(() => new Map((tree ?? []).map((f) => [f._id, f])), [tree]);
  const path = useMemo(() => {
    const out = [];
    let cursor = current;
    while (cursor) {
      const folder = byId.get(cursor);
      if (!folder) break;
      out.unshift(folder);
      cursor = folder.parentId;
    }
    return out;
  }, [current, byId]);
  const children = (tree ?? [])
    .filter((f) => f.parentId === current && !blocked.includes(f._id))
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Move ${count} item${count === 1 ? "" : "s"}`}
      testId="move-dialog"
    >
      <nav className="flex flex-wrap items-center gap-1 text-sm" aria-label="Destination">
        <button
          type="button"
          onClick={() => setCurrent(null)}
          className="flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 hover:bg-surface-2"
        >
          <Home className="h-3.5 w-3.5" aria-hidden /> Vault
        </button>
        {path.map((folder) => (
          <span key={folder._id} className="flex items-center gap-1">
            <ChevronRight className="h-3.5 w-3.5 text-muted" aria-hidden />
            <button
              type="button"
              onClick={() => setCurrent(folder._id)}
              className="cursor-pointer rounded px-1.5 py-0.5 hover:bg-surface-2"
            >
              {folder.name}
            </button>
          </span>
        ))}
      </nav>
      <div className="mt-3 h-56 overflow-y-auto rounded-xl border border-border">
        {tree === undefined ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-muted" />
          </div>
        ) : children.length === 0 ? (
          <p className="flex h-full items-center justify-center text-sm text-muted">
            No folders here
          </p>
        ) : (
          children.map((folder) => (
            <button
              key={folder._id}
              type="button"
              onClick={() => setCurrent(folder._id)}
              data-testid="move-target"
              className="flex w-full cursor-pointer items-center gap-2.5 border-b border-border px-3 py-2.5 text-left text-sm last:border-b-0 hover:bg-surface-2"
            >
              <FolderIcon className="h-5 w-5" />
              <span className="truncate">{folder.name}</span>
              <ChevronRight className="ml-auto h-4 w-4 text-muted" aria-hidden />
            </button>
          ))
        )}
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          loading={busy}
          data-testid="move-submit"
          onClick={async () => {
            setBusy(true);
            try {
              await onMove(current ?? undefined);
            } finally {
              setBusy(false);
            }
          }}
        >
          Move here
        </Button>
      </div>
    </Dialog>
  );
}

const MAX_TEXT_PREVIEW = 300 * 1024;

/** Shows a file in place when the browser can, otherwise offers a download. */
export function PreviewDialog({
  file,
  onClose,
  onDownload,
}: {
  file: VaultFile | null;
  onClose: () => void;
  onDownload: (file: VaultFile) => void;
}) {
  const getUrls = useAction(api.files.getUrls);
  const [loaded, setLoaded] = useState<{
    id: string;
    url: string | null;
    text: string | null;
    failed: boolean;
  } | null>(null);
  const kind = file ? fileKind(file.contentType, file.name) : "other";

  useEffect(() => {
    if (!file) return;
    let cancelled = false;
    (async () => {
      try {
        const urls = await getUrls({ fileIds: [file._id] });
        const url = urls[file._id];
        let text: string | null = null;
        if (kind === "text" && file.size <= MAX_TEXT_PREVIEW) {
          text = await (await fetch(url)).text();
        }
        if (!cancelled) setLoaded({ id: file._id, url, text, failed: false });
      } catch {
        if (!cancelled) setLoaded({ id: file._id, url: null, text: null, failed: true });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [file, kind, getUrls]);

  if (!file) return null;
  const ready = loaded?.id === file._id ? loaded : null;
  const url = ready?.url ?? null;

  let body: React.ReactNode;
  if (!ready) {
    body = <Loader2 className="h-6 w-6 animate-spin text-muted" />;
  } else if (ready.failed || !url) {
    body = <p className="text-sm text-muted">This file could not be loaded.</p>;
  } else if (kind === "image") {
    // eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL
    body = <img src={url} alt={file.name} className="max-h-[70vh] max-w-full rounded-lg object-contain" data-testid="preview-image" />;
  } else if (kind === "video") {
    body = <video src={url} controls playsInline className="max-h-[70vh] max-w-full rounded-lg" data-testid="preview-video" />;
  } else if (kind === "audio") {
    body = <audio src={url} controls className="w-full" />;
  } else if (kind === "pdf") {
    body = <iframe src={url} title={file.name} className="h-[70vh] w-full rounded-lg border border-border bg-white" />;
  } else if (kind === "text" && ready.text !== null) {
    body = (
      <pre className="max-h-[70vh] w-full overflow-auto rounded-lg bg-surface-2 p-4 text-left font-mono text-xs" data-testid="preview-text">
        {ready.text}
      </pre>
    );
  } else {
    body = <p className="text-sm text-muted">No preview for this kind of file.</p>;
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={file.name}
      testId="preview-dialog"
      className={cn(kind === "other" ? "max-w-md" : "max-w-4xl")}
    >
      <div className="flex min-h-32 items-center justify-center">{body}</div>
      <div className="mt-4 flex items-center justify-between gap-3">
        <span className="text-xs text-muted">{formatBytes(file.size)}</span>
        <Button variant="secondary" size="sm" onClick={() => onDownload(file)}>
          <Download className="h-4 w-4" aria-hidden />
          Download
        </Button>
      </div>
    </Dialog>
  );
}
