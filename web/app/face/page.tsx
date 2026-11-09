"use client";

import { useAuthActions } from "@convex-dev/auth/react";
import { useAction, useMutation } from "convex/react";
import { CircleAlert, CircleCheck, Lock, ScanFace } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { FaceCapture } from "@/components/face-capture";
import { Logo } from "@/components/logo";
import { FullPageSpinner, RouteGuard } from "@/components/route-guard";
import { Button } from "@/components/ui/button";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { Step } from "@/lib/pose";
import { errorCode, errorMessage } from "@/lib/utils";
import { useSession } from "@/lib/use-session";

type Phase =
  | { name: "intro" }
  | { name: "starting" }
  | { name: "capture"; challengeId: Id<"faceChallenges">; steps: Step[]; attempt: number }
  | { name: "checking" }
  | { name: "success" }
  | { name: "failed"; message: string }
  | { name: "locked"; message: string };

function FaceCheck() {
  const router = useRouter();
  const params = useSearchParams();
  const reenroll = params.get("reenroll") === "1";
  const { state, me } = useSession();
  const { signOut } = useAuthActions();
  const startChallenge = useMutation(api.face.startChallenge);
  const submit = useAction(api.face.submit);

  const enrolling = state === "needsEnroll" || reenroll;
  const [phase, setPhase] = useState<Phase>({ name: "intro" });
  const attempts = useRef(0);
  const autoStarted = useRef(false);

  const begin = useCallback(async () => {
    setPhase({ name: "starting" });
    try {
      const challenge = await startChallenge({ reenroll });
      attempts.current += 1;
      setPhase({
        name: "capture",
        challengeId: challenge.challengeId,
        steps: challenge.steps,
        attempt: attempts.current,
      });
    } catch (error) {
      const message = errorMessage(error, "Could not start the face check.");
      setPhase(
        errorCode(error) === "LOCKED"
          ? { name: "locked", message }
          : { name: "failed", message },
      );
    }
  }, [startChallenge, reenroll]);

  // Returning users go straight to the camera. New users read the intro first.
  useEffect(() => {
    if (state === "needsVerify" && !reenroll && !autoStarted.current) {
      autoStarted.current = true;
      void begin();
    }
  }, [state, reenroll, begin]);

  const onFrames = useCallback(
    async (challengeId: Id<"faceChallenges">, frames: Blob[]) => {
      setPhase({ name: "checking" });
      try {
        const buffers = await Promise.all(frames.map((f) => f.arrayBuffer()));
        const result = await submit({ challengeId, frames: buffers });
        if (result.ok) {
          setPhase({ name: "success" });
          setTimeout(() => router.replace(reenroll ? "/account" : "/vault"), 900);
        } else {
          setPhase({
            name: "failed",
            message: result.message ?? "The face check did not pass.",
          });
        }
      } catch (error) {
        const message = errorMessage(error, "The face check could not be completed.");
        setPhase(
          errorCode(error) === "LOCKED"
            ? { name: "locked", message }
            : { name: "failed", message },
        );
      }
    },
    [submit, router, reenroll],
  );

  const title = enrolling
    ? reenroll
      ? "Replace your face"
      : "Set up your face"
    : "Verify it's you";

  return (
    <div className="flex flex-1 flex-col">
      <header className="mx-auto flex w-full max-w-3xl items-center justify-between px-6 py-5">
        <Logo />
        {reenroll ? (
          <Button variant="ghost" size="sm" onClick={() => router.replace("/account")}>
            Cancel
          </Button>
        ) : (
          <Button variant="ghost" size="sm" onClick={() => void signOut()} data-testid="sign-out">
            Sign out
          </Button>
        )}
      </header>

      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col items-center px-6 pb-12">
        <h1 className="text-center text-2xl font-semibold tracking-tight sm:text-3xl" data-testid="face-title">
          {title}
        </h1>
        <p className="mt-2 max-w-md text-center text-sm text-muted">
          {enrolling
            ? "Three quick captures: straight on, then a turn to each side."
            : `Signed in as ${me?.email ?? me?.name ?? "you"}. One quick look unlocks your vault.`}
        </p>

        <div className="mt-8 w-full" data-testid="face-phase" data-phase={phase.name}>
          {phase.name === "intro" && (
            <div className="mx-auto flex max-w-md flex-col items-center gap-5 rounded-2xl border border-border bg-surface p-8 text-center">
              <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent-soft text-accent">
                <ScanFace className="h-8 w-8" aria-hidden />
              </span>
              <ul className="flex flex-col gap-2 text-left text-sm text-muted">
                <li>• Face a window or a light, and take off hats or sunglasses.</li>
                <li>• Follow the prompts: look straight, then turn your head.</li>
                <li>• Your photos are not kept. Only an encrypted template is stored.</li>
              </ul>
              <Button size="lg" onClick={() => void begin()} data-testid="face-start">
                {enrolling ? "Start face setup" : "Start face check"}
              </Button>
            </div>
          )}

          {phase.name === "starting" && <FullPageSpinner />}

          {(phase.name === "capture" || phase.name === "checking") && (
            <div className="flex flex-col gap-3">
              {phase.name === "capture" ? (
                <FaceCapture
                  key={phase.attempt}
                  steps={phase.steps}
                  onComplete={(frames) => void onFrames(phase.challengeId, frames)}
                />
              ) : (
                <div className="flex flex-col items-center gap-4 py-16">
                  <FullPageSpinner />
                  <p className="text-lg font-medium">Checking your face…</p>
                </div>
              )}
            </div>
          )}

          {phase.name === "success" && (
            <div className="flex flex-col items-center gap-3 py-16 text-center" data-testid="face-success">
              <CircleCheck className="h-14 w-14 text-success" aria-hidden />
              <p className="text-xl font-semibold">
                {enrolling ? "Face saved" : "Welcome back"}
              </p>
              <p className="text-sm text-muted">Opening your vault…</p>
            </div>
          )}

          {phase.name === "failed" && (
            <div
              className="mx-auto flex max-w-md flex-col items-center gap-4 rounded-2xl border border-border bg-surface p-8 text-center"
              data-testid="face-failed"
            >
              <CircleAlert className="h-12 w-12 text-danger" aria-hidden />
              <p className="font-semibold" data-testid="face-failed-message">
                {phase.message}
              </p>
              <Button onClick={() => void begin()} data-testid="face-retry">
                Try again
              </Button>
            </div>
          )}

          {phase.name === "locked" && (
            <div
              className="mx-auto flex max-w-md flex-col items-center gap-4 rounded-2xl border border-border bg-surface p-8 text-center"
              data-testid="face-locked"
            >
              <Lock className="h-12 w-12 text-warning" aria-hidden />
              <p className="font-semibold">{phase.message}</p>
              <Button variant="secondary" onClick={() => void signOut()}>
                Sign out
              </Button>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

function FaceRoute() {
  const params = useSearchParams();
  const reenroll = params.get("reenroll") === "1";
  return (
    <RouteGuard allow={reenroll ? ["verified"] : ["needsEnroll", "needsVerify"]}>
      <FaceCheck />
    </RouteGuard>
  );
}

export default function FacePage() {
  return (
    <Suspense fallback={<FullPageSpinner />}>
      <FaceRoute />
    </Suspense>
  );
}
