# Status — pebble-index-webhook

_Handoff snapshot, 2026-10-01. Full setup and operations are in `README.md`._

## Where it stands
- Cloudflare Worker that files Pebble Index 01 voice notes into Google Drive.
- Finished and made public 2026-09-15: user OAuth for Drive, consent screen published
  to Production (removes the 7-day token cap), README + LICENSE.

- 2026-10-02: set up again on a new Mac with a replacement ring. Webhook settings
  carried over in the Pebble app; deliveries return 200 and land in Drive.
- In progress (`feat/notes-feed`): `GET /notes` KV feed so Muse (Meta's assistant)
  can poll for new notes instead of listing Drive every 10 minutes.

## Next steps
- Finish `feat/notes-feed`: create the KV namespace, set `POLL_TOKEN`, deploy after
  merge, then point Muse's poller at `/notes`.
- Otherwise maintenance only. If notes stop arriving, the Drive refresh token has most
  likely expired or been revoked — re-authorise per `docs/google-drive-setup.md`.

## Not in git
- Worker secrets (`PEBBLE_AUTH_TOKEN`, `POLL_TOKEN`, Drive folder id, OAuth client
  id/secret, refresh token) live in Cloudflare (`wrangler secret`); the Pebble token is
  also in the Pebble app settings and the poll token in Muse's poller.
- Cloudflare login (`wrangler login`) — redo on each new Mac.
