/**
 * Pebble Index 01 -> Google Drive receiver.
 *
 * Receives the Pebble app's native webhook (multipart/form-data) and persists
 * the recording (audio and/or transcription, per the app's payload mode) to a
 * Google Drive folder. See docs/INDEX_WEBHOOK_API.md for the request format
 * this implements, and the top-level README for the response contract the
 * app's retry behavior depends on:
 *
 *   - 200 only once the note is durably persisted to Drive
 *   - 5xx on any persistence failure, so the app retries on the next recording
 *   - 401 on bad auth (constant-time comparison)
 *   - test events (X-Index-Test / test=true): 200, but never filed as a note
 */

import { isAuthorized } from "./auth";
import { recordingKey } from "./dedupe";
import { driveFileExists, driveUpload, getAccessToken } from "./google";

export interface Env {
  /** Token the Pebble app sends in its Authorization header. */
  PEBBLE_AUTH_TOKEN: string;
  /** Drive folder ID to upload into (in the account that authorized GOOGLE_OAUTH_REFRESH_TOKEN). */
  DRIVE_FOLDER_ID: string;
  /** OAuth client ID (Desktop app type) from Google Cloud Console. */
  GOOGLE_OAUTH_CLIENT_ID: string;
  /** OAuth client secret matching GOOGLE_OAUTH_CLIENT_ID. */
  GOOGLE_OAUTH_CLIENT_SECRET: string;
  /** Refresh token from the one-time authorization — see docs/google-drive-setup.md. */
  GOOGLE_OAUTH_REFRESH_TOKEN: string;
}

// Far above any real voice memo (~1KB/min of speech), bounds what a leaked
// Pebble token can push into Drive.
const MAX_TRANSCRIPTION_CHARS = 64_000;
// A 5-minute mono 16kHz AAC-LC recording is roughly 2-3MB; 25MB is a generous
// ceiling that still bounds a leaked-token abuse case.
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function isTestEvent(request: Request, form: FormData): boolean {
  if (request.headers.get("X-Index-Test") === "true") return true;
  if (request.headers.get("X-Index-Trigger") === "test-event") return true;
  return form.get("test") === "true";
}

function html(body: string): Response {
  return new Response(body, { headers: { "Content-Type": "text/html; charset=UTF-8" } });
}

// Static pages exist only so the Google OAuth consent screen can be
// published to Production (it requires a home page / privacy policy /
// terms link) — this Worker has no other public-facing purpose.
const HOME_PAGE = `<!doctype html><meta charset="utf-8"><title>Pebble Index Webhook</title>
<h1>Pebble Index Webhook</h1>
<p>A private, single-user integration that receives voice-note webhooks from
one person's Pebble Index 01 ring and saves them to that same person's own
Google Drive. It is not a public product, has no other users, and accepts
no sign-ups.</p>
<p><a href="/privacy">Privacy policy</a> &middot; <a href="/terms">Terms of service</a></p>`;

const PRIVACY_PAGE = `<!doctype html><meta charset="utf-8"><title>Privacy Policy — Pebble Index Webhook</title>
<h1>Privacy Policy</h1>
<p>This service is a personal integration built and operated by one individual
for their own use. It is not offered to the public.</p>
<p>It receives audio and/or text transcriptions POSTed from that individual's
own Pebble Index 01 ring/app, and writes them directly to that same
individual's own Google Drive, using a Google OAuth grant that individual
gave to their own Google Cloud project. No data is shared with, sold to, or
processed by any third party. No data is retained by this service itself —
each request is written to Drive and the request is discarded; nothing is
logged except an event name, a non-reversible dedupe key, and timing, never
the transcription or audio content (see the source at the project's git
repository).</p>`;

