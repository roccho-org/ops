import { openaiChatGPTOAuth } from "pi-proof-openai-oauth";

declare global { interface Env { PI_OAUTH_HOST_ID?: string } }

const headers = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  // A no-referrer document makes native form POST Origin:null. Preserve same-origin
  // form checks here, then suppress Referer on the external redirect below.
  "referrer-policy": "same-origin",
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; form-action 'self' https://auth.openai.com; frame-ancestors 'none'; base-uri 'none'",
};
const page = (failed = false) => `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Pi Worker — 認証画面の確認</title><h1>Pi Worker</h1><p>認証画面の表示確認のみです。ChatGPTとの接続は完了しません。</p><p>移動先でアカウント選択・同意は行わず、画面確認後にこのページへ戻ってください。認証情報の発行・保存・推論は行いません。</p>${failed ? '<p role="alert">認証画面を開けませんでした。設定を確認して再試行してください。</p>' : ''}<form action="/auth/start" method="post"><button>${failed ? '再試行' : 'OpenAIの認証画面を開く'}</button></form></html>`;
const reply = (body: string, status: number, extra: HeadersInit = {}) =>
  new Response(body, { status, headers: { ...headers, ...extra } });

/** Screen-only slice. Pi creates PKCE/state/nonce and closes its own listener.
 * Never accept a callback/code, return a credential, call refresh, or open a DO.
 * The deployment entry uses this same handler, without the chat entrypoint.
 */
export async function oauthScreen(request: Request, env: { PI_OAUTH_HOST_ID?: string }): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/auth/callback") return reply("認証は完了していません。画面確認の試行は終了しました。", 410);
  if (url.search) return reply("URLパラメーターは受け付けません。", 400);
  if (url.pathname === "/" || url.pathname === "/auth" || url.pathname === "/auth/") {
    return request.method === "GET" ? reply(page(), 200) : reply("Method not allowed", 405, { allow: "GET" });
  }
  if (url.pathname !== "/auth/start") return reply("Not found", 404);
  if (request.method !== "POST") return reply("Method not allowed", 405, { allow: "POST" });
  if (request.headers.get("origin") !== url.origin) return reply("Same-origin form required", 403);
  if (request.signal.aborted) return reply(page(true), 503);

  const ended = new Error("SCREEN_ONLY_STOP_BEFORE_CODE");
  let target: string | undefined;
  try {
    await openaiChatGPTOAuth.login({
      signal: request.signal,
      notify(event) { if (event.type === "auth_url") target = event.url; },
      // Rejection follows Pi's own finally/close path; never provide an authorization code.
      async prompt() { throw ended; },
    }, { getDeviceId: () => env.PI_OAUTH_HOST_ID ?? "", agentName: "Pi Worker" });
  } catch (error) {
    if (error === ended && target && !request.signal.aborted) {
      const destination = new URL(target);
      if (destination.origin === "https://auth.openai.com" && destination.pathname === "/api/accounts/authorize") {
        return reply("", 303, { location: target, "referrer-policy": "no-referrer" });
      }
    }
  }
  // Never reflect SDK errors or URLs: either can contain authorization material.
  return reply(page(true), 503, { "retry-after": "1" });
}
