"use client";

import { useAuthActions } from "@convex-dev/auth/react";
import { useMutation, useQuery } from "convex/react";
import { Lock, LogOut, ScanFace, ShieldCheck, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { AppShell } from "@/components/app-shell";
import { RouteGuard } from "@/components/route-guard";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { api } from "@/convex/_generated/api";
import { errorMessage, formatBytes, formatDate } from "@/lib/utils";
import { useSession } from "@/lib/use-session";

const KIND_COLORS: Record<string, string> = {
  Images: "#10b981",
  Videos: "#f43f5e",
  Audio: "#f59e0b",
  Documents: "#6366f1",
  Other: "#94a3b8",
};

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-border bg-surface p-5 sm:p-6">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">{title}</h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function Account() {
  const router = useRouter();
  const { me, face } = useSession();
  const usage = useQuery(api.files.usage);
  const { signOut } = useAuthActions();
  const lock = useMutation(api.face.lock);
  const deleteAccount = useMutation(api.users.deleteAccount);
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState("");
  const [deleting, setDeleting] = useState(false);

  const initial = (me?.name ?? me?.email ?? "?").trim().charAt(0).toUpperCase();
  const used = usage?.used ?? 0;
  const limit = usage?.limit ?? 1;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
      <h1 className="text-2xl font-semibold tracking-tight">Account</h1>

      <Section title="Profile">
        <div className="flex items-center gap-4">
          {me?.image ? (
            // eslint-disable-next-line @next/next/no-img-element -- external Google avatar
            <img src={me.image} alt="" referrerPolicy="no-referrer" className="h-14 w-14 rounded-full border border-border" />
          ) : (
            <span className="flex h-14 w-14 items-center justify-center rounded-full bg-accent-soft text-xl font-semibold text-accent">
              {initial}
            </span>
          )}
          <div className="min-w-0">
            <p className="truncate font-semibold" data-testid="account-name">{me?.name ?? me?.email ?? "Your account"}</p>
            <p className="truncate text-sm text-muted" data-testid="account-email">{me?.email}</p>
            {me && <p className="text-xs text-muted">Joined {formatDate(me.joinedAt)}</p>}
          </div>
          <Button variant="secondary" size="sm" className="ml-auto" onClick={() => void signOut()}>
            <LogOut className="h-4 w-4" aria-hidden />
            Sign out
          </Button>
        </div>
      </Section>

      <Section title="Storage">
        <div className="flex items-baseline justify-between">
          <p className="text-2xl font-semibold" data-testid="account-used">{formatBytes(used)}</p>
          <p className="text-sm text-muted">
            of {formatBytes(limit)} · {usage?.fileCount ?? 0} file{usage?.fileCount === 1 ? "" : "s"}
          </p>
        </div>
        <div className="mt-3 flex h-3 overflow-hidden rounded-full bg-surface-2" role="img" aria-label="Storage by file type">
          {usage?.byKind.map((k) => (
            <div
              key={k.kind}
              style={{ width: `${(k.bytes / limit) * 100}%`, background: KIND_COLORS[k.kind] ?? KIND_COLORS.Other }}
              title={`${k.kind}: ${formatBytes(k.bytes)}`}
            />
          ))}
        </div>
        {usage && usage.byKind.length > 0 ? (
          <ul className="mt-4 grid gap-2 sm:grid-cols-2">
            {usage.byKind.map((k) => (
              <li key={k.kind} className="flex items-center gap-2 text-sm">
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: KIND_COLORS[k.kind] ?? KIND_COLORS.Other }} />
                <span>{k.kind}</span>
                <span className="ml-auto text-muted">
                  {formatBytes(k.bytes)} · {k.count} file{k.count === 1 ? "" : "s"}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-4 text-sm text-muted">Nothing stored yet.</p>
        )}
      </Section>

      <Section title="Face check">
        <div className="flex flex-wrap items-center gap-4">
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-success-soft text-success">
            <ShieldCheck className="h-6 w-6" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <p className="font-medium">Your face is enrolled</p>
            <p className="text-sm text-muted">
              {face?.enrolledAt ? `Last updated ${formatDate(face.enrolledAt)}. ` : ""}
              Stored as an encrypted template, never as a photo.
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={() => router.push("/face?reenroll=1")} data-testid="reenroll">
              <ScanFace className="h-4 w-4" aria-hidden />
              Replace face
            </Button>
            <Button variant="secondary" size="sm" onClick={() => void lock()}>
              <Lock className="h-4 w-4" aria-hidden />
              Lock now
            </Button>
          </div>
        </div>
        {face?.verifiedUntil && (
          <p className="mt-4 text-xs text-muted">
            This session stays unlocked until{" "}
            {new Date(face.verifiedUntil).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}.
          </p>
        )}
      </Section>

      <Section title="Danger zone">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="max-w-md text-sm text-muted">
            Delete your account, every file in your vault and your face template. This cannot be undone.
          </p>
          <Button variant="danger" size="sm" onClick={() => setConfirming(true)} data-testid="delete-account">
            <Trash2 className="h-4 w-4" aria-hidden />
            Delete account
          </Button>
        </div>
      </Section>

      <Dialog open={confirming} onClose={() => setConfirming(false)} title="Delete your account?" testId="delete-dialog">
        <p className="text-sm text-muted">
          Type <span className="font-mono font-semibold text-foreground">DELETE</span> to confirm. All files and face data are removed permanently.
        </p>
        <input
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          aria-label="Type DELETE to confirm"
          data-autofocus
          data-testid="delete-confirm-input"
          className="mt-4 h-11 w-full rounded-lg border border-border bg-background px-3 font-mono"
        />
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={typed !== "DELETE"}
            loading={deleting}
            data-testid="delete-confirm-submit"
            onClick={async () => {
              setDeleting(true);
              try {
                await deleteAccount({ confirm: "DELETE" });
                toast.success("Account deleted");
                await signOut().catch(() => undefined);
                router.replace("/");
              } catch (error) {
                toast.error(errorMessage(error));
                setDeleting(false);
              }
            }}
          >
            Delete everything
          </Button>
        </div>
      </Dialog>
    </div>
  );
}

export default function AccountPage() {
  return (
    <RouteGuard allow={["verified"]}>
      <AppShell>
        <Account />
      </AppShell>
    </RouteGuard>
  );
}
