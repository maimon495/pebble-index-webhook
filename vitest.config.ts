import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import { TEST_OAUTH_CREDENTIALS } from "./test/fixtures";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          PEBBLE_AUTH_TOKEN: "test-pebble-token",
          DRIVE_FOLDER_ID: "test-folder-id",
          GOOGLE_OAUTH_CLIENT_ID: TEST_OAUTH_CREDENTIALS.client_id,
          GOOGLE_OAUTH_CLIENT_SECRET: TEST_OAUTH_CREDENTIALS.client_secret,
          GOOGLE_OAUTH_REFRESH_TOKEN: TEST_OAUTH_CREDENTIALS.refresh_token,
        },
      },
    }),
  ],
});