const TERMS_PAGE = `<!doctype html><meta charset="utf-8"><title>Terms of Service — Pebble Index Webhook</title>
<h1>Terms of Service</h1>
<p>This service has a single authorized user and is not available for
general use, registration, or sign-up. It is provided as-is, with no
uptime or support guarantees, for that one person's personal use only.</p>`;

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return html(HOME_PAGE);
    }
    if (url.pathname === "/privacy") {
      return html(PRIVACY_PAGE);
    }
    if (url.pathname === "/terms") {
      return html(TERMS_PAGE);
    }
    if (url.pathname === "/health") {
      return json(200, { ok: true });
    }
    if (url.pathname !== "/index-webhook") {
      return json(404, { ok: false, error: "not found" });
    }
    if (request.method !== "POST") {
      return json(405, { ok: false, error: "method not allowed; POST /index-webhook" });
    }

    const missing = (
      [
        "PEBBLE_AUTH_TOKEN",
        "DRIVE_FOLDER_ID",
        "GOOGLE_OAUTH_CLIENT_ID",
        "GOOGLE_OAUTH_CLIENT_SECRET",
        "GOOGLE_OAUTH_REFRESH_TOKEN",
      ] as const
    ).filter((name) => !env[name]);
    if (missing.length > 0) {
      return json(500, { ok: false, error: `worker misconfigured: missing secrets ${missing.join(", ")}` });
    }

    if (!isAuthorized(request.headers.get("Authorization"), env.PEBBLE_AUTH_TOKEN)) {
      return json(401, { ok: false, error: "unauthorized" });
    }

    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return json(415, { ok: false, error: "expected multipart/form-data (Pebble webhook format)" });
    }

    if (isTestEvent(request, form)) {
      console.log(JSON.stringify({ event: "test_event_received" }));
      return json(200, { ok: true, test: true });
    }

    const audio = form.get("audio");
    const audioFile = audio instanceof File ? audio : null;
    const transcriptionRaw = form.get("transcription");
    const transcription = typeof transcriptionRaw === "string" ? transcriptionRaw : null;

    if (!audioFile && !transcription) {
      return json(422, {
        ok: false,
        error: "payload has neither audio nor transcription — check the webhook's payload mode in Pebble settings",
      });
    }
    if (transcription && transcription.length > MAX_TRANSCRIPTION_CHARS) {
      return json(413, { ok: false, error: `transcription too large (max ${MAX_TRANSCRIPTION_CHARS} characters)` });
    }
    if (audioFile && audioFile.size > MAX_AUDIO_BYTES) {
      return json(413, { ok: false, error: `audio too large (max ${MAX_AUDIO_BYTES} bytes)` });
    }

    const recordedAtRaw = form.get("recordedAt");
    const recordedAtMs =
      typeof recordedAtRaw === "string" && /^\d+$/.test(recordedAtRaw) ? Number(recordedAtRaw) : Date.now();

    const key = await recordingKey(audioFile?.name ?? null, recordedAtMs, transcription ?? "");
    const base = `${recordedAtMs}_${key}`;
    const audioName = `${base}.m4a`;
    const textName = `${base}.txt`;

    const started = Date.now();
    try {
      const accessToken = await getAccessToken({
        client_id: env.GOOGLE_OAUTH_CLIENT_ID,
        client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET,
        refresh_token: env.GOOGLE_OAUTH_REFRESH_TOKEN,
      });

      // Idempotency: a retried delivery (e.g. app retries on next recording
      // after our 5xx) must not create a duplicate file.
      const primaryName = audioFile ? audioName : textName;
      if (await driveFileExists(accessToken, env.DRIVE_FOLDER_ID, primaryName)) {
        console.log(JSON.stringify({ event: "already_persisted", key, ms: Date.now() - started }));
        return json(200, { ok: true, deduped: true });
      }

      const uploads: Promise<void>[] = [];
      if (audioFile) {
        uploads.push(driveUpload(accessToken, env.DRIVE_FOLDER_ID, audioName, "audio/mp4", await audioFile.arrayBuffer()));
      }
      if (transcription) {
        uploads.push(driveUpload(accessToken, env.DRIVE_FOLDER_ID, textName, "text/plain", transcription));
      }
      await Promise.all(uploads);

      // Never log transcription contents; status + latency only.
      console.log(JSON.stringify({ event: "persisted", key, ms: Date.now() - started }));
      return json(200, { ok: true });
    } catch (err) {
      console.log(
        JSON.stringify({ event: "persist_failed", key, ms: Date.now() - started, error: (err as Error).message }),
      );
      return json(502, { ok: false, error: "failed to persist to Drive — recording is retained in the Pebble app" });
    }
  },
} satisfies ExportedHandler<Env>;
