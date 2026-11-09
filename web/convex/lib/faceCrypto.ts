// AES-256-GCM encryption for face embeddings, using the Web Crypto API that
// the Convex runtime provides. The key lives in the FACE_ENC_KEY environment
// variable (base64, 32 bytes) and never reaches the browser or the database.

function b64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function loadKey(): Promise<CryptoKey> {
  const raw = process.env.FACE_ENC_KEY;
  if (!raw) throw new Error("FACE_ENC_KEY is not set");
  const bytes = b64ToBytes(raw);
  if (bytes.length !== 32) throw new Error("FACE_ENC_KEY must be 32 bytes");
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

export const EMBEDDING_DIM = 512;

/** Packs embeddings into one buffer and encrypts it. Output is iv (12 bytes) + ciphertext. */
export async function encryptTemplates(
  templates: number[][],
): Promise<ArrayBuffer> {
  const flat = new Float32Array(templates.length * EMBEDDING_DIM);
  templates.forEach((t, i) => {
    if (t.length !== EMBEDDING_DIM) throw new Error("Unexpected embedding size");
    flat.set(t, i * EMBEDDING_DIM);
  });
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await loadKey(),
    flat.buffer,
  );
  const out = new Uint8Array(12 + cipher.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(cipher), 12);
  return out.buffer;
}

export async function decryptTemplates(blob: ArrayBuffer): Promise<number[][]> {
  const bytes = new Uint8Array(blob);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytes.slice(0, 12) },
    await loadKey(),
    bytes.slice(12),
  );
  const flat = new Float32Array(plain);
  const out: number[][] = [];
  for (let i = 0; i < flat.length; i += EMBEDDING_DIM) {
    out.push(Array.from(flat.subarray(i, i + EMBEDDING_DIM)));
  }
  return out;
}
