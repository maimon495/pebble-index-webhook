# Status — pebble-index-webhook

_Snapshot 2026-10-02. Full setup and operations are in `README.md`._

## Where it stands
- Cloudflare Worker that files Pebble Index 01 voice notes into Google Drive, live at
  `https://pebble-index-webhook.brian-herz.workers.dev`.
- Finished and made public 2026-09-15: user OAuth for Drive, consent screen published
  to Production (removes the 7-day token cap), README + LICENSE.
- 2026-10-02: set up again on a new Mac with a replacement ring. Webhook settings
  carried over in the Pebble app; deliveries return 200 and land in Drive.
- 2026-10-02: `GET /notes` feed shipped (PR #2) and verified live — each note is also
  kept in Workers KV (`NOTES_KV`) for 7 days so Muse (Meta's assistant) can poll for
  new notes with a cursor instead of listing Drive every 10 minutes.

## Next steps
- Point Muse's poller at `/notes` (Bearer `POLL_TOKEN`, save `cursor` each poll) and
  turn off its Drive polling. Command is in README → "Polling for new notes".
- Otherwise maintenance only. If notes stop arriving, the Drive refresh token has most
  likely expired or been revoked — re-authorise per `docs/google-drive-setup.md`.

## Not in git
- Worker secrets (`PEBBLE_AUTH_TOKEN`, `POLL_TOKEN`, Drive folder id, OAuth client
  id/secret, refresh token) live in Cloudflare (`wrangler secret`, write-only). The
  Pebble token is also in the Pebble app settings; the poll token is in Muse's poller.
  Lost either one? Generate a new one and `wrangler secret put` it (README → "Secret
  rotation") rather than trying to recover it.
- Nothing runs on any Mac. A Mac is only needed to change or redeploy the Worker:
  install Node, `npm install`, `npx wrangler login` (Cloudflare account
  brian.herz@gmail.com), and `gh auth login` for PRs.
