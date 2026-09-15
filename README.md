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
| Worker misconfigured (missing secret) | `500` |

A failed upload is only retried when the ring records again — check the
app's **Recent runs** list (Index 01 Settings → Webhook) as the delivery
source of truth, especially right after setup or if a note goes missing.

## One-time setup

1. **Google Cloud OAuth client + Drive folder** — follow
   [docs/google-drive-setup.md](docs/google-drive-setup.md). You'll end up
   with a client ID, client secret, refresh token, and a folder ID.
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
   npx wrangler secret put GOOGLE_OAUTH_CLIENT_ID
   npx wrangler secret put GOOGLE_OAUTH_CLIENT_SECRET
   npx wrangler secret put GOOGLE_OAUTH_REFRESH_TOKEN
   ```
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

**The Drive refresh token can still expire or get revoked** (Google drops
tokens unused for 6 months, on a password/security change, if you exceed
50 refresh tokens issued for one client+account — oldest is silently
invalidated — or if you revoke access yourself at
[myaccount.google.com/permissions](https://myaccount.google.com/permissions)).
The consent screen is published to Production (see
docs/google-drive-setup.md), which removes the 7-day Testing-status cap
that applied before, but re-authorization is still a documented fallback,
not something that should be needed routinely. Watch for `invalid_grant` in
`wrangler tail`; when it happens:
```bash
node scripts/authorize-google.mjs <client_id> <client_secret>
npx wrangler secret put GOOGLE_OAUTH_REFRESH_TOKEN
```
The client ID/secret don't need to change. You'll see a one-time "Google
hasn't verified this app" warning during re-authorization (click Advanced →
Go to Pebble Index Webhook (unsafe)) — that's because the `drive` scope is
"restricted" and removing the warning requires full Google verification,
which isn't worth pursuing for a single-user personal tool.

If the OAuth client secret is ever exposed, delete the client in Google
Cloud Console (Google Auth Platform → Clients) and create a new one, then
re-run the authorization script and update all three
`GOOGLE_OAUTH_*` secrets.

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
- **Access token caching**: the Drive access token is cached in-isolate for
  its ~1hr lifetime instead of re-minted per request.
- **Never logs transcription contents** — only event name, dedupe key, and
  latency. Transcription size is capped (64K chars) and audio size is capped
  (25MB) so a leaked token can't be used to push arbitrarily large payloads
  through the Worker.
- **User OAuth, not a service account**: a service account was the first
  design and doesn't work on a personal (non-Workspace) Google account —
  service accounts have zero storage quota, so every upload 403s with
  "Service Accounts do not have storage quota" even inside a folder shared
  with them as Editor. User OAuth creates files under your own account's
  quota instead.
- **Consent screen publishing**: the OAuth consent screen is published to
  Production. Publishing needs a home page / privacy policy / terms link —
  rather than standing up a separate site for that, `/`, `/privacy`, and
  `/terms` are served directly by this Worker (see `HOME_PAGE`,
  `PRIVACY_PAGE`, `TERMS_PAGE` in `src/index.ts`), truthfully describing a
  single-user personal tool. The app remains functionally "unverified"
  (full Google verification is out of scope for this), which only affects
  the one-time authorization screen, not ongoing token refresh.

## What still needs a human

- Linking the Drive folder ID and secret rotation live only in this repo's
  docs and the Pebble app's settings — nothing else to keep in sync.
- Mycroft's Drive-polling cron is out of scope for this repo; hand off the
  folder ID once it's created.
