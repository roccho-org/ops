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

test("derived Pi callback/exchange validates nonce and scope before returning any credential; listener closes", async () => {
  const { openaiChatGPTOAuth } = await import("./dist/oauth.mjs");
  const realFetch = globalThis.fetch;
  for (const failure of [undefined, "nonce", "scope", "cancel"]) {
    const controller = new AbortController();
    let nonce;
    let callback;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url === "https://auth.openai.com/.well-known/jwks.json") {
        return Response.json({ keys: [{ ...await exportJWK(publicKey), kid: "test", alg: "RS256" }] });
      }
      assert.equal(url, "https://auth.openai.com/api/accounts/oauth/token");
      const body = new URLSearchParams(init.body);
      assert.equal(body.get("client_id"), "issued-client");
      assert.equal(init.redirect, "error");
      return Response.json({ access_token: "fixture-access", refresh_token: "fixture-refresh",
        expires_in: 3600, scope: failure === "scope" ? "openid" : "chatgpt.tokens.use.direct",
        id_token: await token({ nonce: failure === "nonce" ? "wrong" : nonce }) });
    };
    try {
      const result = openaiChatGPTOAuth.login({
        signal: controller.signal,
        notify(event) {
          if (event.type !== "auth_url") return;
          const url = new URL(event.url);
          nonce = url.searchParams.get("nonce");
          assert.equal(url.searchParams.get("redirect_uri"), "http://127.0.0.1:1455/auth/callback");
          if (failure === "cancel") { queueMicrotask(() => controller.abort()); return; }
          const destination = new URL("http://127.0.0.1:1455/auth/callback");
          destination.search = new URLSearchParams({ code: "fixture-code",
            state: url.searchParams.get("state"), client_id: "issued-client" }).toString();
          callback = realFetch(destination).then(response => response.text());
        },
        prompt({ signal }) {
          return new Promise((_, reject) => {
            if (signal.aborted) reject(new Error("cancelled"));
            else signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
          });
        },
      }, { getDeviceId: () => "00000000-0000-4000-8000-000000000608" });
      if (failure) await assert.rejects(result);
      else assert.equal((await result).access, "fixture-access");
      await callback;
      await assert.rejects(realFetch("http://127.0.0.1:1455/auth/callback"));
    } finally { controller.abort(); globalThis.fetch = realFetch; }
  }
});

