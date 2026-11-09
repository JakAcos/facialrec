import { clsx, type ClassValue } from "clsx";
import { ConvexError } from "convex/values";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

export function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** The readable message from a Convex error, with a fallback for anything else. */
export function errorMessage(error: unknown, fallback = "Something went wrong."): string {
  if (error instanceof ConvexError) {
    const data = error.data as { message?: string } | string;
    if (typeof data === "string") return data;
    if (data?.message) return data.message;
  }
  return fallback;
}

export function errorCode(error: unknown): string | null {
  if (error instanceof ConvexError) {
    const data = error.data as { code?: string };
    return data?.code ?? null;
  }
  return null;
}

export type FileKind = "image" | "video" | "audio" | "pdf" | "text" | "other";

export function fileKind(contentType: string, name: string): FileKind {
  if (contentType.startsWith("image/")) return "image";
  if (contentType.startsWith("video/")) return "video";
  if (contentType.startsWith("audio/")) return "audio";
  if (contentType === "application/pdf") return "pdf";
  if (
    contentType.startsWith("text/") ||
    contentType === "application/json" ||
    /\.(md|txt|csv|json|log|ya?ml|ts|tsx|js|py|go|html|css)$/i.test(name)
  ) {
    return "text";
  }
  return "other";
}
