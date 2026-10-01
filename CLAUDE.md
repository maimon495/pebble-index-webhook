# pebble-index-webhook — Project Context

Cloudflare Worker (TypeScript) that receives Pebble Index 01 webhook POSTs and files
each voice note's audio/transcription into Google Drive. `README.md` is the full
setup/operations guide and the response-code contract the Pebble app's retries rely on.

## Commands
`npm run dev` (wrangler, :8787) · `npm test` (vitest in workerd, no live Google
calls) · `npm run check` (tsc) · `npm run deploy` · `npm run secrets:list`

## Watch out
- The status codes in README's response contract drive the app's retry behaviour;
  don't change them casually.
- Drive auth is **user OAuth** with a refresh token, not a service account. If notes
  stop arriving, suspect an expired/revoked refresh token first (`docs/google-drive-setup.md`).
- This repo is **public**. Secrets live only in `wrangler secret` and the Pebble app.

## Working with Brian
- Work on a feature branch and open a PR; never commit to `main`. Brian merges.
- Do the work end to end. Only hand back secrets, spending, irreversible
  outward-facing actions, and product decisions such as naming.
- Never commit secrets. Where each one lives is listed in STATUS.md.
- Other projects: see `docs/ALL-PROJECTS.md` in `maimon495/DailyGratitudeJournal`.

@STATUS.md
