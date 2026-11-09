import { expect, test } from "@playwright/test";
import { listFilesDirectly, run, testLogin } from "./helpers";

// The webcam in this project shows one frozen frame of the real owner: the
// same thing as holding their photo up to the camera.

test("a photo of the owner cannot complete the head-turn challenge", async ({ page }) => {
  const { owner, password } = run();
  await testLogin(page, owner, password);
  await expect(page.getByTestId("face-title")).toHaveText("Verify it's you");

  const capture = page.getByTestId("face-capture");
  // The straight-on capture works, because the photo is a real face...
  await expect(capture).toHaveAttribute("data-step", /left|right/, { timeout: 30_000 });
  // ...but a photo cannot turn its head, so the check never completes.
  await page.waitForTimeout(12_000);
  await expect(capture).toHaveAttribute("data-step", /left|right/);
  await expect(page.getByTestId("face-hint")).toContainText("turn your head");
  await page.screenshot({ path: test.info().outputPath("photo-stuck.png") });
  expect(await listFilesDirectly(page)).toBe("FACE_NOT_VERIFIED");
});

test("skipping the browser checks does not help: the server rejects the photo", async ({ page }) => {
  const { owner, password } = run();
  // Break the in-browser face tracker, as an attacker with a modified page
  // could. The page falls back to manual capture and sends whatever the
  // camera shows.
  await page.route("**/mediapipe/**", (route) => route.abort());
  await testLogin(page, owner, password);

  const capture = page.getByTestId("face-capture");
  await expect(capture).toHaveAttribute("data-tracker", "manual", { timeout: 30_000 });
  await page.getByTestId("manual-capture").click();
  await expect(capture).toHaveAttribute("data-step", /left|right/);
  await page.getByTestId("manual-capture").click();

  await expect(page.getByTestId("face-failed-message")).toHaveText(
    "The head movement did not match the instructions. Try again and follow the prompts.",
    { timeout: 60_000 },
  );
  await page.screenshot({ path: test.info().outputPath("photo-rejected-by-server.png") });
  await page.goto("/vault");
  await page.waitForURL("**/face");
  expect(await listFilesDirectly(page)).toBe("FACE_NOT_VERIFIED");
});
