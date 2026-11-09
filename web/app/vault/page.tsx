"use client";

import { useAction, useConvex, useMutation, useQuery } from "convex/react";
import { zip } from "fflate";
import {
  ArrowDownAZ,
  Check,
  ChevronRight,
  CloudUpload,
  Download,
  Eye,
  FolderInput,
  FolderPlus,
  Home,
  LayoutGrid,
  List,
  Pencil,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { AppShell } from "@/components/app-shell";
import { FullPageSpinner, RouteGuard } from "@/components/route-guard";
import { Button } from "@/components/ui/button";
import { Menu, type MenuItem } from "@/components/ui/menu";
import {
  ConfirmDialog,
  MoveDialog,
  NameDialog,
  PreviewDialog,
} from "@/components/vault/dialogs";
import { FileIcon, FolderIcon } from "@/components/vault/file-icon";
import {
  itemKey,
  itemName,
  type Item,
  type VaultFile,
  type VaultFolder,
} from "@/components/vault/types";
import { useUploads } from "@/components/vault/use-uploads";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { cn, errorMessage, fileKind, formatBytes, formatDate } from "@/lib/utils";

type Filter = "all" | "image" | "video" | "audio" | "docs" | "other";
type Sort = "name" | "date" | "size";
type View = "grid" | "list";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "image", label: "Images" },
  { id: "video", label: "Videos" },
  { id: "audio", label: "Audio" },
  { id: "docs", label: "Documents" },
  { id: "other", label: "Other" },
];

/** Must not exceed the limit enforced by files.getUrls. */
const URL_BATCH = 200;

function matchesFilter(file: VaultFile, filter: Filter): boolean {
  if (filter === "all") return true;
  const kind = fileKind(file.contentType, file.name);
  if (filter === "docs") return kind === "pdf" || kind === "text";
  return kind === filter;
}

function triggerDownload(url: string, name?: string) {
  const a = document.createElement("a");
  a.href = url;
  if (name) a.download = name;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Signed links last an hour on the server. Refresh ours a little before that. */
const THUMBNAIL_MAX_AGE_MS = 50 * 60 * 1000;

/** Signed thumbnail links for the images on screen, fetched in one batch. */
function useThumbnails(files: VaultFile[]) {
  const getUrls = useAction(api.files.getUrls);
  const [urls, setUrls] = useState<Record<string, string>>({});
  // When each link was requested, so a tab left open asks again before the
  // links expire instead of showing broken images.
  const requestedAt = useRef(new Map<string, number>());
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), 5 * 60 * 1000);
    return () => clearInterval(timer);
  }, []);

  const wanted = useMemo(
    () =>
      files
        .filter((f) => fileKind(f.contentType, f.name) === "image" && f.size < 15 * 1024 * 1024)
        .map((f) => f._id)
        .slice(0, 100),
    [files],
  );

  useEffect(() => {
    const now = Date.now();
    const due = wanted.filter((id) => {
      const at = requestedAt.current.get(id);
      return at === undefined || now - at > THUMBNAIL_MAX_AGE_MS;
    });
    if (due.length === 0) return;
    due.forEach((id) => requestedAt.current.set(id, now));
    getUrls({ fileIds: due })
      .then((fresh) => setUrls((old) => ({ ...old, ...fresh })))
      .catch(() => due.forEach((id) => requestedAt.current.delete(id)));
  }, [wanted, getUrls, tick]);

  return urls;
}

function StorageMeter() {
  const usage = useQuery(api.files.usage);
  if (!usage) return null;
  const fraction = Math.min(1, usage.used / usage.limit);
  return (
    <div className="flex min-w-44 flex-col gap-1.5" data-testid="storage-meter">
      <div className="flex justify-between text-xs text-muted">
        <span>
          <span data-testid="storage-used">{formatBytes(usage.used)}</span> of{" "}
          {formatBytes(usage.limit)}
        </span>
        <span>{Math.round(fraction * 100)}%</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
        <div
          className={cn("h-full rounded-full", fraction > 0.9 ? "bg-danger" : "bg-accent")}
          style={{ width: `${Math.max(fraction * 100, usage.used > 0 ? 2 : 0)}%` }}
        />
      </div>
    </div>
  );
}