test("derived initial exchange UNKNOWN persists issued registration; returning callback reuses it before POST", async () => {
  const { withRegistration, replaceCredential, ready } = await import("./custody.mjs");
  const { mkdtemp, readFile, unlink, rmdir } = await import("node:fs/promises");
  const dir = await mkdtemp(new URL("./.custody-test-", import.meta.url).pathname);
  const path = dir + "/registration.json";
  const { openaiChatGPTOAuth } = await import("./dist/oauth.mjs");
  const realFetch = globalThis.fetch;
  let calls = 0;
  try {
    await withRegistration(path, async store => {
      for (const stage of ["login", "reauth"]) {
        const controller = new AbortController();
        let nonce, callback;
        globalThis.fetch = async (input, init) => {
          if (String(input).endsWith("/.well-known/jwks.json")) return Response.json({ keys: [{ ...await exportJWK(publicKey), kid: "test", alg: "RS256" }] });
          assert.equal(String(input), "https://auth.openai.com/api/accounts/oauth/token");
          const disk = JSON.parse(await readFile(path, "utf8"));
          assert.equal(disk.state, "IN_DOUBT"); assert.equal(disk.pendingClientId, "issued-client");
          assert.equal(init.redirect, "error"); calls++;
          assert.equal(new URLSearchParams(init.body).get("client_id"), "issued-client");
          if (stage === "login") throw Error("synthetic response lost");
          return Response.json({ access_token: "synthetic-access", refresh_token: "synthetic-refresh",
            expires_in: 3600, scope: "chatgpt.tokens.use.direct", id_token: await token({ nonce }),
            earliest_refresh_at: { syntheticUnspecifiedSchema: true } });
        };
        const execute = () => replaceCredential(store, "00000000-0000-4000-8000-000000000608", stage, () => openaiChatGPTOAuth.login({
          signal: controller.signal,
          notify(event) {
            if(event.type !== "auth_url")return;
            const auth = new URL(event.url); nonce=auth.searchParams.get("nonce");
            assert.equal(auth.searchParams.get("client_id"), stage === "login" ? "dynamic_agent_client" : "issued-client");
            assert.equal(auth.searchParams.has("id_token_hint"), false);
            if(stage === "reauth")assert.equal(auth.searchParams.has("agent_name_hint"),false);
            const url=new URL("http://127.0.0.1:1455/auth/callback");
            url.search=new URLSearchParams({state:auth.searchParams.get("state"),code:"synthetic",...(stage==="login"?{client_id:"issued-client"}:{})});
            callback=realFetch(url).then(r=>r.text());
          },
          prompt({signal}) {return new Promise((_,reject)=>signal.addEventListener("abort",()=>reject(Error("cancelled")),{once:true}));},
        }, { getDeviceId:()=> "00000000-0000-4000-8000-000000000608",
          registeredClientId: stage==="reauth"?store.get().pendingClientId:undefined,
          async beforeTokenExchange(clientId){await store.save({...store.get(),pendingClientId:clientId});}
        }));
        if(stage==="login"){await assert.rejects(execute());assert.throws(()=>ready(store.get(),"00000000-0000-4000-8000-000000000608"));}
        else {
          const result=await execute();
          assert.equal(result.identity.subject,"owner"); assert.equal(result.clientId,"issued-client");
          assert.deepEqual(result.earliestRefreshAt,{syntheticUnspecifiedSchema:true});
          assert.ok(result.actualExpiresAt>Date.now()+3500000);
        }
        await callback; controller.abort();
      }
    });
    assert.equal(calls,2);
    const disk=await readFile(path,"utf8");
    assert.equal(disk.includes("synthetic-code"),false);
    assert.equal(JSON.parse(disk).state,"READY");
  } finally {
    globalThis.fetch=realFetch;
    for(const name of ["registration.json","registration.json.lock"])await unlink(dir+"/"+name).catch(()=>{});
    await rmdir(dir);
  }
});
test("derived refresh rotates using issued client; optional ID validates retained identity, not prior nonce",async()=>{
  const {openaiChatGPTOAuth}=await import("./dist/oauth.mjs");
  const realFetch=globalThis.fetch;
  const credential={access:"synthetic-old",refresh:"synthetic-old-refresh",clientId:"issued-client",
    identity:{subject:"owner"},idToken:"retained-synthetic-id"};
  try {
    for(const mode of ["absent","same","wrong","scope","http"]) {
      let requests=0;
      globalThis.fetch=async(input,init)=>{
        if(String(input).endsWith("/.well-known/jwks.json"))return Response.json({keys:[{...await exportJWK(publicKey),kid:"test",alg:"RS256"}]});
        requests++; assert.equal(init.redirect,"error");
        const body=new URLSearchParams(init.body);
        assert.equal(body.get("grant_type"),"refresh_token");
        assert.equal(body.get("client_id"),"issued-client");
        assert.equal(body.get("refresh_token"),credential.refresh);assert.equal(body.has("scope"),false);
        if(mode==="http")return new Response("synthetic-private-refresh-echo",{status:401});
        return Response.json({access_token:"synthetic-new",refresh_token:"synthetic-rotated",expires_in:3600,
          scope:mode==="scope"?"openid":"chatgpt.tokens.use.direct",
          ...(mode==="absent"?{}:{id_token:await token({sub:mode==="wrong"?"other":"owner",nonce:"new-or-absent-nonce"})})});
      };
      if(["wrong","scope","http"].includes(mode)) {
        await assert.rejects(openaiChatGPTOAuth.refresh(credential,AbortSignal.timeout(1000)),error=>!error.message.includes("synthetic-private"));
      } else {
        const next=await openaiChatGPTOAuth.refresh(credential,AbortSignal.timeout(1000));
        assert.equal(next.refresh,"synthetic-rotated");assert.deepEqual(next.identity,{subject:"owner"});
      }
      assert.equal(requests,1);
    }
  }finally{globalThis.fetch=realFetch;}
});
