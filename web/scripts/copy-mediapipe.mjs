// Copies the MediaPipe WebAssembly runtime into public/ so the site serves
// it itself instead of depending on a third-party CDN at login time.
import { cpSync, mkdirSync } from "node:fs";

mkdirSync("public/mediapipe/wasm", { recursive: true });
cpSync("node_modules/@mediapipe/tasks-vision/wasm", "public/mediapipe/wasm", {
  recursive: true,
});
console.log("copied MediaPipe wasm to public/mediapipe/wasm");
