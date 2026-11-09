import { expect, type Page } from "@playwright/test";
import { ConvexHttpClient } from "convex/browser";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { api } from "../convex/_generated/api";

export const media = (name: string) => path.join(__dirname, ".media", name);

export const run = (): { owner: string; impostor: string; password: string } =>
  JSON.parse(readFileSync(media("run.json"), "utf8"));

function envLocal(name: string): string {
  const file = readFileSync(path.join(__dirname, "..", ".env.local"), "utf8");
  const match = file.match(new RegExp(`^${name}=(.+)$`, "m"));
  if (!match) throw new Error(`${name} missing from .env.local`);
  return match[1].trim();
}
export const convexUrl = () => envLocal("NEXT_PUBLIC_CONVEX_URL");
export const convexSiteUrl = () => envLocal("NEXT_PUBLIC_CONVEX_SITE_URL");

/** Runs an internal Convex function with admin rights, like `npx convex run`. */
export function convexRun(fn: string, args: unknown): string {
  return execFileSync(
    path.join(__dirname, "..", "node_modules", ".bin", "convex"),
    ["run", fn, JSON.stringify(args)],
    { cwd: path.join(__dirname, ".."), encoding: "utf8" },
  );
}

/** Signs in with the test-only password login (dev deployment only). */
export async function testLogin(page: Page, email: string, password: string) {
  await page.goto("/");
  await page.getByTestId("test-login-toggle").click();
  await page.getByTestId("test-email").fill(email);
  await page.getByTestId("test-password").fill(password);
  await page.getByTestId("test-submit").click();
  await page.waitForURL("**/face");
}

/** Waits for the guided camera to finish and the vault to open. */
export async function expectVaultUnlocked(page: Page) {
  await page.waitForURL("**/vault", { timeout: 60_000 });
  await expect(page.getByTestId("vault-title")).toBeVisible();
}

/**
 * Asks the backend for the file list using this browser's own login token,
 * bypassing the UI completely. This is what an attacker with a stolen
 * session would do.
 */
export async function listFilesDirectly(page: Page): Promise<string> {
  const token = await loginToken(page);
  if (!token) return "NO_TOKEN";
  const client = new ConvexHttpClient(convexUrl());
  client.setAuth(token);
  try {
    await client.query(api.files.list, {});
    return "ALLOWED";
  } catch (error) {
    const text = String((error as { data?: unknown }).data ?? error);
    const data = (error as { data?: { code?: string } }).data;
    return data?.code ?? text;
  }
}

async function loginToken(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)!;
      if (key.startsWith("__convexAuthJWT")) return localStorage.getItem(key);
    }
    return null;
  });
}

/** Requests a signed upload form with this browser's login, bypassing the UI. */
export async function requestUploadDirectly(
  page: Page,
  file: { name: string; size: number; contentType: string },
) {
  const token = await loginToken(page);
  if (!token) throw new Error("not signed in");
  const client = new ConvexHttpClient(convexUrl());
  client.setAuth(token);
  return await client.action(api.files.requestUpload, file);
}

export function item(page: Page, name: string) {
  return page.locator(`[data-testid="item"][data-name="${name}"]`);
}

export async function itemAction(page: Page, name: string, action: string) {
  await item(page, name).getByRole("button", { name: `Actions for ${name}` }).click();
  await page.getByRole("menuitem", { name: action }).click();
}
