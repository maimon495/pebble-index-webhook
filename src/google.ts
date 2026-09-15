/**
 * Minimal Google Drive client for Cloudflare Workers: mints an access token
 * from a user OAuth refresh token, then does a multipart upload.
 *
 * A service account was tried first and doesn't work here: service accounts
 * have zero storage quota on a personal (non-Workspace) Google account, so
 * every file.create 403s with "Service Accounts do not have storage quota"
 * even inside a folder explicitly shared with them — see
 * docs/google-drive-setup.md. User OAuth creates files under the real
 * account's own quota instead.
 */

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id";
const FILES_URL = "https://www.googleapis.com/drive/v3/files";

export interface OAuthCredentials {
  client_id: string;
  client_secret: string;
  refresh_token: string;
}

const encoder = new TextEncoder();

// Cached in-isolate; access tokens are valid for 1hr and re-minting per
// request would double every webhook's latency for no benefit.
let cachedToken: { value: string; expiresAt: number } | null = null;

/** Test-only: clears the in-isolate token cache so tests don't leak state into each other. */
export function resetTokenCacheForTests(): void {
  cachedToken = null;
}

export async function getAccessToken(creds: OAuthCredentials, now = Date.now()): Promise<string> {
  if (cachedToken && cachedToken.expiresAt - 60_000 > now) {
    return cachedToken.value;
  }

  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: creds.client_id,
      client_secret: creds.client_secret,
      refresh_token: creds.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  if (!resp.ok) {
    // The consent screen is in "Testing" status (no hosted privacy policy to
    // publish for a single-user tool), so Google expires this refresh token
    // after 7 days — this is the expected failure mode when that happens.
    // See docs/google-drive-setup.md for the re-authorization steps.
    const detail = await resp.text().catch(() => "");
    throw new Error(`google token exchange failed: ${resp.status} ${detail}`);
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
    // Google's structured error body (reason codes etc.) — safe to include,
    // contains no user content.
    const detail = await resp.text().catch(() => "");
    throw new Error(`drive upload failed: ${resp.status} ${detail}`);
  }
}
