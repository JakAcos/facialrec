import { defineConfig } from "@playwright/test";
import path from "node:path";

// Chrome can play a video file as if it were the webcam. That makes the
// face tests real camera tests: the page calls getUserMedia like it would
// for a person, and the frames flow through the whole stack.
const media = (name: string) => path.join(__dirname, "e2e", ".media", name);
const fakeCamera = (file: string) => ({
  args: [
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    `--use-file-for-fake-video-capture=${media(file)}`,
  ],
});

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    viewport: { width: 1280, height: 800 },
    video: "on",
    screenshot: "on",
    trace: "retain-on-failure",
  },
  projects: [
    {
      // A real person in front of the camera: enrolls, verifies, uses the vault.
      name: "owner",
      testMatch: /owner\.spec\.ts/,
      use: { launchOptions: fakeCamera("owner.mjpeg") },
    },
    {
      // A live person who is NOT the enrolled one.
      name: "impostor",
      testMatch: /impostor\.spec\.ts/,
      dependencies: ["owner"],
      use: { launchOptions: fakeCamera("owner.mjpeg") },
    },
    {
      // A still photo of the owner held up to the camera.
      name: "photo",
      testMatch: /photo\.spec\.ts/,
      dependencies: ["owner"],
      use: { launchOptions: fakeCamera("photo.mjpeg") },
    },
    {
      name: "cleanup",
      testMatch: /cleanup\.spec\.ts/,
      dependencies: ["impostor", "photo"],
      use: { launchOptions: fakeCamera("owner.mjpeg") },
    },
  ],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: "npm run build && npm run start -- -p 3000",
        url: "http://localhost:3000",
        reuseExistingServer: true,
        timeout: 180_000,
      },
});
