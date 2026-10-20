import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from "jose";
import { verifyIdToken, verifyAccessOwner } from "./auth.mjs";

const { privateKey, publicKey } = await generateKeyPair("RS256");
const keys = createLocalJWKSet({ keys: [{ ...await exportJWK(publicKey), kid: "test", alg: "RS256" }] });
const now = Math.floor(Date.now() / 1000);
async function token(change = {}, omit = []) {
  const claims = { iss: "https://auth.openai.com", aud: "issued-client", sub: "owner",
    nonce: "expected", iat: now, exp: now + 300, ...change };
  for (const key of omit) delete claims[key];
  return new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "test" }).sign(privateKey);
}
test("OIDC signature, issued audience, nonce and required claims", async () => {
  assert.deepEqual(await verifyIdToken(await token(), "issued-client", "expected", keys), { subject: "owner" });
  for (const change of [{ iss: "https://wrong.example" }, { aud: "wrong" }, { nonce: "wrong" },
    { sub: "" }, { exp: now - 10 }, { aud: ["issued-client", "other"] }, { azp: "other" }]) {
    await assert.rejects(verifyIdToken(await token(change), "issued-client", "expected", keys), /identity validation failed/);
  }
  for (const key of ["exp", "iat", "sub", "nonce"]) {
    await assert.rejects(verifyIdToken(await token({}, [key]), "issued-client", "expected", keys));
  }
  await assert.rejects(verifyIdToken(await token(), "issued-client", "expected",
    async () => { throw new Error("private JWKS failure"); }), /identity validation failed/);
  const other = await generateKeyPair("RS256");
  const forged = await new SignJWT({ iss: "https://auth.openai.com", aud: "issued-client",
    sub: "owner", nonce: "expected", iat: now, exp: now + 30 })
    .setProtectedHeader({ alg: "RS256", kid: "test" }).sign(other.privateKey);
  await assert.rejects(verifyIdToken(forged, "issued-client", "expected", keys));
});
test("Access origin verifies exact owner; missing config and all wrong claims fail closed", async () => {
  const config = { issuer: "https://team.cloudflareaccess.com", audience: "app", subjectHash: createHash("sha256").update("owner").digest("hex") };
  const good = await token({ iss: config.issuer, aud: config.audience });
  assert.equal(await verifyAccessOwner(good, config, keys), true);
  for (const change of [{ iss: "https://wrong.example" }, { aud: "wrong" }, { sub: "other" },
    { exp: now - 5 }]) {
    await assert.rejects(verifyAccessOwner(await token({ iss: config.issuer, aud: config.audience, ...change }), config, keys));
  }
  await assert.rejects(verifyAccessOwner(good, { ...config, subjectHash: "" }, keys));
  await assert.rejects(verifyAccessOwner(good, config, async () => { throw new Error("private"); }));
});
