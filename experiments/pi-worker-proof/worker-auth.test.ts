import { env } from "cloudflare:workers";
import {
  createModels,
  InMemoryCredentialStore,
  type OAuthCredential,
} from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
// Exact installed upstream module, statically bundled by vitest.proof.config.ts.
import { openaiChatGPTOAuth } from "pi-proof-openai-oauth";
import { describe, expect, it, vi } from "vitest";

const fixture = (): OAuthCredential =>
  JSON.parse((env as unknown as { PI_PROOF_AUTH: string }).PI_PROOF_AUTH);

async function prepare(credential?: OAuthCredential, fallback?: string) {
  const credentials = new InMemoryCredentialStore();
  if (credential) await credentials.modify("openai", async () => credential);
  const models = createModels({
    credentials,
    authContext: {
      env: async (name) => (name === "OPENAI_API_KEY" ? fallback : undefined),
      fileExists: async () => false,
    },
  });
  const provider = openaiProvider();
  // Only replace the lazy loader with the same upstream OAuth implementation.
  models.setProvider({
    ...provider,
    auth: { ...provider.auth, oauth: openaiChatGPTOAuth },
  });
  return { models, credentials };
}

function mockRefresh(override: Record<string, unknown> = {}, status = 200) {
  const mock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    expect(String(url)).toBe("https://auth.openai.com/api/accounts/oauth/token");
    expect(init?.method).toBe("POST");
    const body = new URLSearchParams(String(init?.body));
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("client_id")).toBe(fixture().clientId);
    expect(body.get("refresh_token")).toBe(fixture().refresh);
    expect(body.get("resource")).toBe("https://api.openai.com/v1");
    return Response.json(
      {
        access_token: "fixture-access-rotated",
        refresh_token: "fixture-refresh-rotated",
        expires_in: 3600,
        scope: "chatgpt.tokens.use.direct",
        ...override,
      },
      { status },
    );
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

const expired = (): OAuthCredential => ({ ...fixture(), expires: Date.now() - 1 });

describe("Pi ChatGPT OAuth in workerd — MOCK_ONLY, not subscription proof", () => {
  it("accepts a pre-injected Worker binding through the existing credential store", async () => {
    const { models } = await prepare(fixture());
    const result = await models.getAuth("openai");
    expect(result?.auth.apiKey).toBe(fixture().access);
    expect(result?.source).toBe("OAuth");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not invent credentials when no binding or API key is supplied", async () => {
    const { models } = await prepare();
    expect(await models.getAuth("openai")).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refreshes an expired injected credential with the existing OAuth flow", async () => {
    const mock = mockRefresh();
    const { models, credentials } = await prepare(expired());
    expect((await models.getAuth("openai"))?.auth.apiKey).toBe("fixture-access-rotated");
    expect(mock).toHaveBeenCalledTimes(1);
    const stored = (await credentials.read("openai")) as OAuthCredential;
    expect(stored.refresh).toBe("fixture-refresh-rotated");
    expect(stored.expires).toBeGreaterThan(Date.now());
  });

  it("serializes two refresh requests sharing the same in-memory store", async () => {
    const mock = mockRefresh();
    const { models } = await prepare(expired());
    const results = await Promise.all([models.getAuth("openai"), models.getAuth("openai")]);
    expect(results.map((r) => r?.auth.apiKey)).toEqual([
      "fixture-access-rotated",
      "fixture-access-rotated",
    ]);
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("preserves a revoked credential and never falls back to API-key billing", async () => {
    const mock = mockRefresh({ error: "invalid_grant" }, 401);
    const original = expired();
    const { models, credentials } = await prepare(original, "fallback-must-not-be-used");
    await expect(models.getAuth("openai")).rejects.toThrow();
    expect(mock).toHaveBeenCalledTimes(1);
    expect(await credentials.read("openai")).toEqual(original);
  });

  it("rejects a refreshed grant that lacks ChatGPT direct-use permission", async () => {
    mockRefresh({ scope: "openid profile" });
    const original = expired();
    const { models, credentials } = await prepare(original);
    await expect(models.getAuth("openai")).rejects.toThrow();
    expect(await credentials.read("openai")).toEqual(original);
  });

  it("rejects a malformed expiry instead of installing the new credential", async () => {
    mockRefresh({ expires_in: -1 });
    const original = expired();
    const { models, credentials } = await prepare(original);
    await expect(models.getAuth("openai")).rejects.toThrow();
    expect(await credentials.read("openai")).toEqual(original);
  });

  it("does not send a refresh request without the issued client ID", async () => {
    const original = { ...expired(), clientId: "" };
    const { models } = await prepare(original);
    await expect(models.getAuth("openai")).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("exposes credential metadata without either token", async () => {
    const { credentials } = await prepare(fixture());
    expect(await credentials.list()).toEqual([{ providerId: "openai", type: "oauth" }]);
  });

  it("does not claim in-memory auth survives recreation", async () => {
    const first = await prepare(fixture());
    expect((await first.models.getAuth("openai"))?.auth.apiKey).toBe(fixture().access);
    const recreated = await prepare();
    expect(await recreated.models.getAuth("openai")).toBeUndefined();
  });
});
