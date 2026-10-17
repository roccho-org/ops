import { exports } from "cloudflare:workers";
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { oauthScreen } from "../src/worker-screen.ts";

const origin = "https://example.com";
// The service binding otherwise follows the redirect against this Worker again.
const start = (headers: HeadersInit = { origin }) => exports.default.fetch(`${origin}/auth/start`, { method: "POST", headers, redirect: "manual" });
const checkTarget = (response: Response) => {
  expect(response.status).toBe(303);
  const url = new URL(response.headers.get("location")!);
  // Compare booleans so failed assertions do not publish OAuth query values.
  expect(url.origin === "https://auth.openai.com" && url.pathname === "/api/accounts/authorize").toBe(true);
  expect(url.searchParams.get("code_challenge_method") === "S256").toBe(true);
  expect(url.searchParams.get("redirect_uri") === "http://127.0.0.1:1455/auth/callback").toBe(true);
  expect(url.searchParams.get("agent_name_hint") === "Pi Worker").toBe(true);
  for (const key of ["state", "nonce", "code_challenge"]) expect((url.searchParams.get(key)?.length ?? 0) >= 43).toBe(true);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  return url;
};

describe("Worker URL to unchanged Pi OAuth, screen only", () => {
  it("shows an honest landing and creates a fresh valid redirect without network/token exchange", async () => {
    const page = await exports.default.fetch(`${origin}/auth`);
    expect(page.status).toBe(200);
    expect(page.headers.get("referrer-policy")).toBe("same-origin");
    expect(await page.text()).toContain("接続は完了しません");
    const first = checkTarget(await start());
    const second = checkTarget(await start());
    for (const key of ["state", "nonce", "code_challenge"]) expect(first.searchParams.get(key) !== second.searchParams.get(key)).toBe(true);
    expect(first.searchParams.get("ext_agent_host_id") === second.searchParams.get("ext_agent_host_id")).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects a callback, query injection, wrong method and cross-origin start without network", async () => {
    expect((await exports.default.fetch(`${origin}/auth/callback?code=fixture`)).status).toBe(410);
    expect((await exports.default.fetch(`${origin}/auth/start`)).status).toBe(405);
    expect((await start({ origin: "https://other.invalid" })).status).toBe(403);
    expect((await start({})).status).toBe(403);
    expect((await exports.default.fetch(`${origin}/auth?return_to=fixture`)).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("fails closed for missing identity and an aborted request; never reflects input", async () => {
    for (const PI_OAUTH_HOST_ID of ["", "private-input-must-not-escape"]) {
      const response = await oauthScreen(new Request(`${origin}/auth/start`, { method: "POST", headers: { origin } }), { PI_OAUTH_HOST_ID });
      expect(response.status).toBe(503);
      expect(response.headers.has("location")).toBe(false);
      expect((await response.text()).includes("private-input")).toBe(false);
    }
    const controller = new AbortController(); controller.abort();
    expect((await oauthScreen(new Request(`${origin}/auth/start`, { method: "POST", headers: { origin }, signal: controller.signal }), {})).status).toBe(503);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("preserves the existing listener conflict and succeeds on retry after it closes", async () => {
    const server = createServer();
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(1455, "127.0.0.1", resolve); });
    try {
      const busy = await start();
      expect(busy.status).toBe(503);
      expect(busy.headers.has("location")).toBe(false);
      expect(await busy.text()).toContain("再試行");
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
    checkTarget(await start());
    expect(fetch).not.toHaveBeenCalled();
  });
});
