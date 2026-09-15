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
import { driveFileExists, driveUpload, getAccessToken, type ServiceAccountKey } from "./google";

export interface Env {
  /** Token the Pebble app sends in its Authorization header. */
  PEBBLE_AUTH_TOKEN: string;
  /** Drive folder ID to upload into; must be shared with the service account. */
  DRIVE_FOLDER_ID: string;
  /** Full service-account JSON key, as a string. */
  GOOGLE_SERVICE_ACCOUNT_JSON: string;
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

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return json(200, { ok: true });
    }
    if (url.pathname !== "/index-webhook") {
      return json(404, { ok: false, error: "not found" });
    }
    if (request.method !== "POST") {
      return json(405, { ok: false, error: "method not allowed; POST /index-webhook" });
    }

    const missing = (["PEBBLE_AUTH_TOKEN", "DRIVE_FOLDER_ID", "GOOGLE_SERVICE_ACCOUNT_JSON"] as const).filter(
      (name) => !env[name],
    );
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

    let serviceAccount: ServiceAccountKey;
    try {
      serviceAccount = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON);
    } catch {
      return json(500, { ok: false, error: "worker misconfigured: GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON" });
    }

    const started = Date.now();
    try {
      const accessToken = await getAccessToken(serviceAccount);

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
