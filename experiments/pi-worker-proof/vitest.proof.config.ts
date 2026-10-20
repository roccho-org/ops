import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { createHash } from "node:crypto";
import { defineConfig } from "vitest/config";
import { oauthAlias } from "./worker-oauth.alias.ts";

const credential = {
  type: "oauth",
  access: "fixture-access-not-a-real-token",
  refresh: "fixture-refresh-not-a-real-token",
  expires: 4102444800000,
  clientId: "fixture-client-not-a-real-registration",
  scopes: ["chatgpt.tokens.use.direct"],
};

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
          PI_JEV_PROOF_API_KEY: "fixture-jev-not-real",
          PI_JEV_PROOF_SESSION: "jev-proof",
          OPENAI_API_KEY: "",
          PI_PROOF_TRANSIENT: process.env.PI_PROOF_TEST_TRANSIENT === "true" ? "true" : "false",
          PI_ACCESS_ISSUER: "https://fixture.cloudflareaccess.com",
          PI_ACCESS_AUDIENCE: "fixture-app",
          PI_ACCESS_OWNER_HASH: createHash("sha256").update("fixture-owner").digest("hex"),
          PI_OAUTH_HOST_ID: "00000000-0000-4000-8000-000000000563",
          PI_PROOF_AUTH: JSON.stringify(credential),
          PI_CHATGPT_BOOTSTRAP: JSON.stringify({
            session: "oauth-app-resume",
            credential: { ...credential, expires: 0 },
          }),
        },
      },
    }),
  ],
});
