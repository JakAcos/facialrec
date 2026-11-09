import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { convexRun, listFilesDirectly, media, run, testLogin } from "./helpers";

test("a live person who is not the enrolled owner is rejected", async ({ page }) => {
  const { impostor, password } = run();
  const { templates } = JSON.parse(readFileSync(media("impostor.json"), "utf8"));

  // A brand new account...
  await testLogin(page, impostor, password);
  await expect(page.getByTestId("face-title")).toHaveText("Set up your face");

  // ...whose enrolled face belongs to someone else (a public LFW identity).
  convexRun("testing:seedFaceProfile", { email: impostor, templates });

  // The page notices the enrollment and starts a normal verification. The
  // webcam shows a real, moving person, so liveness passes. Only the
  // identity is wrong.
  await expect(page.getByTestId("face-title")).toHaveText("Verify it's you");
  await expect(page.getByTestId("face-failed-message")).toHaveText(
    "This face does not match the one enrolled for this account.",
    { timeout: 60_000 },
  );
  await page.screenshot({ path: test.info().outputPath("impostor-rejected.png") });

  // Still locked, both in the UI and when asking the backend directly.
  await page.goto("/vault");
  await page.waitForURL("**/face");
  expect(await listFilesDirectly(page)).toBe("FACE_NOT_VERIFIED");
});