function Vault() {
  const router = useRouter();
  const params = useSearchParams();
  const convex = useConvex();
  const folderId = (params.get("folder") as Id<"folders"> | null) ?? undefined;

  const [searchText, setSearchText] = useState("");
  const searching = searchText.trim().length > 0;
  const listing = useQuery(api.files.list, searching ? "skip" : { folderId });
  const found = useQuery(api.files.search, searching ? { text: searchText } : "skip");

  const createFolder = useMutation(api.files.createFolder);
  const rename = useMutation(api.files.rename);
  const move = useMutation(api.files.move);
  const remove = useMutation(api.files.remove);
  const getUrls = useAction(api.files.getUrls);
  const { uploads, addFiles, clearFinished } = useUploads();

  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<Sort>("name");
  const [view, setView] = useState<View>("grid");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dragging, setDragging] = useState(false);
  const [preview, setPreview] = useState<VaultFile | null>(null);
  const [dialog, setDialog] = useState<
    | { type: "newFolder" }
    | { type: "rename"; item: Item }
    | { type: "move"; items: Item[] }
    | { type: "delete"; items: Item[] }
    | null
  >(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);

  useEffect(() => {
    try {
      const saved = localStorage.getItem("facialrec.view");
      // eslint-disable-next-line react-hooks/set-state-in-effect -- restores a saved preference after hydration
      if (saved === "grid" || saved === "list") setView(saved);
    } catch {}
  }, []);
  const chooseView = (next: View) => {
    setView(next);
    try {
      localStorage.setItem("facialrec.view", next);
    } catch {}
  };

  const source = searching ? found : listing;
  const folders: VaultFolder[] = useMemo(
    () => (filter === "all" ? (source?.folders ?? []) : []),
    [source, filter],
  );
  const files: VaultFile[] = useMemo(() => {
    const list = (source?.files ?? []).filter((f) => matchesFilter(f, filter));
    return [...list].sort((a, b) =>
      sort === "name"
        ? a.name.localeCompare(b.name)
        : sort === "size"
          ? b.size - a.size
          : b.createdAt - a.createdAt,
    );
  }, [source, filter, sort]);
  const thumbnails = useThumbnails(files);

  const items: Item[] = useMemo(
    () => [
      ...folders.map((folder) => ({ kind: "folder" as const, folder })),
      ...files.map((file) => ({ kind: "file" as const, file })),
    ],
    [folders, files],
  );
  const selectedItems = items.filter((i) => selected.has(itemKey(i)));

  const openFolder = (id: Id<"folders"> | undefined) => {
    setSelected(new Set());
    setSearchText("");
    router.push(id ? `/vault?folder=${id}` : "/vault");
  };

  const toggle = (item: Item) =>
    setSelected((old) => {
      const next = new Set(old);
      const key = itemKey(item);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const run = async (work: () => Promise<unknown>, success?: string) => {
    try {
      await work();
      if (success) toast.success(success);
      setDialog(null);
      setSelected(new Set());
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  const download = async (file: VaultFile) => {
    try {
      const urls = await getUrls({ fileIds: [file._id], download: true });
      triggerDownload(urls[file._id]);
    } catch (error) {
      toast.error(errorMessage(error, "Download failed."));
    }
  };

  const downloadFolder = async (folder: VaultFolder) => {
    const id = toast.loading(`Preparing ${folder.name}.zip…`);
    try {
      const contents = await convex.query(api.files.folderContents, { folderId: folder._id });
      if (contents.files.length === 0) {
        toast.info("That folder is empty.", { id });
        return;
      }
      // The backend signs at most 200 links per call, so ask in batches.
      const urls: Record<string, string> = {};
      for (let i = 0; i < contents.files.length; i += URL_BATCH) {
        const batch = contents.files.slice(i, i + URL_BATCH).map((f) => f.fileId);
        Object.assign(urls, await getUrls({ fileIds: batch }));
      }
      const entries: Record<string, Uint8Array> = {};
      for (const entry of contents.files) {
        const res = await fetch(urls[entry.fileId]);
        if (!res.ok) throw new Error("fetch failed");
        entries[entry.path] = new Uint8Array(await res.arrayBuffer());
      }
      const zipped = await new Promise<Uint8Array>((resolve, reject) =>
        // Level 0 just stores the files: photos and videos are already compressed.
        zip(entries, { level: 0 }, (err, data) => (err ? reject(err) : resolve(data))),
      );
      const blobUrl = URL.createObjectURL(
        new Blob([zipped as BlobPart], { type: "application/zip" }),
      );
      triggerDownload(blobUrl, `${folder.name}.zip`);
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
      toast.success(`Downloaded ${folder.name}.zip`, { id });
    } catch {
      toast.error("Could not build the zip file.", { id });
    }
  };

  const ids = (list: Item[]) => ({
    fileIds: list.flatMap((i) => (i.kind === "file" ? [i.file._id] : [])),
    folderIds: list.flatMap((i) => (i.kind === "folder" ? [i.folder._id] : [])),
  });

  const actionsFor = (item: Item): MenuItem[] => {
    const shared: MenuItem[] = [
      { label: "Rename", icon: <Pencil className="h-4 w-4" />, onSelect: () => setDialog({ type: "rename", item }) },
      { label: "Move", icon: <FolderInput className="h-4 w-4" />, onSelect: () => setDialog({ type: "move", items: [item] }) },
      { label: "Delete", icon: <Trash2 className="h-4 w-4" />, danger: true, onSelect: () => setDialog({ type: "delete", items: [item] }) },
    ];
    if (item.kind === "folder") {
      return [
        { label: "Download as zip", icon: <Download className="h-4 w-4" />, onSelect: () => void downloadFolder(item.folder) },
        ...shared,
      ];
    }
    return [
      { label: "Preview", icon: <Eye className="h-4 w-4" />, onSelect: () => setPreview(item.file) },
      { label: "Download", icon: <Download className="h-4 w-4" />, onSelect: () => void download(item.file) },
      ...shared,
    ];
  };

  const open = (item: Item) =>
    item.kind === "folder" ? openFolder(item.folder._id) : setPreview(item.file);

  const activeUploads = uploads.filter((u) => u.status === "queued" || u.status === "uploading");
  const loading = source === undefined;
  const empty = !loading && items.length === 0;

  return (
    <div
      className="relative flex flex-1 flex-col gap-5"
      onDragEnter={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        dragDepth.current += 1;
        setDragging(true);
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragging(false);
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) e.preventDefault();
      }}
      onDrop={(e) => {
        e.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        const dropped = Array.from(e.dataTransfer.files);
        if (dropped.length > 0) addFiles(dropped, folderId);
      }}
    >
      {/* Title row */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <nav className="flex flex-wrap items-center gap-1 text-sm text-muted" aria-label="Folder path" data-testid="breadcrumbs">
            <button
              type="button"
              onClick={() => openFolder(undefined)}
              className="flex cursor-pointer items-center gap-1 rounded px-1 py-0.5 hover:bg-surface-2 hover:text-foreground"
            >
              <Home className="h-3.5 w-3.5" aria-hidden /> Vault
            </button>
            {!searching &&
              listing?.path.map((p) => (
                <span key={p._id} className="flex items-center gap-1">
                  <ChevronRight className="h-3.5 w-3.5" aria-hidden />
                  <button
                    type="button"
                    onClick={() => openFolder(p._id)}
                    className="cursor-pointer rounded px-1 py-0.5 hover:bg-surface-2 hover:text-foreground"
                  >
                    {p.name}
                  </button>
                </span>
              ))}
          </nav>
          <h1 className="mt-1 truncate text-2xl font-semibold tracking-tight" data-testid="vault-title">
            {searching
              ? `Results for "${searchText.trim()}"`
              : (listing?.path.at(-1)?.name ?? "Your vault")}
          </h1>
        </div>
        <StorageMeter />
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-40 flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden />
          <input
            type="search"
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            placeholder="Search your vault"
            aria-label="Search your vault"
            data-testid="search"
            className="h-10 w-full rounded-lg border border-border bg-surface pl-9 pr-3 text-sm"
          />
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="secondary" onClick={() => setDialog({ type: "newFolder" })} disabled={searching} data-testid="new-folder">
            <FolderPlus className="h-4 w-4" aria-hidden />
            <span className="hidden sm:inline">New folder</span>
          </Button>
          <Button onClick={() => fileInput.current?.click()} data-testid="upload-button">
            <CloudUpload className="h-4 w-4" aria-hidden />
            Upload
          </Button>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            data-testid="file-input"
            onChange={(e) => {
              const picked = Array.from(e.target.files ?? []);
              if (picked.length > 0) addFiles(picked, folderId);
              e.target.value = "";
            }}
          />
        </div>
      </div>

      {/* Filters, sort and view */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by type">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setFilter(f.id)}
              aria-pressed={filter === f.id}
              className={cn(
                "cursor-pointer rounded-full border px-3 py-1 text-xs font-medium",
                filter === f.id
                  ? "border-accent bg-accent-soft text-accent"
                  : "border-border text-muted hover:text-foreground",
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-muted">
            <ArrowDownAZ className="h-4 w-4" aria-hidden />
            <span className="sr-only">Sort by</span>
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as Sort)}
              className="cursor-pointer rounded-md border border-border bg-surface px-2 py-1 text-xs text-foreground"
            >
              <option value="name">Name</option>
              <option value="date">Newest</option>
              <option value="size">Largest</option>
            </select>
          </label>
          <div className="flex overflow-hidden rounded-lg border border-border" role="group" aria-label="View">
            {(["grid", "list"] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => chooseView(v)}
                aria-pressed={view === v}
                aria-label={v === "grid" ? "Grid view" : "List view"}
                data-testid={`view-${v}`}
                className={cn(
                  "cursor-pointer p-1.5",
                  view === v ? "bg-surface-2 text-foreground" : "text-muted hover:text-foreground",
                )}
              >
                {v === "grid" ? <LayoutGrid className="h-4 w-4" /> : <List className="h-4 w-4" />}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Bulk actions */}
      {selectedItems.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-accent/40 bg-accent-soft px-3 py-2 text-sm" data-testid="bulk-bar">
          <span className="font-medium text-accent">{selectedItems.length} selected</span>
          <div className="ml-auto flex gap-1">
            <Button variant="ghost" size="sm" onClick={() => setDialog({ type: "move", items: selectedItems })} data-testid="bulk-move">
              <FolderInput className="h-4 w-4" aria-hidden /> Move
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setDialog({ type: "delete", items: selectedItems })} data-testid="bulk-delete">
              <Trash2 className="h-4 w-4" aria-hidden /> Delete
            </Button>
            <Button variant="ghost" size="icon" aria-label="Clear selection" onClick={() => setSelected(new Set())}>
              <X className="h-4 w-4" aria-hidden />
            </Button>
          </div>
        </div>
      )}

      {/* Contents */}
      {loading ? (
        <FullPageSpinner />
      ) : empty ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-border py-20 text-center" data-testid="empty-state">
          <CloudUpload className="h-10 w-10 text-muted" aria-hidden />
          <p className="font-medium">
            {searching ? "Nothing matches that search" : filter !== "all" ? "No files of this type here" : "This folder is empty"}
          </p>
          {!searching && filter === "all" && (
            <p className="text-sm text-muted">Drop files anywhere on this page, or use the Upload button.</p>
          )}
        </div>
      ) : view === "grid" ? (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5" data-testid="items">
          {items.map((item) => {
            const key = itemKey(item);
            const isSelected = selected.has(key);
            const name = itemName(item);
            return (
              <li
                key={key}
                data-testid="item"
                data-name={name}
                data-kind={item.kind}
                className={cn(
                  "group relative flex flex-col rounded-xl border bg-surface transition-shadow hover:shadow-md",
                  isSelected ? "border-accent ring-1 ring-accent" : "border-border",
                )}
              >
                <button
                  type="button"
                  onClick={() => open(item)}
                  className="flex aspect-[4/3] w-full cursor-pointer items-center justify-center overflow-hidden rounded-t-xl bg-surface-2"
                  aria-label={`Open ${name}`}
                >
                  {item.kind === "folder" ? (
                    <FolderIcon className="h-14 w-14" />
                  ) : thumbnails[item.file._id] ? (
                    // eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL
                    <img src={thumbnails[item.file._id]} alt="" loading="lazy" className="h-full w-full object-cover" />
                  ) : (
                    <FileIcon contentType={item.file.contentType} name={name} className="h-12 w-12" />
                  )}
                </button>
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={isSelected}
                  aria-label={`Select ${name}`}
                  onClick={() => toggle(item)}
                  data-testid="select-item"
                  className={cn(
                    "absolute left-2 top-2 flex h-5 w-5 cursor-pointer items-center justify-center rounded-md border transition-opacity",
                    isSelected
                      ? "border-accent bg-accent text-accent-foreground opacity-100"
                      : "border-border bg-surface opacity-0 focus-visible:opacity-100 group-hover:opacity-100",
                  )}
                >
                  {isSelected && <Check className="h-3.5 w-3.5" aria-hidden />}
                </button>
                <div className="flex items-center gap-1 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium" title={name}>{name}</p>
                    <p className="text-xs text-muted">
                      {item.kind === "folder" ? "Folder" : formatBytes(item.file.size)}
                    </p>
                  </div>
                  <Menu items={actionsFor(item)} label={`Actions for ${name}`} />
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="overflow-visible rounded-xl border border-border bg-surface" data-testid="items">
          <div className="hidden grid-cols-[2rem_1fr_7rem_8rem_2.5rem] gap-3 border-b border-border px-3 py-2 text-xs font-medium text-muted sm:grid">
            <span />
            <span>Name</span>
            <span>Size</span>
            <span>Added</span>
            <span />
          </div>
          {items.map((item) => {
            const key = itemKey(item);
            const isSelected = selected.has(key);
            const name = itemName(item);
            return (
              <div
                key={key}
                data-testid="item"
                data-name={name}
                data-kind={item.kind}
                className={cn(
                  "grid grid-cols-[2rem_1fr_2.5rem] items-center gap-3 border-b border-border px-3 py-2 last:border-b-0 sm:grid-cols-[2rem_1fr_7rem_8rem_2.5rem]",
                  isSelected && "bg-accent-soft",
                )}
              >
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={isSelected}
                  aria-label={`Select ${name}`}
                  onClick={() => toggle(item)}
                  data-testid="select-item"
                  className={cn(
                    "flex h-5 w-5 cursor-pointer items-center justify-center rounded-md border",
                    isSelected ? "border-accent bg-accent text-accent-foreground" : "border-border",
                  )}
                >
                  {isSelected && <Check className="h-3.5 w-3.5" aria-hidden />}
                </button>
                <button type="button" onClick={() => open(item)} className="flex min-w-0 cursor-pointer items-center gap-2.5 text-left">
                  {item.kind === "folder" ? (
                    <FolderIcon className="h-5 w-5 shrink-0" />
                  ) : (
                    <FileIcon contentType={item.file.contentType} name={name} className="h-5 w-5 shrink-0" />
                  )}
                  <span className="truncate text-sm font-medium">{name}</span>
                </button>
                <span className="hidden text-sm text-muted sm:block">
                  {item.kind === "folder" ? "Folder" : formatBytes(item.file.size)}
                </span>
                <span className="hidden text-sm text-muted sm:block">
                  {formatDate(item.kind === "folder" ? item.folder.createdAt : item.file.createdAt)}
                </span>
                <Menu items={actionsFor(item)} label={`Actions for ${name}`} />
              </div>
            );
          })}
        </div>
      )}

      {/* Drop overlay */}
      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center bg-accent/15 backdrop-blur-sm">
          <div className="rounded-2xl border-2 border-dashed border-accent bg-surface px-10 py-8 text-center shadow-2xl">
            <CloudUpload className="mx-auto h-10 w-10 text-accent" aria-hidden />
            <p className="mt-2 font-semibold">Drop to upload here</p>
          </div>
        </div>
      )}

      {/* Upload progress */}
      {uploads.length > 0 && (
        <div className="fixed bottom-4 left-4 z-30 w-[calc(100%-2rem)] max-w-sm rounded-2xl border border-border bg-surface shadow-2xl" data-testid="uploads">
          <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
            <p className="text-sm font-semibold">
              {activeUploads.length > 0
                ? `Uploading ${activeUploads.length} file${activeUploads.length === 1 ? "" : "s"}`
                : "Uploads finished"}
            </p>
            {activeUploads.length === 0 && (
              <button type="button" onClick={clearFinished} aria-label="Dismiss" className="cursor-pointer rounded p-1 text-muted hover:bg-surface-2">
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
          <ul className="max-h-52 overflow-y-auto px-4 py-2">
            {uploads.map((u) => (
              <li key={u.id} className="py-1.5" data-testid="upload-row" data-status={u.status}>
                <div className="flex items-center justify-between gap-3 text-sm">
                  <span className="truncate">{u.name}</span>
                  <span className={cn("shrink-0 text-xs", u.status === "error" ? "text-danger" : "text-muted")}>
                    {u.status === "done" ? (
                      <Check className="h-4 w-4 text-success" aria-label="Done" />
                    ) : u.status === "error" ? (
                      "Failed"
                    ) : u.status === "queued" ? (
                      "Waiting"
                    ) : (
                      `${Math.round(u.progress * 100)}%`
                    )}
                  </span>
                </div>
                {u.status === "uploading" && (
                  <div className="mt-1 h-1 overflow-hidden rounded-full bg-surface-2">
                    <div className="h-full bg-accent transition-[width]" style={{ width: `${u.progress * 100}%` }} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Dialogs */}
      {dialog?.type === "newFolder" && (
        <NameDialog
          open
          title="New folder"
          initial=""
          action="Create"
          onClose={() => setDialog(null)}
          onSubmit={(name) => run(() => createFolder({ name, parentId: folderId }), "Folder created")}
        />
      )}
      {dialog?.type === "rename" && (
        <NameDialog
          open
          title={`Rename ${dialog.item.kind}`}
          initial={itemName(dialog.item)}
          action="Rename"
          onClose={() => setDialog(null)}
          onSubmit={(name) =>
            run(() =>
              rename({
                name,
                target:
                  dialog.item.kind === "file"
                    ? { kind: "file", id: dialog.item.file._id }
                    : { kind: "folder", id: dialog.item.folder._id },
              }),
            )
          }
        />
      )}
      {dialog?.type === "move" && (
        <MoveDialog
          open
          count={dialog.items.length}
          blocked={ids(dialog.items).folderIds}
          onClose={() => setDialog(null)}
          onMove={(destinationId) =>
            run(() => move({ ...ids(dialog.items), destinationId }), "Moved")
          }
        />
      )}
      {dialog?.type === "delete" && (
        <ConfirmDialog
          open
          title={`Delete ${dialog.items.length === 1 ? `"${itemName(dialog.items[0])}"` : `${dialog.items.length} items`}?`}
          body={
            dialog.items.some((i) => i.kind === "folder")
              ? "Folders are deleted with everything inside them. This cannot be undone."
              : "This cannot be undone."
          }
          action="Delete"
          onClose={() => setDialog(null)}
          onConfirm={() => run(() => remove(ids(dialog.items)), "Deleted")}
        />
      )}
      <PreviewDialog file={preview} onClose={() => setPreview(null)} onDownload={(f) => void download(f)} />
    </div>
  );
}

export default function VaultPage() {
  return (
    <RouteGuard allow={["verified"]}>
      <AppShell>
        <Suspense fallback={<FullPageSpinner />}>
          <Vault />
        </Suspense>
      </AppShell>
    </RouteGuard>
  );
}
