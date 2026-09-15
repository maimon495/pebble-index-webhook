const encoder = new TextEncoder();

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(message: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", encoder.encode(message)));
}

/** Strips a trailing extension, e.g. "abc123.m4a" -> "abc123". */
function stripExtension(filename: string): string {
  const i = filename.lastIndexOf(".");
  return i === -1 ? filename : filename.slice(0, i);
}

/**
 * Derives the recording's dedupe key. Prefers the recordingId embedded in the
 * audio filename (per INDEX_WEBHOOK_API.md, audio is named `<recordingId>.m4a`).
 * Falls back to a hash of recordedAt+transcription for transcription-only
 * payloads, matching the fallback the brief specifies.
 */
export async function recordingKey(audioFilename: string | null, recordedAtMs: number, transcription: string): Promise<string> {
  if (audioFilename) {
    const id = stripExtension(audioFilename).trim();
    if (id) return id;
  }
  return sha256Hex(`${recordedAtMs}:${transcription}`);
}
