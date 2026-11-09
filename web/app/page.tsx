"use client";

import { useAuthActions } from "@convex-dev/auth/react";
import { useQuery } from "convex/react";
import { CloudUpload, KeyRound, ScanFace, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Logo } from "@/components/logo";
import { RouteGuard } from "@/components/route-guard";
import { Button } from "@/components/ui/button";
import { api } from "@/convex/_generated/api";

function GoogleMark() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden>
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1z" />
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z" />
      <path fill="#FBBC05" d="M5.84 14.1a6.6 6.6 0 0 1 0-4.2V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84z" />
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1A11 11 0 0 0 2.18 7.06l3.66 2.84C6.71 7.3 9.14 5.38 12 5.38z" />
    </svg>
  );
}

/** Only rendered on deployments where the test login is switched on. */
function TestLogin() {
  const { signIn } = useAuthActions();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      // Sign in, or create the test account the first time.
      await signIn("password", { email, password, flow: "signIn" }).catch(() =>
        signIn("password", { email, password, flow: "signUp" }),
      );
    } catch {
      toast.error("Test login failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="w-full max-w-sm rounded-xl border border-dashed border-border p-4 text-sm">
      <summary className="cursor-pointer font-medium text-muted" data-testid="test-login-toggle">
        Test login (development only)
      </summary>
      <form onSubmit={submit} className="mt-3 flex flex-col gap-2">
        <input
          type="email"
          required
          placeholder="Email"
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          data-testid="test-email"
          className="h-10 rounded-lg border border-border bg-surface px-3"
        />
        <input
          type="password"
          required
          minLength={8}
          placeholder="Password (8+ characters)"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          data-testid="test-password"
          className="h-10 rounded-lg border border-border bg-surface px-3"
        />
        <Button type="submit" variant="secondary" loading={busy} data-testid="test-submit">
          Sign in with test account
        </Button>
      </form>
    </details>
  );
}

const STEPS = [
  {
    icon: KeyRound,
    title: "Sign in with Google",
    body: "No new password to remember. Your Google account proves who you are first.",
  },
  {
    icon: ScanFace,
    title: "Confirm it is really you",
    body: "A quick look at the camera and a head turn, so a stolen password alone does not open your files.",
  },
  {
    icon: CloudUpload,
    title: "Open your vault",
    body: "Upload, organise and preview your photos, videos and documents from any device.",
  },
];

function Landing() {
  const { signIn } = useAuthActions();
  const testLogin = useQuery(api.users.testLoginEnabled);
  const [busy, setBusy] = useState(false);

  const google = async () => {
    setBusy(true);
    try {
      await signIn("google", { redirectTo: "/face" });
    } catch {
      setBusy(false);
      toast.error("Could not start Google sign-in. Please try again.");
    }
  };

  return (
    <div className="flex flex-1 flex-col">
      <header className="mx-auto flex w-full max-w-5xl items-center justify-between px-6 py-5">
        <Logo className="text-lg" />
      </header>
      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col items-center px-6 pb-16 pt-10 sm:pt-20">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1 text-xs font-medium text-muted">
          <ShieldCheck className="h-3.5 w-3.5 text-success" aria-hidden />
          Two checks before anything opens
        </span>
        <h1 className="mt-5 max-w-2xl text-balance text-center text-4xl font-semibold tracking-tight sm:text-6xl">
          Your files, locked to your face.
        </h1>
        <p className="mt-5 max-w-xl text-pretty text-center text-lg text-muted">
          FacialRec is cloud storage that asks for your Google account and a
          live face check before it shows a single file.
        </p>
        <div className="mt-8 flex w-full flex-col items-center gap-4">
          <Button
            size="lg"
            onClick={google}
            loading={busy}
            data-testid="google-sign-in"
            className="w-full max-w-sm bg-foreground text-background hover:bg-foreground hover:opacity-90"
          >
            {!busy && <GoogleMark />}
            Continue with Google
          </Button>
          {testLogin && <TestLogin />}
        </div>

        <ol className="mt-16 grid w-full gap-4 sm:grid-cols-3">
          {STEPS.map((step, i) => (
            <li key={step.title} className="rounded-2xl border border-border bg-surface p-5">
              <div className="flex items-center gap-3">
                <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent-soft text-accent">
                  <step.icon className="h-5 w-5" aria-hidden />
                </span>
                <span className="text-xs font-medium text-muted">Step {i + 1}</span>
              </div>
              <h2 className="mt-4 font-semibold">{step.title}</h2>
              <p className="mt-1 text-sm text-muted">{step.body}</p>
            </li>
          ))}
        </ol>
      </main>
      <footer className="border-t border-border px-6 py-5 text-center text-xs text-muted">
        Camera frames are checked and then discarded. Only an encrypted face
        template is kept, and you can delete it at any time.
      </footer>
    </div>
  );
}

export default function HomePage() {
  return (
    <RouteGuard allow={["signedOut"]}>
      <Landing />
    </RouteGuard>
  );
}
