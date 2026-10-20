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

test("owner proof rejects foreign origins/host/session before any credential or transport work",async()=>{
  const {proofIdentity}=await import("./owner.mjs");
  const good={url:"https://pi.roccho.workers.dev",session:"owner-jev-proof-20261020",host:"64a8f191-83c2-5eeb-8dc0-612bc80970db",stage:"login"};
  proofIdentity(good);
  for(const delta of [{url:"https://foreign.example"},{url:"http://pi.roccho.workers.dev"},{url:"https://pi.roccho.workers.dev/path"},{url:"https://pi.roccho.workers.dev@foreign.example"},
    {url:"https://pi.roccho.workers.dev/?secret=x"},{host:"00000000-0000-4000-8000-000000000608"},
    {session:"another-session"},{stage:"not-a-stage"},{stage:"seed"},{stage:"recall"}])assert.throws(()=>proofIdentity({...good,...delta}));
});
test("owner native OAuth clears inherited callback override BEFORE module evaluation",async()=>{
  const {execFile}=await import("node:child_process");
  const {promisify}=await import("node:util");
  const result=await promisify(execFile)(process.execPath,["--input-type=module","-e",`
    process.env.PI_OAUTH_CALLBACK_HOST="192.0.2.1";
    const {loadOwnerOAuth}=await import(${JSON.stringify(new URL("./owner.mjs",import.meta.url).href)});
    const {openaiChatGPTOAuth}=await loadOwnerOAuth();
    const abort=new AbortController();let ready=false;
    try{await openaiChatGPTOAuth.login({signal:abort.signal,
      notify(event){if(event.type==="auth_url"){ready=true;abort.abort();}},
      prompt({signal}){return new Promise((_,reject)=>{if(signal.aborted)reject(Error("cancelled"));else signal.addEventListener("abort",()=>reject(Error("cancelled")),{once:true});});}
    },{getDeviceId:()=>"00000000-0000-4000-8000-000000000608"});}catch{}
    if(!ready)process.exit(2);
    console.log("LOOPBACK_LISTENER_READY_AND_CLOSED");
  `],{timeout:5000});
  assert.equal(result.stdout.trim(),"LOOPBACK_LISTENER_READY_AND_CLOSED");
});
test("actual owner witness and completion validators refuse incomplete evidence",async()=>{
  const {proofWitness,completionReceipt,assertDistinctCompletions}=await import("./owner.mjs");
  const good={boot:"00000000-0000-4000-8000-000000000608",posts:2,prior:"false"};
  proofWitness(good,2,"false");
  for(const change of [{boot:undefined},{boot:""},{boot:"not-a-uuid"},{posts:undefined},{posts:NaN},{posts:1.5},{posts:"2"},{prior:"true"},{prior:undefined}]) {
    assert.throws(()=>proofWitness({...good,...change},2,"false"));
  }
  assert.throws(()=>assertDistinctCompletions([{responseId:"one"},{responseId:"two"},{responseId:"one"}]));
  const complete={role:"assistant",responseId:"synthetic-response",stopReason:"stop",rawStopReason:"completed",model:"gpt-6-luna",usage:{input:1,output:1,totalTokens:2}};
  assert.equal(completionReceipt([complete],["stop"]).length,1);
  assert.throws(()=>completionReceipt([{...complete,stopReason:"toolUse"},complete],["toolUse","stop"]));
  for(const change of [{responseId:""},{responseId:17},{rawStopReason:"incomplete"},{stopReason:"error"}]) {
    assert.throws(()=>completionReceipt([{...complete,...change}],["stop"]));
  }
});

test("owner turn completion and result collection are bound to the exact conversation",async()=>{
  const {completedTurn,turnMessages,completionReceipt}=await import("./owner.mjs");
  const frame=(conversationId,text)=>({type:"conversation.events",conversationId,events:[
    {type:"run_end",inputs:["same-submission"]},
    {type:"entry_appended",entry:{id:"same-entry",model:[{role:"assistant",content:[{type:"text",text}]}]}}
  ]});
  const foreign=frame("other-conversation","foreign-marker");
  const matching=frame("selected-conversation","selected-marker");
  assert.equal(completedTurn(foreign,"selected-conversation","same-submission"),false);
  assert.equal(turnMessages([foreign],"selected-conversation").length,0);
  assert.equal(completedTurn(matching,"selected-conversation","same-submission"),true);
  assert.deepEqual(turnMessages([foreign,matching],"selected-conversation"),matching.events[1].entry.model);
  assert.throws(()=>completionReceipt([
    {role:"assistant",responseId:"one",stopReason:"stop",rawStopReason:"completed"},
    {role:"assistant",responseId:"extra",stopReason:"stop",rawStopReason:"completed"}
  ],["stop"]));
});
test("owned socket scope terminates real loopback sockets on failure and owner abort",async()=>{
  const {withOwnerSockets,closeOwnerSocket}=await import("./owner.mjs");
  const {WebSocket,WebSocketServer}=await import("ws");
  const {once}=await import("node:events");
  const server=new WebSocketServer({host:"127.0.0.1",port:0});
  await once(server,"listening");
  try {
    for(const mode of ["failure","abort"]) {
      const abort=new AbortController();
      let socket,closed;
      const attempt=withOwnerSockets(abort.signal,async sockets=>{
        socket=new WebSocket("ws://127.0.0.1:"+server.address().port);
        socket.on("error",()=>{});sockets.add(socket);
        await once(socket,"open");
        closed=once(socket,"close");
        if(mode==="failure")throw Error("synthetic timeout after open");
        abort.abort(); await closed;abort.signal.throwIfAborted();
      });
      await assert.rejects(attempt);
      await closed;
      assert.equal(socket.readyState,WebSocket.CLOSED);
      await Promise.race([closeOwnerSocket(socket,abort.signal),new Promise((_,reject)=>setTimeout(()=>reject(Error("closed socket did not settle")),250))]);
    }
  }finally {
    for(const socket of server.clients)socket.terminate();
    await new Promise(resolve=>server.close(resolve));
  }
});
