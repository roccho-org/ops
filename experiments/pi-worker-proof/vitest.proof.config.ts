import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { oauthAlias } from "./worker-oauth.alias.ts";

export default defineConfig({
  resolve: { alias: oauthAlias },
  test: {
    fsModuleCache: false,
    setupFiles: ["./test/worker-proof.setup.ts"],
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        // Deny native fetch too, including an SDK that captured it before stubs.
        outboundService: async () =>
          new Response("MOCK_ONLY: native outbound denied", { status: 401 }),
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
