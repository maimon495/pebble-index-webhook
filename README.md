# pebble-index-webhook

Cloudflare Worker that receives the Pebble Index 01 ring's native webhook
(configured in the Pebble app under Index 01 Settings → Webhook) and persists
each voice note — audio and/or transcription — to a Google Drive folder.

```
Ring --BLE--> Pebble app (transcribes, fires webhook) --POST--> this Worker --> Google Drive
```

No Shortcuts automation, no app fork. See the Pebble app repo's
`experimental/src/commonMain/kotlin/coredevices/ring/external/indexwebhook/INDEX_WEBHOOK_API.md`
for the upstream API this implements — that's the source of truth for the
request format; this README covers deploying and operating the receiver.

## Response contract

The Pebble app's retry behavior depends on these status codes:

| Condition | Status |
|---|---|
| Note durably persisted to Drive | `200` |
| Any persistence failure (Drive/token unreachable, upload rejected) | `502` |
| Bad or missing auth header | `401` |
| `X-Index-Test: true` (Send test event) | `200`, never filed as a note |
| Neither `audio` nor `transcription` in the payload | `422` |
| Transcription/audio over the size cap | `413` |
| Worker misconfigured (missing secret, bad key JSON) | `500` |

A failed upload is only retried when the ring records again — check the
app's **Recent runs** list (Index 01 Settings → Webhook) as the delivery
source of truth, especially right after setup or if a note goes missing.

## One-time setup

1. **Google Drive folder + service account** — follow
   [docs/google-drive-setup.md](docs/google-drive-setup.md). You'll end up
   with a folder ID and a service-account JSON key.
2. **Generate the shared secret** the Pebble app will authenticate with:
   ```bash
   openssl rand -hex 32
   ```
3. **Install dependencies and log in to Cloudflare:**
   ```bash
   npm install
   npx wrangler login
   ```
4. **Set the Worker's secrets** (you'll be prompted for each value):
   ```bash
   npx wrangler secret put PEBBLE_AUTH_TOKEN
   npx wrangler secret put DRIVE_FOLDER_ID
   npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_JSON
   ```
   `GOOGLE_SERVICE_ACCOUNT_JSON` is the *entire contents* of the service
   account key file, pasted as one line (`cat key.json | pbcopy` and paste).
5. **Deploy:**
   ```bash
   npm run deploy
   ```
   Wrangler prints the Worker's URL, e.g. `https://pebble-index-webhook.<your-subdomain>.workers.dev`.
6. **Configure the Pebble app** — follow
   [docs/pebble-app-setup.md](docs/pebble-app-setup.md) using that URL
   (append `/index-webhook`) and the secret from step 2.
7. **Send a test event** from the app's webhook screen, then confirm it
   shows up in the Worker's logs:
   ```bash
   npx wrangler tail
   ```
   You should see `{"event":"test_event_received"}` and no file should
   appear in Drive. Then record a real note on the ring and confirm the
   `.m4a`/`.txt` pair lands in the Drive folder within a minute or two.

## Local development

```bash
cp .dev.vars.example .dev.vars   # fill in real or test values
npm run dev                       # wrangler dev, http://localhost:8787
npm test                          # vitest, runs in workerd — no live Google calls
npm run check                     # tsc --noEmit
```

To exercise the local dev server against real Google APIs, point the app's
**Send test event** at an `ngrok`/`cloudflared` tunnel to `localhost:8787`,
or just deploy to a throwaway Worker name first.

## Secret rotation

If `PEBBLE_AUTH_TOKEN` ever leaks (committed by mistake, shared in a screenshot, etc.):

1. Generate a new token: `openssl rand -hex 32`
2. `npx wrangler secret put PEBBLE_AUTH_TOKEN` with the new value
3. In the Pebble app, Index 01 Settings → Webhook → update the `Authorization`
   header's value to `Bearer <new token>`
4. Send a test event to confirm both sides agree before the next real recording

The app's webhook settings are the *only* other place the secret lives —
there's no third system to update.

If the service-account key is ever exposed, delete it in the Google Cloud
Console (IAM & Admin → Service Accounts → Keys) and create a new one, then
`wrangler secret put GOOGLE_SERVICE_ACCOUNT_JSON` with the new key. The old
key stops working the moment it's deleted server-side.

## Re-pointing at a new Worker URL

If you ever redeploy under a new name/subdomain, the only change needed on
the Pebble side is the webhook URL in Index 01 Settings → Webhook — the auth
header and payload mode carry over.

## Design notes

- **Dedupe key**: the `recordingId` embedded in the audio filename
  (`<recordingId>.m4a`), falling back to `sha256(recordedAt:transcription)`
  for transcription-only payloads. Files are named `<recordedAt>_<key>.m4a` /
  `.txt`. Before uploading, the Worker checks Drive for an existing file with
  that name — a retried delivery after a `502` is a no-op, not a duplicate.
- **Access token caching**: the service-account access token is cached
  in-isolate for its ~1hr lifetime instead of re-minted per request.
- **Never logs transcription contents** — only event name, dedupe key, and
  latency. Transcription size is capped (64K chars) and audio size is capped
  (25MB) so a leaked token can't be used to push arbitrarily large payloads
  through the Worker.
- **`drive.file` scope** (least privilege): the service account can only see
  what's explicitly shared with it, i.e. exactly the one folder.

## What still needs a human

- Linking the Drive folder ID and secret rotation live only in this repo's
  docs and the Pebble app's settings — nothing else to keep in sync.
- Mycroft's Drive-polling cron is out of scope for this repo; hand off the
  folder ID once it's created.
