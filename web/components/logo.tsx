import { ScanFace } from "lucide-react";
import { cn } from "@/lib/utils";

export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2 font-semibold tracking-tight", className)}>
      <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent text-accent-foreground">
        <ScanFace className="h-5 w-5" aria-hidden />
      </span>
      FacialRec
    </span>
  );
}
