# Google Drive setup

The Worker authenticates as **you** (via OAuth, with a long-lived refresh
token) rather than as a service account.

## Why not a service account?

That was the first design — simpler in theory, since it needs no interactive
consent. It doesn't work on a personal (non-Workspace) Google account: a
service account has **zero storage quota**, and creating a file always makes
the service account its owner, even inside a folder explicitly shared with
it as Editor. Every upload 403s with:

> Service Accounts do not have storage quota. Leverage shared drives, or use
> OAuth delegation instead.

Shared Drives require Google Workspace. OAuth delegation (domain-wide
delegation) also requires Workspace. For a plain Gmail account, the only
path is a normal user OAuth consent — the Worker then creates files under
your own account, with your own quota.

## 1. Create a Google Cloud project (or reuse one)

https://console.cloud.google.com/projectcreate

## 2. Enable the Drive API

Console → APIs & Services → Library → search "Google Drive API" → Enable.

## 3. Configure the OAuth consent screen

Console → **Google Auth Platform** → Get started:
- App name: anything (e.g. "Pebble Index Webhook")
- User support email: your email
- Audience: **External**
- Contact information: your email
- Create

On the **Audience** page, under **Test users**, click **Add users** and add
your own Google account email — without this the consent screen refuses to
authorize you at all, even in Testing status.

**Publish it to Production** once you have at least one test user added:
Audience page → **Publish app** → Confirm. Testing-status apps get a
refresh token capped at 7 days regardless of activity; Production removes
that cap. Publishing normally requires a hosted home page / privacy policy /
terms link, which is why this repo's Worker serves `/`, `/privacy`, and
`/terms` itself (see `src/index.ts`) — point the Branding page's "App
domain" fields at those three URLs (`https://<your-worker>.workers.dev/`,
`/privacy`, `/terms`) and add the Worker's `workers.dev` subdomain under
**Authorized domains** before Publish app will enable.

Because the `drive` scope is "restricted," publishing doesn't remove the
"Google hasn't verified this app" warning — only full Google verification
does, which isn't worth pursuing for a single-user personal tool. You'll
still see it once at each authorization (click Advanced → Go to [app]
(unsafe)); it doesn't affect ongoing token refresh once authorized.

## 4. Create an OAuth client

**Clients** → **Create Client** → **Application type: Desktop app** → any
name → **Create**. Copy the **Client ID** and **Client secret** shown (you
can also re-download this later from the Clients tab, but the secret is
only shown once at creation — save it now).

## 5. Run the one-time authorization

This opens your browser, you click **Allow** once (and "Advanced → Go to
[app] (unsafe)" past the unverified-app warning — expected for a personal
single-user app), and it prints a refresh token.

```bash
node scripts/authorize-google.mjs <client_id> <client_secret>
```

It starts a local server on `http://localhost:51234`, opens the Google
consent screen, and prints `REFRESH_TOKEN=...` to stdout once you approve.

## 6. Create the destination folder

Create a folder anywhere in your own Drive, e.g. "Pebble Voice Notes." No
sharing step needed — it's already yours. Copy its ID from the URL:
`https://drive.google.com/drive/folders/`**`<this part>`**

## 7. Feed it all into the Worker

```bash
npx wrangler secret put GOOGLE_OAUTH_CLIENT_ID
npx wrangler secret put GOOGLE_OAUTH_CLIENT_SECRET
npx wrangler secret put GOOGLE_OAUTH_REFRESH_TOKEN
npx wrangler secret put DRIVE_FOLDER_ID
```

## Re-authorizing if the refresh token is ever revoked

With the consent screen published, this shouldn't happen on a fixed
schedule anymore — but Google can still drop a refresh token if it goes
unused for 6 months, on a Google account password/security change, if you
exceed 50 refresh tokens issued for this client+account (oldest is silently
invalidated), or if you manually revoke access at
[myaccount.google.com/permissions](https://myaccount.google.com/permissions).
Watch for `google token exchange failed: 400` / `invalid_grant` in
`wrangler tail` or Cloudflare's Worker logs. Fix:

```bash
node scripts/authorize-google.mjs <client_id> <client_secret>
npx wrangler secret put GOOGLE_OAUTH_REFRESH_TOKEN
```

The client ID/secret don't change, only the refresh token.
