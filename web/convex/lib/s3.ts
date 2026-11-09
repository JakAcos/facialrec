// Minimal S3 client for the Railway bucket. Convex never moves file bytes
// itself: it only signs short-lived URLs, and the browser talks to the bucket
// directly. That keeps uploads fast and avoids any server memory limits.

import { AwsClient } from "aws4fetch";

type S3Config = {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  virtualHosted: boolean;
};

function config(): S3Config {
  const env = (name: string) => {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is not set`);
    return value;
  };
  return {
    endpoint: env("S3_ENDPOINT").replace(/\/$/, ""),
    bucket: env("S3_BUCKET"),
    region: process.env.S3_REGION || "auto",
    accessKeyId: env("S3_ACCESS_KEY_ID"),
    secretAccessKey: env("S3_SECRET_ACCESS_KEY"),
    virtualHosted: (process.env.S3_URL_STYLE || "virtual") !== "path",
  };
}

function bucketUrl(c: S3Config): string {
  const u = new URL(c.endpoint);
  return c.virtualHosted
    ? `${u.protocol}//${c.bucket}.${u.host}`
    : `${u.protocol}//${u.host}/${c.bucket}`;
}

function objectUrl(c: S3Config, key: string): string {
  return `${bucketUrl(c)}/${key.split("/").map(encodeURIComponent).join("/")}`;
}

function client(c: S3Config): AwsClient {
  return new AwsClient({
    accessKeyId: c.accessKeyId,
    secretAccessKey: c.secretAccessKey,
    region: c.region,
    service: "s3",
  });
}

/** A temporary link that lets the browser read one object. */
export async function presignGet(
  key: string,
  opts: { expiresIn: number; downloadName?: string; contentType?: string },
): Promise<string> {
  const c = config();
  const url = new URL(objectUrl(c, key));
  url.searchParams.set("X-Amz-Expires", String(opts.expiresIn));
  if (opts.downloadName) {
    url.searchParams.set(
      "response-content-disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(opts.downloadName)}`,
    );
  }
  if (opts.contentType) {
    url.searchParams.set("response-content-type", opts.contentType);
  }
  const signed = await client(c).sign(url.toString(), {
    method: "GET",
    aws: { signQuery: true },
  });
  return signed.url;
}

const encoder = new TextEncoder();

async function hmac(key: BufferSource, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", k, encoder.encode(data));
}

function hex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * A signed browser upload form (S3 "POST policy"). Unlike a plain presigned
 * PUT, the policy lets the bucket itself enforce the maximum size, so a
 * client cannot upload more than its remaining quota.
 */
export async function presignPost(
  key: string,
  opts: { expiresIn: number; maxBytes: number; contentType: string },
): Promise<{ url: string; fields: Record<string, string> }> {
  const c = config();
  const now = new Date();
  const amzDate = now.toISOString().replace(/[-:]|\.\d{3}/g, "");
  const day = amzDate.slice(0, 8);
  const credential = `${c.accessKeyId}/${day}/${c.region}/s3/aws4_request`;

  const policy = {
    expiration: new Date(now.getTime() + opts.expiresIn * 1000).toISOString(),
    conditions: [
      { bucket: c.bucket },
      { key },
      { "Content-Type": opts.contentType },
      ["content-length-range", 0, opts.maxBytes],
      { "x-amz-algorithm": "AWS4-HMAC-SHA256" },
      { "x-amz-credential": credential },
      { "x-amz-date": amzDate },
    ],
  };
  const policyB64 = btoa(JSON.stringify(policy));

  let signingKey = await hmac(encoder.encode(`AWS4${c.secretAccessKey}`), day);
  for (const part of [c.region, "s3", "aws4_request"]) {
    signingKey = await hmac(signingKey, part);
  }
  const signature = hex(await hmac(signingKey, policyB64));

  return {
    url: bucketUrl(c),
    fields: {
      key,
      "Content-Type": opts.contentType,
      "x-amz-algorithm": "AWS4-HMAC-SHA256",
      "x-amz-credential": credential,
      "x-amz-date": amzDate,
      policy: policyB64,
      "x-amz-signature": signature,
    },
  };
}

/** Size of an uploaded object in bytes, or null if it does not exist. */
export async function headObject(key: string): Promise<number | null> {
  const c = config();
  const res = await client(c).fetch(objectUrl(c, key), { method: "HEAD" });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Bucket HEAD failed with ${res.status}`);
  return Number(res.headers.get("content-length") ?? 0);
}

export async function deleteObject(key: string): Promise<void> {
  const c = config();
  const res = await client(c).fetch(objectUrl(c, key), { method: "DELETE" });
  if (!res.ok && res.status !== 404) {
    throw new Error(`Bucket DELETE failed with ${res.status}`);
  }
}
