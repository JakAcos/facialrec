// Sets the Convex environment variables this app needs, without ever
// printing a secret. Run from web/:
//
//   node scripts/setup-convex-env.mjs            (dev deployment)
//   node scripts/setup-convex-env.mjs --prod     (production deployment)
//
// Values that must stay stable (signing keys, the face encryption key) are
// only generated when missing, so running this twice is safe.
//
// Inputs:
//   SITE_URL                 where the website is served
//   FACE_SERVICE_URL         public URL of the face service
//   FACE_SERVICE_SECRET      shared secret (or FACE_SERVICE_SECRET_FILE)
//   GOOGLE_CLIENT_ID_FILE / GOOGLE_CLIENT_SECRET_FILE   optional
//   Bucket credentials are read from `railway bucket credentials`.

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { exportJWK, exportPKCS8, generateKeyPair } from "jose";

const prod = process.argv.includes("--prod");
const convex = "./node_modules/.bin/convex";
const target = prod ? ["--prod"] : [];

/**
 * Whether a variable already has a value. This asks for that one variable
 * and lets any error stop the script. Guessing "missing" from unexpected
 * output would regenerate the face encryption key, and every enrolled face
 * would become unreadable.
 */
function has(name) {
  const out = execFileSync(convex, ["env", "get", ...target, name], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return out.trim().length > 0;
}

// Values are handed over in a private temporary file, not on the command
// line, where other users of this machine could read them from `ps`.
const scratch = mkdtempSync(path.join(tmpdir(), "convex-env-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));

function set(name, value) {
  const file = path.join(scratch, "value");
  writeFileSync(file, value, { mode: 0o600 });
  try {
    // stdio is fully ignored so the value cannot end up in a log.
    execFileSync(convex, ["env", "set", ...target, name, "--from-file", file], {
      stdio: "ignore",
    });
  } finally {
    rmSync(file, { force: true });
  }
  console.log(`set ${name}`);
}

function fromFile(envName) {
  const path = process.env[envName];
  return path && existsSync(path) ? readFileSync(path, "utf8").trim() : null;
}

if (!has("JWT_PRIVATE_KEY") || !has("JWKS")) {
  const keys = await generateKeyPair("RS256", { extractable: true });
  const privateKey = await exportPKCS8(keys.privateKey);
  const publicKey = await exportJWK(keys.publicKey);
  set("JWT_PRIVATE_KEY", privateKey.trimEnd().replace(/\n/g, " "));
  set("JWKS", JSON.stringify({ keys: [{ use: "sig", ...publicKey }] }));
}

if (!has("FACE_ENC_KEY")) {
  set("FACE_ENC_KEY", randomBytes(32).toString("base64"));
}

if (process.env.SITE_URL) set("SITE_URL", process.env.SITE_URL);
if (!prod) set("ENABLE_TEST_LOGIN", "true");
set("S3_KEY_PREFIX", prod ? "prod/" : "dev/");

const googleId = fromFile("GOOGLE_CLIENT_ID_FILE");
const googleSecret = fromFile("GOOGLE_CLIENT_SECRET_FILE");
if (googleId) set("AUTH_GOOGLE_ID", googleId);
if (googleSecret) set("AUTH_GOOGLE_SECRET", googleSecret);

if (process.env.FACE_SERVICE_URL) {
  set("FACE_SERVICE_URL", process.env.FACE_SERVICE_URL);
}
const faceSecret =
  process.env.FACE_SERVICE_SECRET ?? fromFile("FACE_SERVICE_SECRET_FILE");
if (faceSecret) set("FACE_SERVICE_SECRET", faceSecret);

if (process.env.RAILWAY_BUCKET) {
  const raw = execFileSync(
    "railway",
    ["bucket", "credentials", "--bucket", process.env.RAILWAY_BUCKET, "--json"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );
  const parsed = JSON.parse(raw);
  const creds = Array.isArray(parsed) ? parsed[0] : parsed;
  set("S3_ENDPOINT", creds.endpoint);
  set("S3_BUCKET", creds.bucketName);
  set("S3_REGION", creds.region);
  set("S3_ACCESS_KEY_ID", creds.accessKeyId);
  set("S3_SECRET_ACCESS_KEY", creds.secretAccessKey);
  set("S3_URL_STYLE", /path/i.test(creds.urlStyle ?? "") ? "path" : "virtual");
}

console.log(`done (${prod ? "prod" : "dev"})`);
