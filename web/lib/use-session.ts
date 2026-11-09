"use client";

import { useConvexAuth, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";

export type SessionState =
  | "loading"
  | "signedOut"
  | "needsEnroll"
  | "needsVerify"
  | "verified";

/** One place that answers: who is this, and how far through sign-in are they? */
export function useSession() {
  const { isLoading, isAuthenticated } = useConvexAuth();
  const me = useQuery(api.users.me, isAuthenticated ? {} : "skip");
  const face = useQuery(api.face.status, isAuthenticated ? {} : "skip");

  let state: SessionState;
  if (isLoading) state = "loading";
  else if (!isAuthenticated) state = "signedOut";
  else if (me === undefined || face === undefined) state = "loading";
  else if (me === null || face === null) state = "signedOut";
  else if (!face.enrolled) state = "needsEnroll";
  else if (!face.verified) state = "needsVerify";
  else state = "verified";

  return { state, me: me ?? null, face: face ?? null };
}
