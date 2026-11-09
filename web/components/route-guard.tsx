"use client";

import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useSession, type SessionState } from "@/lib/use-session";

const HOME: Record<Exclude<SessionState, "loading">, string> = {
  signedOut: "/",
  needsEnroll: "/face",
  needsVerify: "/face",
  verified: "/vault",
};

export function FullPageSpinner() {
  return (
    <div className="flex flex-1 items-center justify-center" data-testid="loading">
      <Loader2 className="h-7 w-7 animate-spin text-muted" aria-label="Loading" />
    </div>
  );
}

/**
 * Sends people to the right screen for how far through sign-in they are.
 * This is only for convenience: the real protection is in the backend,
 * which refuses file access until the face check has passed.
 */
export function RouteGuard({
  allow,
  children,
}: {
  allow: SessionState[];
  children: React.ReactNode;
}) {
  const { state } = useSession();
  const router = useRouter();
  const allowed = allow.includes(state);

  useEffect(() => {
    if (state !== "loading" && !allowed) router.replace(HOME[state]);
  }, [state, allowed, router]);

  if (state === "loading" || !allowed) return <FullPageSpinner />;
  return <>{children}</>;
}
