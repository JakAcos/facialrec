import { expect, test } from "@playwright/test";
import { unzipSync } from "fflate";
import { readFileSync, writeFileSync } from "node:fs";
import {
  convexSiteUrl,
  expectVaultUnlocked,
  item,
  itemAction,
  listFilesDirectly,
  media,
  requestUploadDirectly,
  run,
  testLogin,
} from "./helpers";

test("signed-out visitors cannot reach the vault or account pages", async ({ page }) => {
  for (const path of ["/vault", "/account", "/face"]) {
    await page.goto(path);
    await expect(page.getByTestId("google-sign-in")).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/");
  }
});

test("the Google button starts a real Google sign-in for this app", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("google-sign-in").click();
  await page.waitForURL(/accounts\.google\.com/, { timeout: 30_000 });
  // Google would show an error page here if the redirect URL were not registered.
  await expect(page.locator("body")).not.toContainText(/redirect_uri_mismatch|Error 400|invalid_client/i);
  await expect(page.locator("#identifierId")).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("google-sign-in.png") });
  const url = page.url();
  const redirect = `${convexSiteUrl()}/api/auth/callback/google`;
  expect(decodeURIComponent(decodeURIComponent(url))).toContain(redirect);
});

test("owner journey: enroll, use the vault, lock, and sign back in", async ({ page }) => {
  test.setTimeout(300_000);
  const { owner, password } = run();
  const textBody = `private notes ${owner}\n`;
  const notes = media("notes.txt");
  writeFileSync(notes, textBody);

  await test.step("sign in and land on face setup", async () => {
    await testLogin(page, owner, password);
    await expect(page.getByTestId("face-title")).toHaveText("Set up your face");
    // Signed in with the first factor only: the backend still refuses.
    expect(await listFilesDirectly(page)).toBe("FACE_NOT_VERIFIED");
  });

  await test.step("enroll with the guided camera (straight, left, right)", async () => {
    await page.getByTestId("face-start").click();
    const capture = page.getByTestId("face-capture");
    await expect(capture).toHaveAttribute("data-tracker", "ready", { timeout: 30_000 });
    await page.screenshot({ path: test.info().outputPath("01-enroll-camera.png") });
    await expectVaultUnlocked(page);
    await expect(page.getByTestId("empty-state")).toBeVisible();
    expect(await listFilesDirectly(page)).toBe("ALLOWED");
    await page.screenshot({ path: test.info().outputPath("02-empty-vault.png") });
  });

  await test.step("upload a photo, a video and a text file to the bucket", async () => {
    await page.getByTestId("file-input").setInputFiles([
      media("picture.png"),
      media("clip.mp4"),
      notes,
    ]);
    await expect(page.locator('[data-testid="upload-row"][data-status="done"]')).toHaveCount(3, { timeout: 60_000 });
    for (const name of ["picture.png", "clip.mp4", "notes.txt"]) {
      await expect(item(page, name)).toBeVisible();
    }
    await expect(page.getByTestId("storage-used")).not.toHaveText("0 B");
    // The image thumbnail is served straight from the Railway bucket.
    const thumb = item(page, "picture.png").locator("img");
    await expect(thumb).toBeVisible();
    await expect.poll(() => thumb.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(320);
    await page.screenshot({ path: test.info().outputPath("03-uploaded.png") });
  });

  await test.step("the bucket itself enforces the reserved upload size", async () => {
    // Ask the backend for an upload form for exactly 10 bytes, then talk to
    // the bucket directly, the way a modified client could.
    const form = await requestUploadDirectly(page, { name: "exact.bin", size: 10, contentType: "application/octet-stream" });
    const post = async (bytes: number) => {
      const body = new FormData();
      for (const [key, value] of Object.entries(form.fields)) body.append(key, value);
      body.append("file", new Blob([new Uint8Array(bytes)]));
      return (await fetch(form.url, { method: "POST", body })).status;
    };
    expect(await post(11)).toBeGreaterThanOrEqual(400); // one byte too many
    expect(await post(9)).toBeGreaterThanOrEqual(400); // one byte too few
    expect(await post(1024 * 1024)).toBeGreaterThanOrEqual(400); // far too many
    expect(await post(10)).toBeLessThan(300); // exactly what was reserved
    // Nothing was confirmed, so the vault does not list it.
    await expect(item(page, "exact.bin")).toHaveCount(0);
  });

  await test.step("preview files in place", async () => {
    await item(page, "notes.txt").getByRole("button", { name: "Open notes.txt" }).click();
    await expect(page.getByTestId("preview-text")).toHaveText(textBody.trim());
    await page.keyboard.press("Escape");

    await item(page, "clip.mp4").getByRole("button", { name: "Open clip.mp4" }).click();
    const video = page.getByTestId("preview-video");
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.videoWidth)).toBe(320);
    await page.screenshot({ path: test.info().outputPath("04-video-preview.png") });
    await page.keyboard.press("Escape");
  });

  await test.step("download returns the exact bytes that were uploaded", async () => {
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      itemAction(page, "notes.txt", "Download"),
    ]);
    expect(download.suggestedFilename()).toBe("notes.txt");
    expect(readFileSync(await download.path(), "utf8")).toBe(textBody);
  });

  await test.step("create a folder, rename a file and move files into it", async () => {
    await page.getByTestId("new-folder").click();
    await expect(page.getByTestId("name-input")).toBeFocused();
    await page.keyboard.type("Trip");
    await page.getByTestId("name-submit").click();
    await expect(item(page, "Trip")).toBeVisible();

    await itemAction(page, "notes.txt", "Rename");
    // The dialog pre-selects the name without its extension, so typing
    // replaces "notes" and keeps ".txt".
    await expect(page.getByTestId("name-input")).toBeFocused();
    await page.keyboard.type("journal");
    await expect(page.getByTestId("name-input")).toHaveValue("journal.txt");
    await page.getByTestId("name-submit").click();
    await expect(item(page, "journal.txt")).toBeVisible();
    await expect(item(page, "notes.txt")).toHaveCount(0);

    // Select two files and move them together.
    for (const name of ["journal.txt", "picture.png"]) {
      await item(page, name).hover();
      await item(page, name).getByTestId("select-item").click();
    }
    await page.getByTestId("bulk-move").click();
    await page.getByTestId("move-target").filter({ hasText: "Trip" }).click();
    await page.getByTestId("move-submit").click();
    await expect(item(page, "journal.txt")).toHaveCount(0);

    await item(page, "Trip").getByRole("button", { name: "Open Trip" }).click();
    await expect(page.getByTestId("vault-title")).toHaveText("Trip");
    await expect(page.getByTestId("breadcrumbs")).toContainText("Trip");
    await expect(item(page, "journal.txt")).toBeVisible();
    await expect(item(page, "picture.png")).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("05-folder.png") });
  });

  await test.step("download the folder as a zip built in the browser", async () => {
    await page.getByTestId("breadcrumbs").getByRole("button", { name: "Vault" }).click();
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      itemAction(page, "Trip", "Download as zip"),
    ]);
    expect(download.suggestedFilename()).toBe("Trip.zip");
    const entries = unzipSync(new Uint8Array(readFileSync(await download.path())));
    expect(Object.keys(entries).sort()).toEqual(["Trip/journal.txt", "Trip/picture.png"]);
    expect(Buffer.from(entries["Trip/journal.txt"]).toString()).toBe(textBody);
    expect(Buffer.from(entries["Trip/picture.png"])).toEqual(readFileSync(media("picture.png")));
  });

  await test.step("search, filter and list view", async () => {
    await page.getByTestId("search").fill("journal");
    await expect(item(page, "journal.txt")).toBeVisible();
    await expect(item(page, "clip.mp4")).toHaveCount(0);
    await page.getByTestId("search").fill("");

    await page.getByRole("button", { name: "Videos" }).click();
    await expect(item(page, "clip.mp4")).toBeVisible();
    await expect(item(page, "Trip")).toHaveCount(0);
    await page.getByRole("button", { name: "All", exact: true }).click();

    await page.getByTestId("view-list").click();
    await expect(item(page, "clip.mp4")).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("06-list-view.png") });
    await page.getByTestId("view-grid").click();
  });

  await test.step("delete a file", async () => {
    await itemAction(page, "clip.mp4", "Delete");
    await page.getByTestId("confirm-submit").click();
    await expect(item(page, "clip.mp4")).toHaveCount(0);
  });

  await test.step("account page shows the profile and storage", async () => {
    await page.getByRole("link", { name: "Account" }).click();
    await expect(page.getByTestId("account-email")).toHaveText(owner);
    await expect(page.getByTestId("account-used")).not.toHaveText("0 B");
    await page.screenshot({ path: test.info().outputPath("07-account.png"), fullPage: true });
  });

  await test.step("locking the vault needs the face again", async () => {
    await page.getByTestId("lock-vault").click();
    await page.waitForURL("**/face");
    await expect(page.getByTestId("face-title")).toHaveText("Verify it's you");
    expect(await listFilesDirectly(page)).toBe("FACE_NOT_VERIFIED");
    // Verification starts by itself: one straight look and one head turn.
    await expectVaultUnlocked(page);
    await expect(item(page, "Trip")).toBeVisible();
  });

  await test.step("signing out and back in needs the face again, and files persist", async () => {
    await page.getByTestId("sign-out").click();
    await expect(page.getByTestId("google-sign-in")).toBeVisible();
    await testLogin(page, owner, password);
    await expect(page.getByTestId("face-title")).toHaveText("Verify it's you");
    await expectVaultUnlocked(page);
    await item(page, "Trip").getByRole("button", { name: "Open Trip" }).click();
    await expect(item(page, "journal.txt")).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("08-signed-back-in.png") });
  });
});
