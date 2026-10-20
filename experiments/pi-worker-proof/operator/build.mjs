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
  'import { randomBytes } from "node:crypto";\nimport { verifyIdToken } from ' + JSON.stringify(resolve(import.meta.dirname, "auth.mjs")) + ';');
replace("exchangeAuthorizationCode(code, verifier, clientId, signal)", "exchangeAuthorizationCode(code, verifier, clientId, nonce, signal)");
replace("exchangeAuthorizationCode(result.code, verifier, result.clientId, interaction.signal)", "exchangeAuthorizationCode(result.code, verifier, result.clientId, nonce, interaction.signal)");
replace("    return credentialFromTokenResponse(token, clientId);\n}\nasync function refreshAccessToken",
  "    await verifyIdToken(token.id_token, clientId, nonce);\n    return credentialFromTokenResponse(token, clientId);\n}\nasync function refreshAccessToken");
replace('throw new Error(`OpenAI OAuth token request failed (${response.status}): ${responseBody || response.statusText}`);',
  'throw new Error("OpenAI OAuth token request failed");');
patched = patched.replaceAll("\\\n", "\n");
const out = resolve(import.meta.dirname, "dist");
await mkdir(out, { recursive: true });
await writeFile(out + "/oauth.original.js", original);
await writeFile(out + "/oauth.verified.js", patched);
await build({ stdin: { contents: patched, resolveDir: ai + "/auth/oauth", sourcefile: "oauth.verified.js" },
  bundle: true, platform: "node", format: "esm", outfile: out + "/oauth.mjs" });
await build({ entryPoints: [resolve(import.meta.dirname, "auth.mjs")],
  bundle: true, platform: "browser", format: "esm", outfile: out + "/auth.mjs" });
