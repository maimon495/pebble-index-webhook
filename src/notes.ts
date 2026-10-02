/**
 * Short-lived feed of recent notes in Workers KV, so a poller can pick up new
 * voice notes cheaply instead of listing the Drive folder. Drive stays the
 * source of truth; this is a convenience copy that expires on its own.
 *
 * One KV entry per note, keyed on the existing dedupe key, so a retried
 * delivery is idempotent and two notes between polls never overwrite each
 * other. The poller's cursor is receivedAt (when the Worker got the note),
 * not recordedAt, so notes recorded offline and synced late are still seen.
 */

const PREFIX = "note:";
/** Notes auto-delete from KV after this long (Drive copies are unaffected). */
export const NOTE_TTL_SECONDS = 7 * 24 * 60 * 60;
/** Max notes returned per poll; the poller pages with the returned cursor. */
export const MAX_NOTES_PER_POLL = 50;

export interface StoredNote {
  key: string;
  recordedAtMs: number;
  receivedAt: number;
  transcription: string | null;
  audioName: string | null;
  textName: string | null;
}

interface NoteMetadata {
  receivedAt: number;
}

/** Stores a note unless one with the same key already exists (keeps the original receivedAt). */
export async function storeNote(kv: KVNamespace, note: StoredNote): Promise<void> {
  const kvKey = PREFIX + note.key;
  if ((await kv.get(kvKey)) !== null) return;
  await kv.put(kvKey, JSON.stringify(note), {
    expirationTtl: NOTE_TTL_SECONDS,
    metadata: { receivedAt: note.receivedAt } satisfies NoteMetadata,
  });
}

export interface NotesPage {
  notes: StoredNote[];
  /** Pass back as `since` on the next poll. Unchanged from the request when there are no new notes. */
  cursor: number;
  /** True when more notes are waiting beyond this page — poll again right away. */
  more: boolean;
}

/** Returns notes received strictly after `since`, oldest first. */
export async function notesSince(kv: KVNamespace, since: number): Promise<NotesPage> {
  const newer: { name: string; receivedAt: number }[] = [];
  let cursor: string | undefined;
  do {
    const page = await kv.list<NoteMetadata>({ prefix: PREFIX, cursor });
    for (const k of page.keys) {
      const receivedAt = k.metadata?.receivedAt;
      if (typeof receivedAt === "number" && receivedAt > since) newer.push({ name: k.name, receivedAt });
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  newer.sort((a, b) => a.receivedAt - b.receivedAt);
  let end = Math.min(newer.length, MAX_NOTES_PER_POLL);
  // Never split notes sharing a receivedAt across pages, or the strict `> since` would skip some.
  while (end < newer.length && newer[end].receivedAt === newer[end - 1].receivedAt) end++;
  const batch = newer.slice(0, end);
  const values = await Promise.all(batch.map((k) => kv.get<StoredNote>(k.name, "json")));
  // A value can be null if it expired between list and get; skip it.
  const notes = values.filter((n): n is StoredNote => n !== null);

  return {
    notes,
    cursor: batch.length > 0 ? batch[batch.length - 1].receivedAt : since,
    more: newer.length > batch.length,
  };
}
