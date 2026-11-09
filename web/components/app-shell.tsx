"use client";

import { useAuthActions } from "@convex-dev/auth/react";
import { useMutation } from "convex/react";
import { FolderLock, Lock, LogOut, UserRound } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Logo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { api } from "@/convex/_generated/api";
import { cn } from "@/lib/utils";
import { useSession } from "@/lib/use-session";

const NAV = [
  { href: "/vault", label: "Vault", icon: FolderLock },
  { href: "/account", label: "Account", icon: UserRound },
];

/** Header and navigation shared by the signed-in pages. */
export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { me } = useSession();
  const { signOut } = useAuthActions();
  const lock = useMutation(api.face.lock);
  const initial = (me?.name ?? me?.email ?? "?").trim().charAt(0).toUpperCase();

  return (
    <div className="flex flex-1 flex-col">
      <header className="sticky top-0 z-30 border-b border-border bg-background/85 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-2 px-4 sm:gap-6 sm:px-6">
          <Link href="/vault" aria-label="FacialRec home">
            <Logo />
          </Link>
          <nav className="flex items-center gap-1">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                aria-current={pathname.startsWith(item.href) ? "page" : undefined}
                className={cn(
                  "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium",
                  pathname.startsWith(item.href)
                    ? "bg-surface-2 text-foreground"
                    : "text-muted hover:text-foreground",
                )}
              >
                <item.icon className="h-4 w-4" aria-hidden />
                <span className="hidden sm:inline">{item.label}</span>
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void lock()}
              title="Lock the vault without signing out"
              data-testid="lock-vault"
            >
              <Lock className="h-4 w-4" aria-hidden />
              <span className="hidden sm:inline">Lock</span>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void signOut()}
              data-testid="sign-out"
            >
              <LogOut className="h-4 w-4" aria-hidden />
              <span className="hidden sm:inline">Sign out</span>
            </Button>
            {me?.image ? (
              // eslint-disable-next-line @next/next/no-img-element -- external Google avatar
              <img
                src={me.image}
                alt=""
                referrerPolicy="no-referrer"
                className="ml-1 h-8 w-8 rounded-full border border-border"
              />
            ) : (
              <span className="ml-1 flex h-8 w-8 items-center justify-center rounded-full bg-accent-soft text-sm font-semibold text-accent">
                {initial}
              </span>
            )}
          </div>
        </div>
      </header>
      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-4 py-6 sm:px-6">
        {children}
      </main>
    </div>
  );
}
