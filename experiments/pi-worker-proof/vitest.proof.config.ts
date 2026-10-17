import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Copied beside upstream's config by CI. Reuse the installed implementation;
// this alias is a bundling seam, not a new OAuth protocol implementation.
const aiDist = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-ai")));

export default defineConfig({
  resolve: {
    alias: {
      "pi-proof-openai-oauth": join(aiDist, "auth/oauth/openai-chatgpt.js"),
    },
  },
  test: {
    fsModuleCache: false,
    setupFiles: ["./test/worker-proof.setup.ts"],
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          OPENAI_API_KEY: "",
          PI_PROOF_AUTH: JSON.stringify({
            type: "oauth",
            access: "fixture-access-not-a-real-token",
            refresh: "fixture-refresh-not-a-real-token",
            expires: 4102444800000,
            clientId: "fixture-client-not-a-real-registration",
            scopes: ["chatgpt.tokens.use.direct"],
          }),
        },
      },
    }),
  ],
});
