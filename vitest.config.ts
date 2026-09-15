import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import { TEST_SERVICE_ACCOUNT_KEY } from "./test/fixtures";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          PEBBLE_AUTH_TOKEN: "test-pebble-token",
          DRIVE_FOLDER_ID: "test-folder-id",
          GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify(TEST_SERVICE_ACCOUNT_KEY),
        },
      },
    }),
  ],
});
