import { SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetTokenCacheForTests } from "../src/google";

const WORKER = "https://receiver.example.com";
const AUTH = "test-pebble-token";

const realFetch = globalThis.fetch;

interface UploadCall {
  name: string;
  contentType: string;
  bodyText: string;
}

interface GoogleMock {
  uploads: () => UploadCall[];
  tokenCalls: () => number;
  lookupExists: boolean;
}

/** Stubs global fetch to serve fake responses for Google's token/Drive endpoints. */
function mockGoogle(opts: { lookupExists?: boolean; failToken?: boolean; failUpload?: boolean } = {}): GoogleMock {
  const uploads: UploadCall[] = [];
  let tokenCalls = 0;
  const state: GoogleMock = {
    uploads: () => uploads,
    tokenCalls: () => tokenCalls,
    lookupExists: opts.lookupExists ?? false,
  };

  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);

    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      tokenCalls++;
      if (opts.failToken) return new Response("bad", { status: 401 });
      return new Response(JSON.stringify({ access_token: "test-access-token", expires_in: 3600 }), { status: 200 });
    }

    if (url.startsWith("https://www.googleapis.com/drive/v3/files")) {
      return new Response(JSON.stringify({ files: state.lookupExists ? [{ id: "existing-file" }] : [] }), {
        status: 200,
      });
    }

    if (url.startsWith("https://www.googleapis.com/upload/drive/v3/files")) {
      if (opts.failUpload) return new Response("nope", { status: 500 });
      const bodyText = typeof init?.body === "string" ? init.body : new TextDecoder().decode(init?.body as ArrayBuffer);
      const headers = init?.headers as Record<string, string>;
      const contentType = headers["Content-Type"] ?? headers["content-type"] ?? "";
      const nameMatch = bodyText.match(/"name":"([^"]+)"/);
      uploads.push({ name: nameMatch?.[1] ?? "", contentType, bodyText });
      return new Response(JSON.stringify({ id: "new-file" }), { status: 200 });
    }

    throw new Error(`unexpected fetch to ${url}`);
  });

  return state;
}

afterEach(() => {
  vi.stubGlobal("fetch", realFetch);
  vi.unstubAllGlobals();
  resetTokenCacheForTests();
});

function pebbleForm(fields: Record<string, string | { filename: string; content: string; type: string }>): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === "string") {
      form.append(key, value);
    } else {
      form.append(key, new File([value.content], value.filename, { type: value.type }));
    }
  }
  return form;
}

function post(body: FormData, headers: Record<string, string> = { Authorization: AUTH }, extraHeaders: Record<string, string> = {}) {
  return SELF.fetch(`${WORKER}/index-webhook`, { method: "POST", body, headers: { ...headers, ...extraHeaders } });
}

