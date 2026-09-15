# Google Drive setup

The Worker uploads as a **service account** — a robot Google identity with
its own credentials, scoped to only the one folder you share with it. Your
personal Google account is never touched.

## 1. Create a Google Cloud project (or reuse one)

https://console.cloud.google.com/projectcreate — any name, e.g. "pebble-index-webhook".

## 2. Enable the Drive API

Console → APIs & Services → Library → search "Google Drive API" → Enable,
for the project you just created/selected.

## 3. Create the service account

Console → IAM & Admin → Service Accounts → **Create Service Account**.
- Name: `pebble-index-webhook` (anything)
- No project roles needed — access is granted later via folder sharing, not
  IAM roles.
- Skip "grant users access."

## 4. Create a key for it

Open the service account → **Keys** tab → **Add Key** → **Create new key** →
**JSON**. This downloads a `.json` file — treat it like a password. Its
`client_email` field (something like
`pebble-index-webhook@your-project.iam.gserviceaccount.com`) is what you'll
share the Drive folder with in the next step.

## 5. Create the Drive folder and share it

1. In your own Google Drive, create a folder named `Pebble Voice Notes`.
2. Right-click it → **Share** → paste the service account's `client_email`
   → role **Editor** → Share. (It'll warn the address has no Google
   Workspace account — that's expected for a service account.)
3. Open the folder and copy its ID from the URL:
   `https://drive.google.com/drive/folders/`**`<this part>`**

## 6. Feed both into the Worker

- `GOOGLE_SERVICE_ACCOUNT_JSON` — the entire contents of the key file from
  step 4, as one line.
- `DRIVE_FOLDER_ID` — the ID from step 5.3.

See the main [README](../README.md#one-time-setup) for the `wrangler secret
put` commands.

## Rotating the key

Google Cloud Console → IAM & Admin → Service Accounts → the account → Keys →
delete the old key, add a new one, `wrangler secret put
GOOGLE_SERVICE_ACCOUNT_JSON` with the new file's contents. No change needed
to the folder sharing or the folder ID.
