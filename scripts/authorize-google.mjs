#!/usr/bin/env node
/**
 * One-time (and re-run-when-expired) OAuth authorization for the Worker's
 * Google Drive access. Opens your browser, you click Allow once, and it
 * prints a refresh token to feed into `wrangler secret put
 * GOOGLE_OAUTH_REFRESH_TOKEN`. See docs/google-drive-setup.md.
 *
 * Usage: node scripts/authorize-google.mjs <client_id> <client_secret>
 */
import http from "node:http";
import { exec } from "node:child_process";

const [CLIENT_ID, CLIENT_SECRET] = process.argv.slice(2);
if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("Usage: node scripts/authorize-google.mjs <client_id> <client_secret>");
  process.exit(1);
}

const PORT = 51234;
const REDIRECT_URI = `http://localhost:${PORT}`;
const SCOPE = "https://www.googleapis.com/auth/drive";

const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
authUrl.searchParams.set("client_id", CLIENT_ID);
authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
authUrl.searchParams.set("response_type", "code");
authUrl.searchParams.set("scope", SCOPE);
authUrl.searchParams.set("access_type", "offline");
// Forces Google to reissue a refresh_token even if this client was already
// authorized before (Google only issues one on first consent otherwise).
authUrl.searchParams.set("prompt", "consent");

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, REDIRECT_URI);
  const code = url.searchParams.get("code");
  const err = url.searchParams.get("error");

  if (err) {
    res.end(`Authorization failed: ${err}. You can close this tab.`);
    console.error("AUTH_ERROR", err);
    server.close();
    process.exit(1);
  }
  if (!code) {
    res.end("Waiting for authorization...");
    return;
  }

  res.end("Authorized! You can close this tab and return to the terminal.");

  const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      grant_type: "authorization_code",
      redirect_uri: REDIRECT_URI,
    }),
  });
  const tokens = await tokenResp.json();
  if (!tokenResp.ok) {
    console.error("TOKEN_EXCHANGE_FAILED", JSON.stringify(tokens));
    server.close();
    process.exit(1);
  }
  if (!tokens.refresh_token) {
    console.error("NO_REFRESH_TOKEN", JSON.stringify(tokens));
    console.error(
      "Hint: revoke prior access at https://myaccount.google.com/permissions and re-run — this shouldn't " +
        "happen since prompt=consent is set above, but a stale grant can occasionally still suppress it.",
    );
    server.close();
    process.exit(1);
  }

  console.log("REFRESH_TOKEN=" + tokens.refresh_token);
  server.close();
  process.exit(0);
});

server.listen(PORT, () => {
  console.error("Opening browser for authorization...");
  exec(`open "${authUrl.toString()}"`);
});
