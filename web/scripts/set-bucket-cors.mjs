// Allows the website's origins to upload to and read from the Railway bucket
// directly from the browser. Buckets block cross-origin requests by default.
//
//   RAILWAY_BUCKET=files node scripts/set-bucket-cors.mjs https://your-site http://localhost:3000

import { execFileSync } from "node:child_process";
import { AwsClient } from "aws4fetch";

const origins = process.argv.slice(2);
if (origins.length === 0) {
  console.error("Pass at least one origin, e.g. https://example.com");
  process.exit(1);
}

const raw = execFileSync(
  "railway",
  ["bucket", "credentials", "--bucket", process.env.RAILWAY_BUCKET ?? "files", "--json"],
  { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
);
const parsed = JSON.parse(raw);
const creds = Array.isArray(parsed) ? parsed[0] : parsed;

const client = new AwsClient({
  accessKeyId: creds.accessKeyId,
  secretAccessKey: creds.secretAccessKey,
  region: creds.region,
  service: "s3",
});
const endpoint = new URL(creds.endpoint);
const base = /path/i.test(creds.urlStyle ?? "")
  ? `${endpoint.origin}/${creds.bucketName}`
  : `${endpoint.protocol}//${creds.bucketName}.${endpoint.host}`;

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<CORSConfiguration>
  <CORSRule>
${origins.map((o) => `    <AllowedOrigin>${o}</AllowedOrigin>`).join("\n")}
    <AllowedMethod>GET</AllowedMethod>
    <AllowedMethod>HEAD</AllowedMethod>
    <AllowedMethod>POST</AllowedMethod>
    <AllowedMethod>PUT</AllowedMethod>
    <AllowedHeader>*</AllowedHeader>
    <ExposeHeader>ETag</ExposeHeader>
    <MaxAgeSeconds>3000</MaxAgeSeconds>
  </CORSRule>
</CORSConfiguration>`;

const put = await client.fetch(`${base}/?cors`, { method: "PUT", body: xml });
console.log("PUT cors ->", put.status, put.ok ? "ok" : await put.text());
const get = await client.fetch(`${base}/?cors`);
console.log("current rules:", (await get.text()).replace(/\s+/g, " "));
process.exit(put.ok ? 0 : 1);
