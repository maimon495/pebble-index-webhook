# Status — pebble-index-webhook

_Handoff snapshot, 2026-10-01. Full setup and operations are in `README.md`._

## Where it stands
- Cloudflare Worker that files Pebble Index 01 voice notes into Google Drive.
- Finished and made public 2026-09-15: user OAuth for Drive, consent screen published
  to Production (removes the 7-day token cap), README + LICENSE.

## Next steps
- Maintenance only. If notes stop arriving, the Drive refresh token has most likely
  expired or been revoked — re-authorise per `docs/google-drive-setup.md`.

## Not in git
- Worker secrets (`PEBBLE_AUTH_TOKEN`, Drive folder id, OAuth client id/secret,
  refresh token) live in Cloudflare (`wrangler secret`) and the Pebble app settings.
- Cloudflare login (`wrangler login`) on the old Mac.