describe("routing", () => {
  it("serves a health check", async () => {
    const res = await SELF.fetch(`${WORKER}/health`);
    expect(res.status).toBe(200);
  });

  it("404s unknown paths", async () => {
    const res = await SELF.fetch(`${WORKER}/nope`, { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("405s non-POST on /index-webhook", async () => {
    const res = await SELF.fetch(`${WORKER}/index-webhook`);
    expect(res.status).toBe(405);
  });
});

describe("auth", () => {
  it("401s without an Authorization header", async () => {
    const res = await post(pebbleForm({ transcription: "hi" }), {});
    expect(res.status).toBe(401);
  });

  it("401s with a wrong token", async () => {
    const res = await post(pebbleForm({ transcription: "hi" }), { Authorization: "wrong" });
    expect(res.status).toBe(401);
  });

  it("accepts a Bearer-prefixed token", async () => {
    mockGoogle();
    const res = await post(pebbleForm({ transcription: "hi", recordedAt: "1700000000000" }), {
      Authorization: `Bearer ${AUTH}`,
    });
    expect(res.status).toBe(200);
  });
});

describe("validation", () => {
  it("415s on a non-form body", async () => {
    const res = await SELF.fetch(`${WORKER}/index-webhook`, {
      method: "POST",
      headers: { Authorization: AUTH, "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(415);
  });

  it("422s when neither audio nor transcription is present", async () => {
    const res = await post(pebbleForm({ recordedAt: "1700000000000", client: "ring" }));
    expect(res.status).toBe(422);
  });

  it("413s when the transcription exceeds the size cap", async () => {
    const res = await post(pebbleForm({ transcription: "x".repeat(64_001), recordedAt: "1700000000000" }));
    expect(res.status).toBe(413);
  });

  it("413s when the audio exceeds the size cap", async () => {
    const res = await post(
      pebbleForm({
        audio: { filename: "big.m4a", content: "x".repeat(26 * 1024 * 1024), type: "audio/mp4" },
        recordedAt: "1700000000000",
      }),
    );
    expect(res.status).toBe(413);
  });
});

describe("test events", () => {
  it("200s an X-Index-Test event without touching Drive", async () => {
    const google = mockGoogle();
    const res = await post(pebbleForm({ transcription: "canned test text", recordedAt: "1700000000000" }), undefined, {
      "X-Index-Test": "true",
    });
    expect(res.status).toBe(200);
    expect(google.uploads()).toHaveLength(0);
    expect(google.tokenCalls()).toBe(0);
  });

  it("200s a test-event trigger without filing a note", async () => {
    const google = mockGoogle();
    const res = await post(pebbleForm({ test: "true", transcription: "canned" }), undefined, {
      "X-Index-Trigger": "test-event",
    });
    expect(res.status).toBe(200);
    expect(google.uploads()).toHaveLength(0);
  });
});

describe("persistence", () => {
  it("uploads transcription-only payloads as a .txt file", async () => {
    const google = mockGoogle();
    const res = await post(pebbleForm({ transcription: "remind me to call mom at 5", recordedAt: "1700000000000" }));
    expect(res.status).toBe(200);

    const uploads = google.uploads();
    expect(uploads).toHaveLength(1);
    expect(uploads[0].name).toBe("1700000000000_" + (await sha256Hex("1700000000000:remind me to call mom at 5")) + ".txt");
    expect(uploads[0].contentType).toContain("multipart/related");
  });

  it("uploads both audio and transcription, keyed on the recordingId in the audio filename", async () => {
    const google = mockGoogle();
    const res = await post(
      pebbleForm({
        audio: { filename: "rec-abc123.m4a", content: "fake-audio-bytes", type: "audio/mp4" },
        transcription: "call mom",
        recordedAt: "1700000000000",
        client: "ring",
      }),
    );
    expect(res.status).toBe(200);

    const uploads = google.uploads();
    const names = uploads.map((u) => u.name).sort();
    expect(names).toEqual(["1700000000000_rec-abc123.m4a", "1700000000000_rec-abc123.txt"]);
  });

  it("skips upload and returns 200 when the file already exists (idempotent retry)", async () => {
    const google = mockGoogle({ lookupExists: true });
    const res = await post(
      pebbleForm({
        audio: { filename: "rec-abc123.m4a", content: "fake-audio-bytes", type: "audio/mp4" },
        transcription: "call mom",
        recordedAt: "1700000000000",
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deduped?: boolean };
    expect(body.deduped).toBe(true);
    expect(google.uploads()).toHaveLength(0);
  });

  it("502s when Drive upload fails, so the app retries", async () => {
    mockGoogle({ failUpload: true });
    const res = await post(pebbleForm({ transcription: "hi", recordedAt: "1700000000000" }));
    expect(res.status).toBe(502);
  });

  it("502s when the Google token exchange fails", async () => {
    mockGoogle({ failToken: true });
    const res = await post(pebbleForm({ transcription: "hi", recordedAt: "1700000000000" }));
    expect(res.status).toBe(502);
  });

  it("reuses the access token across requests instead of re-minting one each time", async () => {
    const google = mockGoogle();
    await post(pebbleForm({ transcription: "first", recordedAt: "1700000000000" }));
    await post(pebbleForm({ transcription: "second", recordedAt: "1700000000001" }));
    expect(google.tokenCalls()).toBe(1);
  });
});

async function sha256Hex(message: string): Promise<string> {
  const enc = new TextEncoder();
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(message));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
