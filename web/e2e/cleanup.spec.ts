import { expect, test } from "@playwright/test";
import { convexRun, expectVaultUnlocked, run, testLogin } from "./helpers";

test("the owner can delete their account, files and face data", async ({ page }) => {
  const { owner, password } = run();
  await testLogin(page, owner, password);
  await expectVaultUnlocked(page);

  await page.getByRole("link", { name: "Account" }).click();
  await page.getByTestId("delete-account").click();
  await page.getByTestId("delete-confirm-input").fill("DELETE");
  await page.getByTestId("delete-confirm-submit").click();
  await expect(page.getByTestId("google-sign-in")).toBeVisible();

  // The same email now behaves like a brand new account: no face, no files.
  await testLogin(page, owner, password);
  await expect(page.getByTestId("face-title")).toHaveText("Set up your face");
});

test.afterAll(() => {
  convexRun("testing:purgeTestUsers", {});
});
