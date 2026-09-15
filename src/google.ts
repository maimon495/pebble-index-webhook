/**
 * Minimal Google Drive client for Cloudflare Workers: mints an access token
 * from a service-account key via the JWT bearer grant (RS256, signed with
 * Web Crypto — no Node APIs), then does a multipart upload.
 *
 * Scope is drive.file (least privilege): the service account can only see
 * files/folders explicitly shared with it, which is exactly the "Pebble
 * Voice Notes" folder — see docs/google-drive-setup.md.
 */

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id";
const FILES_URL = "https://www.googleapis.com/drive/v3/files";

export interface ServiceAccountKey {
  client_email: string;
  private_key: string;
}

const encoder = new TextEncoder();

function base64url(input: string | ArrayBuffer): string {
  const bytes = typeof input === "string" ? encoder.encode(input) : new Uint8Array(input);
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const base64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

// Cached in-isolate; Google tokens are valid for 1hr and re-minting per
// request would double every webhook's latency for no benefit.
let cachedToken: { value: string; expiresAt: number } | null = null;

/** Test-only: clears the in-isolate token cache so tests don't leak state into each other. */
export function resetTokenCacheForTests(): void {
  cachedToken = null;
}

export async function getAccessToken(key: ServiceAccountKey, now = Date.now()): Promise<string> {
  if (cachedToken && cachedToken.expiresAt - 60_000 > now) {
    return cachedToken.value;
  }

  const nowSec = Math.floor(now / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = base64url(
    JSON.stringify({
      iss: key.client_email,
      scope: DRIVE_SCOPE,
      aud: TOKEN_URL,
      iat: nowSec,
      exp: nowSec + 3600,
    }),
  );
  const signingInput = `${header}.${claim}`;

  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(key.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", cryptoKey, encoder.encode(signingInput));
  const jwt = `${signingInput}.${base64url(signature)}`;

  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!resp.ok) {
    throw new Error(`google token exchange failed: ${resp.status}`);
  }
  const data = (await resp.json()) as { access_token: string; expires_in: number };
  cachedToken = { value: data.access_token, expiresAt: now + data.expires_in * 1000 };
  return data.access_token;
}

/** True if a file with this exact name already exists in the folder (not trashed). */
export async function driveFileExists(accessToken: string, folderId: string, name: string): Promise<boolean> {
  const q = `name = '${name.replace(/'/g, "\\'")}' and '${folderId}' in parents and trashed = false`;
  const url = `${FILES_URL}?q=${encodeURIComponent(q)}&fields=files(id)&pageSize=1`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!resp.ok) {
    throw new Error(`drive lookup failed: ${resp.status}`);
  }
  const data = (await resp.json()) as { files: Array<{ id: string }> };
  return data.files.length > 0;
}

export async function driveUpload(
  accessToken: string,
  folderId: string,
  name: string,
  mimeType: string,
  content: ArrayBuffer | string,
): Promise<void> {
  const boundary = crypto.randomUUID();
  const metadata = JSON.stringify({ name, parents: [folderId] });
  const bodyContent = typeof content === "string" ? encoder.encode(content) : new Uint8Array(content);

  const parts: Uint8Array[] = [
    encoder.encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`),
    encoder.encode(`--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`),
    bodyContent,
    encoder.encode(`\r\n--${boundary}--`),
  ];
  const totalLength = parts.reduce((sum, p) => sum + p.byteLength, 0);
  const body = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    body.set(part, offset);
    offset += part.byteLength;
  }

  const resp = await fetch(UPLOAD_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": `multipart/related; boundary=${boundary}`,
    },
    body,
  });
  if (!resp.ok) {
    throw new Error(`drive upload failed: ${resp.status}`);
  }
}
