import { expect, test } from "@playwright/test";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";

// Checks that are safe to run against the live production site. Production
// has no test login, so these only cover what an outsider can reach.
//
//   E2E_BASE_URL=https://your-site E2E_CONVEX_URL=https://<prod>.convex.cloud \
//     npx playwright test --project=smoke

const convexUrl = process.env.E2E_CONVEX_URL;
test.skip(!convexUrl, "E2E_CONVEX_URL is not set");

function code(error: unknown): string {
  return (error as { data?: { code?: string } }).data?.code ?? String(error);
}

test("the site loads and offers only Google sign-in", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(page.getByTestId("google-sign-in")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Your files, locked to your face.");
  // Give the "is test login enabled" query time to answer before asserting it is absent.
  await page.waitForTimeout(3000);
  await expect(page.getByTestId("test-login-toggle")).toHaveCount(0);
  expect(errors).toEqual([]);
  await page.screenshot({ path: test.info().outputPath("production-landing.png") });
});

test("protected pages send signed-out visitors to sign-in", async ({ page }) => {
  for (const path of ["/vault", "/account", "/face"]) {
    await page.goto(path);
    await expect(page.getByTestId("google-sign-in")).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/");
  }
});

test("Google sign-in is wired to the production backend", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("google-sign-in").click();
  await page.waitForURL(/accounts\.google\.com/, { timeout: 30_000 });
  await expect(page.locator("body")).not.toContainText(/redirect_uri_mismatch|Error 400|invalid_client/i);
  await expect(page.locator("#identifierId")).toBeVisible();
  const site = convexUrl!.replace(".convex.cloud", ".convex.site");
  expect(decodeURIComponent(decodeURIComponent(page.url()))).toContain(`${site}/api/auth/callback/google`);
  await page.screenshot({ path: test.info().outputPath("production-google.png") });
});

test("the production backend refuses anonymous access and the test login", async () => {
  const client = new ConvexHttpClient(convexUrl!);
  expect(await client.query(api.users.testLoginEnabled, {})).toBe(false);
  expect(await client.query(api.users.me, {})).toBeNull();
  expect(code(await client.query(api.files.list, {}).catch((e) => e))).toBe("UNAUTHENTICATED");
  expect(code(await client.mutation(api.face.startChallenge, {}).catch((e) => e))).toBe("UNAUTHENTICATED");

  // The password provider is not registered in production at all.
  const attempt = await client
    .action(api.auth.signIn, {
      provider: "password",
      params: { email: "nobody@example.test", password: "password-123", flow: "signUp" },
    })
    .then(() => "ALLOWED")
    .catch(() => "REFUSED");
  expect(attempt).toBe("REFUSED");
});
