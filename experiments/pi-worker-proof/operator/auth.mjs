import { createRemoteJWKSet, jwtVerify } from "jose";

const issuer = "https://auth.openai.com";
const openaiKeys = createRemoteJWKSet(new URL(issuer + "/.well-known/jwks.json"));

/** Independently authored OIDC validation; no token or provider error escapes. */
export async function verifyIdToken(token, clientId, nonce, keys = openaiKeys) {
  try {
    if (!clientId || !nonce) throw new Error();
    const { payload } = await jwtVerify(token, keys, {
      issuer, audience: clientId, algorithms: ["RS256"],
      requiredClaims: ["exp", "iat", "sub", "nonce"],
    });
    if (typeof payload.sub !== "string" || !payload.sub.trim() ||
        payload.nonce !== nonce ||
        (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== clientId) ||
        (payload.azp !== undefined && payload.azp !== clientId)) throw new Error();
    return { subject: payload.sub };
  } catch { throw new Error("ChatGPT identity validation failed"); }
}

/** Origin validation is required even behind Cloudflare Access. */
export async function verifyAccessOwner(token, config, keys) {
  try {
    const origin = new URL(config.issuer);
    if (origin.protocol !== "https:" || origin.origin !== config.issuer ||
        !config.audience || !/^[a-f0-9]{64}$/.test(config.subjectHash)) throw new Error();
    keys ??= createRemoteJWKSet(new URL("/cdn-cgi/access/certs", origin));
    const { payload } = await jwtVerify(token, keys, {
      issuer: config.issuer, audience: config.audience, algorithms: ["RS256"],
      requiredClaims: ["exp", "iat", "sub"],
    });
    if (typeof payload.sub !== "string") throw new Error();
    const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload.sub)))].map(x => x.toString(16).padStart(2, "0")).join("");
    if (hash !== config.subjectHash) throw new Error();
    return true;
  } catch { throw new Error("Worker owner validation failed"); }
}

/** Refresh has no new authorization nonce. Compare verified account and registered client. */
export async function verifyRefreshedIdentity(token, clientId, expected, keys = openaiKeys) {
  try {
    const { payload } = await jwtVerify(token, keys, {
      issuer, audience: clientId, algorithms: ["RS256"], requiredClaims: ["exp", "iat", "sub"],
    });
    if (!expected?.subject || payload.sub !== expected.subject ||
        (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== clientId) ||
        (payload.azp !== undefined && payload.azp !== clientId)) throw new Error();
    return { subject: payload.sub };
  } catch { throw new Error("ChatGPT refresh identity validation failed"); }
}
