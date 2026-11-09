import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

// Prepares the fake webcam files. They are built from a private video of the
// account owner, which is deliberately kept outside the repository.
//
//   E2E_FACE_VIDEO  about 10 seconds of the owner looking at the camera and
//                   turning their head left and right
//                   (default: ~/facialrec-data/face_enroll.mov)

const media = path.join(__dirname, ".media");
const video =
  process.env.E2E_FACE_VIDEO ??
  path.join(homedir(), "facialrec-data", "face_enroll.mov");

function ffmpeg(args: string[]) {
  execFileSync("ffmpeg", ["-v", "error", "-y", ...args], { stdio: "inherit" });
}

export default function globalSetup() {
  mkdirSync(media, { recursive: true });

  const owner = path.join(media, "owner.mjpeg");
  const photoJpg = path.join(media, "photo.jpg");
  const photo = path.join(media, "photo.mjpeg");
  if (!existsSync(owner) || !existsSync(photo)) {
    if (!existsSync(video)) {
      throw new Error(`Face video not found at ${video}. Set E2E_FACE_VIDEO.`);
    }
    // The owner, live: the whole video as a webcam feed.
    ffmpeg(["-i", video, "-vf", "fps=30,scale=1280:720", "-c:v", "mjpeg", "-q:v", "4", "-f", "mjpeg", owner]);
    // A photo of the owner: one straight-on frame, frozen.
    ffmpeg(["-ss", "0.5", "-i", video, "-frames:v", "1", "-vf", "scale=1280:720", photoJpg]);
    ffmpeg(["-loop", "1", "-i", photoJpg, "-t", "3", "-r", "30", "-c:v", "mjpeg", "-q:v", "4", "-f", "mjpeg", photo]);
  }

  // Templates of a different person, used to enroll the "wrong owner" account.
  const impostor = path.join(media, "impostor.json");
  if (!existsSync(impostor)) {
    const service = path.join(__dirname, "..", "..", "face-service");
    execFileSync(
      path.join(service, ".venv", "bin", "python"),
      ["eval/embed_identity.py", impostor],
      { cwd: service, stdio: "inherit" },
    );
  }

  // A small video and image to upload.
  const clip = path.join(media, "clip.mp4");
  if (!existsSync(clip)) {
    ffmpeg(["-f", "lavfi", "-i", "testsrc=duration=1:size=320x240:rate=15", "-pix_fmt", "yuv420p", clip]);
  }
  const picture = path.join(media, "picture.png");
  if (!existsSync(picture)) {
    ffmpeg(["-f", "lavfi", "-i", "testsrc=size=320x240", "-frames:v", "1", picture]);
  }

  // One account shared by the projects in this run.
  const run = Date.now().toString(36);
  writeFileSync(
    path.join(media, "run.json"),
    JSON.stringify({
      owner: `owner-${run}@example.test`,
      impostor: `impostor-${run}@example.test`,
      password: `pw-${run}-${Math.random().toString(36).slice(2, 10)}`,
    }),
  );
}
