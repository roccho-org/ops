import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";

const upstream = resolve(process.argv[2] ?? ".");
const requireUpstream = createRequire(upstream + "/package.json");
const { build } = createRequire(requireUpstream.resolve("vite"))("esbuild");
const ai = resolve(upstream, "node_modules/@earendil-works/pi-ai/dist");
const original = await readFile(ai + "/auth/oauth/openai-chatgpt.js", "utf8");
let patched = original;
function replace(before, after) {
  if (patched.split(before).length !== 2) throw new Error("Pinned OAuth seam changed");
  patched = patched.replace(before, after);
}
replace('import { randomBytes } from "node:crypto";',
  'import { randomBytes } from "node:crypto";\nimport { verifyIdToken, verifyRefreshedIdentity } from ' + JSON.stringify(resolve(import.meta.dirname, "auth.mjs")) + ';');
replace("exchangeAuthorizationCode(code, verifier, clientId, signal)", "exchangeAuthorizationCode(code, verifier, clientId, nonce, signal)");
replace("exchangeAuthorizationCode(result.code, verifier, result.clientId, interaction.signal)", "exchangeAuthorizationCode(result.code, verifier, result.clientId, nonce, interaction.signal)");
replace("    return credentialFromTokenResponse(token, clientId);\n}\nasync function refreshAccessToken",
  "    const identity = await verifyIdToken(token.id_token, clientId, nonce);\n    return { ...credentialFromTokenResponse(token, clientId), identity };\n}\nasync function refreshAccessToken");
replace('throw new Error(`OpenAI OAuth token request failed (${response.status}): ${responseBody || response.statusText}`);',
  'throw new Error("OpenAI OAuth token request failed");');
// Narrow deterministic compatibility seams in the frozen MIT Pi module, not another OAuth stack.
replace('        method: "POST",', '        method: "POST",\n        redirect: "error",');
replace('        scopes,\n', '        scopes,\n        savedAt: Date.now(),\n        actualExpiresAt: Date.now() + token.expires_in * 1000,\n        earliestRefreshAt: token.earliest_refresh_at,\n        idToken: token.id_token,\n');
replace('    return credentialFromTokenResponse(token, clientId);\n}\n/** OpenAI',
  '    const identity = token.id_token === undefined ? credential.identity : await verifyRefreshedIdentity(token.id_token, clientId, credential.identity);\n    return { ...credentialFromTokenResponse(token, clientId), identity, idToken: token.id_token ?? credential.idToken };\n}\n/** OpenAI');
replace('function authorizationResultFromCallback(url, expectedState)', 'function authorizationResultFromCallback(url, expectedState, registeredClient)');
replace('    const clientId = url.searchParams.get("client_id")?.trim();',
  '    const returnedClient = url.searchParams.get("client_id")?.trim();\n    if (registeredClient && returnedClient && registeredClient !== returnedClient) throw new Error("Registered client mismatch");\n    const clientId = returnedClient || registeredClient;');
replace('function authorizationResultFromManualInput(input, expectedState)', 'function authorizationResultFromManualInput(input, expectedState, registeredClient)');
replace('return authorizationResultFromCallback(url, expectedState);', 'return authorizationResultFromCallback(url, expectedState, registeredClient);');
replace('function startCallbackServer(expectedState)', 'function startCallbackServer(expectedState, registeredClient)');
replace('authorizationResult = authorizationResultFromCallback(url, expectedState);', 'authorizationResult = authorizationResultFromCallback(url, expectedState, registeredClient);');
replace('await startCallbackServer(state)', 'await startCallbackServer(state, options?.registeredClientId)');
replace('        return await exchangeAuthorizationCode(result.code, verifier, result.clientId, nonce, interaction.signal);',
  '        await options?.beforeTokenExchange?.(result.clientId);\n        return await exchangeAuthorizationCode(result.code, verifier, result.clientId, nonce, interaction.signal);');
replace('client_id: DYNAMIC_CLIENT_ID,', 'client_id: options?.registeredClientId ?? DYNAMIC_CLIENT_ID,');
replace('    interaction.notify({\n        type: "auth_url",',
  '    if (options?.registeredClientId) authorizationUrl.searchParams.delete("agent_name_hint");\n    interaction.notify({\n        type: "auth_url",');
replace('authorizationResultFromManualInput(input, state)', 'authorizationResultFromManualInput(input, state, options?.registeredClientId)');
const out = resolve(import.meta.dirname, "dist");
await mkdir(out, { recursive: true });
await writeFile(out + "/oauth.original.js", original);
await writeFile(out + "/oauth.verified.js", patched);
await build({ stdin: { contents: patched, resolveDir: ai + "/auth/oauth", sourcefile: "oauth.verified.js" },
  bundle: true, platform: "node", format: "esm", outfile: out + "/oauth.mjs" });
await build({ entryPoints: [resolve(import.meta.dirname, "auth.mjs")],
  bundle: true, platform: "browser", format: "esm", outfile: out + "/auth.mjs" });
