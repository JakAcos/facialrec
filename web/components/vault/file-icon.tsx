import {
  File,
  FileAudio,
  FileImage,
  FileText,
  FileVideo,
  Folder,
} from "lucide-react";
import { cn, fileKind } from "@/lib/utils";

export function FileIcon({
  contentType,
  name,
  className,
}: {
  contentType: string;
  name: string;
  className?: string;
}) {
  const kind = fileKind(contentType, name);
  const Icon =
    kind === "image"
      ? FileImage
      : kind === "video"
        ? FileVideo
        : kind === "audio"
          ? FileAudio
          : kind === "pdf" || kind === "text"
            ? FileText
            : File;
  const tone =
    kind === "image"
      ? "text-emerald-500"
      : kind === "video"
        ? "text-rose-500"
        : kind === "audio"
          ? "text-amber-500"
          : kind === "pdf"
            ? "text-red-500"
            : "text-muted";
  return <Icon className={cn(tone, className)} aria-hidden />;
}

export function FolderIcon({ className }: { className?: string }) {
  return <Folder className={cn("fill-accent/20 text-accent", className)} aria-hidden />;
}
