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
function automaticRootFrames() {
  return [
    { type: "session.snapshot", session: { conversations: [{ id: 1 }], activity: { tasks: {} } } },
    { type: "conversation.events", conversationId: 1, events: [{
      type: "snapshot", entries: [], tools: [], nestedTools: [], compactions: [], inbox: [],
      agent: {}, usage: { models: {}, tools: {} },
    }] },
    { type: "conversation.inbox", conversationId: 1, items: [] },
    { type: "presence.typing", conversationId: 1, usernames: [] },
  ];
}
test("reconciliation requires every explicit empty root field and preserves the original UNKNOWN", async () => {
  const { emptyRootCertificate, proofStageAllowed, parseOwnerFrame } = await import("./owner.mjs");
  const witness = { boot: "00000000-0000-4000-8000-000000000608", posts: 0, prior: "false" };
  const certificate = emptyRootCertificate(automaticRootFrames(), witness);
  const original = { state: "UNKNOWN", attemptedStage: "seed" };
  assert.throws(() => proofStageAllowed(original, "seed"));
  proofStageAllowed(original, "reconcile");
  assert.throws(() => proofStageAllowed({ ...original, reconciliation: { state: "UNKNOWN" } }, "reconcile"));
  const reconciled = { state: "RECONCILED_EMPTY", originalUnknown: original, reconciliation: certificate };
  proofStageAllowed(reconciled, "seed");
  assert.deepEqual(reconciled.originalUnknown, original);
  for (const change of [{ originalUnknown: undefined }, { reconciliation: { ...certificate, posts: 1 } },
    { reconciliation: { ...certificate, boot: "" } }]) assert.throws(() => proofStageAllowed({ ...reconciled, ...change }, "seed"));
  for (const mutate of [
    f => f.splice(0, 1), f => f.splice(1, 1), f => f.splice(2, 1),
    f => { delete f[0].session.activity; },
    f => { f[0].session.activity.tasks = { pending: {} }; },
    f => { f[0].session.conversations.push({ id: 2 }); },
    f => { f[0].session.conversations[0].parent = 2; },
    f => { f[0].session.conversations[0].owner = "task"; },
    f => { f[1].conversationId = 2; },
    f => { f[1].events[0].entries = [{ id: 1 }]; },
    f => { delete f[1].events[0].nestedTools; },
    f => { f[1].events[0].tools = null; },
    f => { f[1].events[0].nestedTools = [{}]; },
    f => { f[1].events[0].compactions = [{}]; },
    f => { f[1].events[0].inbox = [{}]; },
    f => { f[1].events[0].run = {}; },
    f => { f[1].events[0].generation = {}; },
    f => { f[1].events[0].compactionFailure = {}; },
    f => { f[1].events[0].usage.models = { model: {} }; },
    f => { delete f[1].events[0].usage.tools; },
    f => { f[1].events[0].agent = null; },
    f => { f[2].items = [{}]; },
    f => { delete f[2].items; },
    f => { f[2].conversationId = 2; },
    f => { f[3].usernames = ["other"]; },
    f => { f.push({ type: "session.activity", activity: { tasks: { pending: {} } } }); },
    f => { f.push({ type: "command.error", detail: "synthetic-private" }); },
  ]) {
    const frames = automaticRootFrames(); mutate(frames);
    assert.throws(() => emptyRootCertificate(frames, witness));
  }
  for (const change of [{ posts: 1 }, { posts: "0" }, { boot: "" }, { prior: undefined }])
    assert.throws(() => emptyRootCertificate(automaticRootFrames(), { ...witness, ...change }));
  assert.deepEqual(parseOwnerFrame("not-json-synthetic-private"), { type: "invalid.owner.frame" });
  assert.throws(() => emptyRootCertificate([...automaticRootFrames(), parseOwnerFrame("not-json-synthetic-private")], witness));
});
test("real loopback reconciliation receives automatic root frames and sends ZERO client commands", async () => {
  const { reconcileConnection, waitOwnerFrame, closeOwnerSocket, parseOwnerFrame, withOwnerSockets } = await import("./owner.mjs");
  const { WebSocket, WebSocketServer } = await import("ws");
  const { once } = await import("node:events");
  for (const mode of ["empty", "nonempty", "incomplete", "malformed"]) {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    let sentCommands = 0;
    server.on("connection", socket => {
      socket.on("message", () => sentCommands++);
      const frames = automaticRootFrames();
      if (mode === "nonempty") frames[1].events[0].entries.push({ id: "prior-input" });
      if (mode === "incomplete") frames.splice(2, 1);
      for (const frame of frames) socket.send(JSON.stringify(frame));
      if (mode === "malformed") socket.send("not-json-synthetic-private");
    });
    const abort = new AbortController();
    try {
      await withOwnerSockets(abort.signal, async sockets => {
        const frames = [];
        const socket = new WebSocket("ws://127.0.0.1:" + server.address().port);
        sockets.add(socket); socket.on("error", () => {});
        socket.on("message", data => {
          const frame = parseOwnerFrame(data); frames.push(frame);
          if (frame?.type === "invalid.owner.frame") socket.terminate();
        });
        await once(socket, "open");
        const connection = {
          frames, witness: { boot: "00000000-0000-4000-8000-000000000608", posts: 0, prior: "true" },
          wait: predicate => waitOwnerFrame(frames, socket, predicate, abort.signal, 100),
          close: () => closeOwnerSocket(socket, abort.signal),
        };
        if (mode !== "empty") await assert.rejects(reconcileConnection(connection));
        else assert.deepEqual(await reconcileConnection(connection),
          { boot: connection.witness.boot, posts: 0, rootId: 1, empty: true });
        if (mode !== "incomplete") assert.equal(socket.readyState, WebSocket.CLOSED);
      });
      assert.equal(sentCommands, 0);
    } finally {
      for (const socket of server.clients) socket.terminate();
      await new Promise(resolve => server.close(resolve));
    }
  }
});
test("forensic admission is durable once before external work and retains both UNKNOWN histories", async () => {
  const { mkdtemp, readFile, unlink, rmdir } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { withRegistration } = await import("./custody.mjs");
  const { beginReconciliation, saveEmptyReconciliation, proofStageAllowed, proofIdentity } = await import("./owner.mjs");
  const dir = await mkdtemp(tmpdir() + "/owner-forensic-");
  const path = dir + "/registration.json";
  const initial = { state: "READY", proof: { state: "UNKNOWN", attemptedStage: "seed", reconciliation: { state: "UNKNOWN" } } };
  try {
    await withRegistration(path, store => store.save(initial));
    const before = await readFile(path, "utf8");
    await withRegistration(path, async store => {
      await assert.rejects(beginReconciliation(store, true, Date.now() - 1));
      assert.equal(await readFile(path, "utf8"), before);
      await assert.rejects(beginReconciliation(store, false, Date.now() + 300000));
    });
    const child = `
      const {withRegistration}=await import(${JSON.stringify(new URL("./custody.mjs", import.meta.url).href)});
      const {beginReconciliation}=await import(${JSON.stringify(new URL("./owner.mjs", import.meta.url).href)});
      await withRegistration(process.argv[1], async store => {
        await beginReconciliation(store,true,Date.now()+300000);
        console.log("DURABLE_FORENSIC_ADMISSION_BEFORE_EXTERNAL");
      }).catch(()=>{console.error("FORENSIC_REFUSED");process.exitCode=1;});
    `;
    const execute = () => promisify(execFile)(process.execPath, ["--input-type=module", "-e", child, path], { timeout: 5000 });
    assert.equal((await execute()).stdout.trim(), "DURABLE_FORENSIC_ADMISSION_BEFORE_EXTERNAL");
    // A separate process sees the consumed admission even though no external action ran.
    await assert.rejects(execute(), error => error.stderr.trim() === "FORENSIC_REFUSED");
    const marked = JSON.parse(await readFile(path, "utf8"));
    assert.deepEqual(marked.proof.reconciliation, { state: "UNKNOWN", forensicOnce: { state: "UNKNOWN" } });
    assert.equal(marked.proof.state, "UNKNOWN");
    await withRegistration(path, async store => {
      assert.throws(() => proofStageAllowed(store.get().proof, "reconcile"));
      assert.throws(() => proofStageAllowed(store.get().proof, "reconcile", true));
      const certificate = { boot: "00000000-0000-4000-8000-000000000608", posts: 0, rootId: 1, empty: true };
      await saveEmptyReconciliation(store, certificate);
      assert.deepEqual(store.get().proof.originalUnknown, marked.proof);
      assert.deepEqual(store.get().proof.reconciliation, certificate);
      proofStageAllowed(store.get().proof, "seed");
      assert.throws(() => proofStageAllowed(store.get().proof, "reconcile", true));
    });
    assert.throws(() => proofStageAllowed({ state: "UNKNOWN", attemptedStage: "seed" }, "reconcile", true));
    assert.throws(() => proofIdentity({ url: "https://pi.roccho.workers.dev", session: "owner-jev-proof-20261020",
      host: "64a8f191-83c2-5eeb-8dc0-612bc80970db", stage: "seed", continue: true, "forensic-once": true }));
    for (const forensicOnce of [null, false, {}, { state: "UNKNOWN" }])
      assert.throws(() => proofStageAllowed({ ...initial.proof, reconciliation: { state: "UNKNOWN", forensicOnce } }, "reconcile", true));
  } finally {
    for (const name of ["registration.json", "registration.json.lock"]) await unlink(dir + "/" + name).catch(() => {});
    await rmdir(dir);
  }
});
test("actual owner socket observer distinguishes HTTP401,101-close,timeout and poison without payload diagnostics", async () => {
  const { observeOwnerSocket, safeOwnerErrorCode, safeWitnessStatus, withOwnerSockets, waitOwnerFrame, reconcileConnection, closeOwnerSocket } = await import("./owner.mjs");
  const { WebSocket, WebSocketServer } = await import("ws");
  const { createServer, validateHeaderValue } = await import("node:http");
  const { once } = await import("node:events");
  assert.equal(safeOwnerErrorCode({ code: "ECONNRESET", message: "synthetic-private" }), "ECONNRESET");
  assert.equal(safeOwnerErrorCode({ code: "synthetic-private" }), "OTHER");
  assert.equal(safeOwnerErrorCode(new Error("synthetic-private")), "UNKNOWN");
  assert.deepEqual(safeWitnessStatus(undefined), { bootPresent: false, bootValid: false, posts: null, priorToken: null });
  assert.deepEqual(safeWitnessStatus({ boot: "invalid", posts: "0", prior: undefined }),
    { bootPresent: true, bootValid: false, posts: null, priorToken: null });
  assert.deepEqual(safeWitnessStatus({ boot: "00000000-0000-4000-8000-000000000608", posts: 0, prior: "false" }),
    { bootPresent: true, bootValid: true, posts: 0, priorToken: false });
  try { validateHeaderValue("synthetic-header", "\n"); assert.fail("Invalid header accepted"); }
  catch (error) { assert.equal(safeOwnerErrorCode(error), "ERR_INVALID_CHAR"); }
  for (const mode of ["401", "close", "timeout", "malformed", "empty"]) {
    const http = createServer();
    const server = new WebSocketServer({ noServer: true });
    let commands = 0;
    server.on("headers", headers => headers.push("Pi-Proof-Boot: 00000000-0000-4000-8000-000000000608", "Pi-Proof-Prior-Token: false", "Pi-Proof-Posts: 0"));
    http.on("upgrade", (request, socket, head) => {
      if (mode === "401") socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
      else server.handleUpgrade(request, socket, head, connection => server.emit("connection", connection));
    });
    server.on("connection", socket => {
      socket.on("message", () => commands++);
      if (mode === "close") socket.close();
      if (mode === "malformed" || mode === "empty") {
        for (const frame of automaticRootFrames()) socket.send(JSON.stringify(frame));
        if (mode === "malformed") socket.send("synthetic-private-malformed");
      }
    });
    http.listen(0, "127.0.0.1"); await once(http, "listening");
    const abort = new AbortController();
    try {
      await withOwnerSockets(abort.signal, async sockets => {
        const frames = [];
        const socket = new WebSocket("ws://127.0.0.1:" + http.address().port);
        sockets.add(socket);
        const trace = observeOwnerSocket(socket, frames);
        const opened = new Promise((resolve, reject) => {
          socket.once("open", resolve); socket.once("error", reject);
        });
        if (mode === "401") {
          await assert.rejects(opened);
          assert.equal(trace.httpStatus, 401); assert.equal(trace.upgradeSeen101, false);
        } else {
          await opened;
          assert.equal(trace.httpStatus, 101); assert.equal(trace.upgradeSeen101, true);
          const connection = { frames, witness: trace.witness,
            wait: predicate => waitOwnerFrame(frames, socket, predicate, abort.signal, 80),
            close: () => closeOwnerSocket(socket, abort.signal) };
          let verified = false;
          const verify = () => { assert.equal(socket.readyState, WebSocket.CLOSED); verified = true; };
          if (mode === "empty") assert.equal((await reconcileConnection(connection, verify)).empty, true);
          else await assert.rejects(reconcileConnection(connection, verify));
          assert.equal(verified, mode === "empty" || mode === "malformed");
        }
        assert.equal(JSON.stringify(trace).includes("synthetic-private"), false);
      });
      assert.equal(commands, 0);
    } finally {
      for (const socket of server.clients) socket.terminate();
      await new Promise(resolve => server.close(resolve));
      await new Promise(resolve => http.close(resolve));
    }
  }
});
function historyFrames(children = [], rootEntries = []) {
  const frames = automaticRootFrames();
  frames[0].session.conversations.push(...children);
  frames[1].events[0].entries = rootEntries;
  return frames;
}
const historyWitness = posts => ({ boot: "00000000-0000-4000-8000-000000000608", posts, prior: "true" });
test("actual history selector preserves observed posts and refuses ambiguous/task/fork/root-work inventories", async () => {
  const { historyTarget, summarizeHistory } = await import("./owner.mjs");
  for (const posts of [1,2,3]) {
    assert.equal(historyTarget(historyFrames(), historyWitness(posts)).conversationId, 1);
    assert.equal(summarizeHistory(historyFrames(), 1, historyWitness(posts)).postsAtUpgrade, posts);
  }
  assert.equal(historyTarget(historyFrames([{ id: 9 }]), historyWitness(1)).conversationId, 9);
  assert.equal(historyTarget(historyFrames([], [{ model: [{ role: "user", content: "synthetic-private" }] }]), historyWitness(1)).conversationId, 1);
  for (const frames of [
    historyFrames([{ id: 2 }, { id: 3 }]), historyFrames([{ id: 2, parent: { conversationId: 1, at: 1 } }]),
    historyFrames([{ id: 2, owner: { conversationId: 1 } }]), historyFrames([{ id: 1 }]),
    historyFrames([{ id: "2" }]), historyFrames([{ id: 2 }], [{ model: [] }]),
  ]) assert.equal(historyTarget(frames, historyWitness(1)).conversationId, undefined);
  for (const mutate of [
    f => { delete f[0].session.activity; }, f => { f[0].session.activity.tasks = { pending: {} }; },
    f => { f[0].session.conversations = [{ id: 2 }]; }, f => { delete f[1].events[0].inbox; },
    f => { f[1].events[0].usage.extra = {}; }, f => { f.push({ type: "invalid.owner.frame" }); },
  ]) { const frames = historyFrames([{ id: 2 }]); mutate(frames); assert.equal(historyTarget(frames, historyWitness(1)).conversationId, undefined); }
  for (const posts of [0,4,"1",undefined]) assert.equal(historyTarget(historyFrames(), historyWitness(posts)).conversationId, undefined);
});
test("history model-error classification and typed Jev correlation never expose private content or infer HTTP cause", async () => {
  const { summarizeHistory } = await import("./owner.mjs");
  const messages = [
    { role: "user", content: "synthetic-private-marker" },
    { role: "assistant", content: [{ type: "toolCall", name: "ask_jev", id: "call-1" }], stopReason: "toolUse", rawStopReason: "completed", responseId: "response-1" },
    { role: "toolResult", toolName: "ask_jev", toolCallId: "call-1", isError: false, content: [{ type: "text", text: '{"type":"noul","noul":0.419}' }] },
    { role: "assistant", stopReason: "error", errorMessage: "synthetic-private-provider-echo", content: [] },
  ];
  const frames = () => historyFrames([], [{ model: structuredClone(messages) }]);
  const good = summarizeHistory(frames(), 1, historyWitness(1));
  assert.equal(good.classification, "MODEL_ERROR_OR_ABORT_OBSERVED");
  assert.equal(good.matchedTypedJevResultCount, 1);
  assert.equal(good.providerHttpCause, "UNAVAILABLE_FROM_MASKED_HISTORY");
  assert.equal(JSON.stringify(good).includes("synthetic-private"), false);
  assert.equal(JSON.stringify(good).includes("0.419"), false);
  const compacting = frames(); compacting[1].events[0].compactions.push({ id: "synthetic-live" });
  const live = summarizeHistory(compacting, 1, historyWitness(1));
  assert.equal(live.pendingObserved, true); assert.equal(live.classification, "LIVE_OR_UNRESOLVED_STATE");
  for (const mutate of [
    m => { m[2].isError = true; }, m => { m[2].toolCallId = "other"; },
    m => { m[1].content[0].name = "another-tool"; }, m => { m[2].toolName = "another-tool"; },
    m => { m[2].content[0].text = "synthetic-private-invalid"; },
    m => { m[2].content[0].text = '{"type":"noul","noul":2}'; },
    m => { m[2].content.push({ type: "image", data: "synthetic-private" }); },
    m => { m[1].content.push({ ...m[1].content[0] }); },
  ]) {
    const changed = frames(); mutate(changed[1].events[0].entries[0].model);
    assert.equal(summarizeHistory(changed, 1, historyWitness(1)).matchedTypedJevResultCount, 0);
  }
});
test("history admission is a distinct durable one-shot and observation preserves all UNKNOWN audits", async () => {
  const { mkdtemp, readFile, unlink, rmdir } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { withRegistration } = await import("./custody.mjs");
  const { beginHistoryInspection, saveHistoryObservation, proofStageAllowed } = await import("./owner.mjs");
  const dir = await mkdtemp(tmpdir() + "/owner-history-"), path = dir + "/registration.json";
  const prior = { state: "UNKNOWN", attemptedStage: "seed", reconciliation: { state: "UNKNOWN", forensicOnce: { state: "UNKNOWN" } } };
  try {
    await withRegistration(path, store => store.save({ state: "READY", proof: prior }));
    const before = await readFile(path, "utf8");
    await withRegistration(path, async store => {
      await assert.rejects(beginHistoryInspection(store, Date.now() - 1));
      assert.equal(await readFile(path, "utf8"), before);
    });
    const child = `
      const {withRegistration}=await import(${JSON.stringify(new URL("./custody.mjs", import.meta.url).href)});
      const {beginHistoryInspection}=await import(${JSON.stringify(new URL("./owner.mjs", import.meta.url).href)});
      await withRegistration(process.argv[1], async store => {
        await beginHistoryInspection(store,Date.now()+300000);console.log("HISTORY_ADMISSION_DURABLE_BEFORE_EXTERNAL");
      }).catch(()=>{console.error("HISTORY_REFUSED");process.exitCode=1;});
    `;
    const execute = () => promisify(execFile)(process.execPath, ["--input-type=module", "-e", child, path], { timeout: 5000 });
    assert.equal((await execute()).stdout.trim(), "HISTORY_ADMISSION_DURABLE_BEFORE_EXTERNAL");
    await assert.rejects(execute(), error => error.stderr.trim() === "HISTORY_REFUSED");
    await withRegistration(path, async store => {
      assert.deepEqual(store.get().proof, { ...prior, historyInspection: { state: "UNKNOWN" } });
      await saveHistoryObservation(store, { classification: "MODEL_ERROR_OR_ABORT_OBSERVED", inspected: true, errorOrAbortCount: 1 });
      assert.deepEqual(store.get().proof.reconciliation, prior.reconciliation);
      assert.equal(store.get().proof.state, "UNKNOWN");
      assert.equal(store.get().proof.historyInspection.state, "OBSERVED");
      assert.throws(() => proofStageAllowed(store.get().proof, "seed"));
      assert.throws(() => proofStageAllowed(store.get().proof, "history"));
    });
    for (const marker of [null,false,{}, { state: "UNKNOWN" }]) assert.throws(() => proofStageAllowed({ ...prior, historyInspection: marker }, "history"));
    assert.throws(() => proofStageAllowed({ ...prior, reconciliation: { state: "UNKNOWN" } }, "history"));
  } finally {
    for (const name of ["registration.json","registration.json.lock"]) await unlink(dir + "/" + name).catch(() => {});
    await rmdir(dir);
  }
});
test("real history loopback sends ZERO commands for root/ambiguity or exactly ONE inventory-selected open", async () => {
  const { observeOwnerSocket, withOwnerSockets, waitOwnerFrame, closeOwnerSocket, inspectHistoryConnection } = await import("./owner.mjs");
  const { WebSocket, WebSocketServer } = await import("ws");
  const { once } = await import("node:events");
  for (const mode of ["root", "child", "multiple", "task", "root-and-child", "private-malformed", "child-foreign", "child-badframe", "child-rootupdate", "child-rootresnapshot"]) {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const commands = [];
    server.on("headers", headers => headers.push("Pi-Proof-Boot: 00000000-0000-4000-8000-000000000608", "Pi-Proof-Prior-Token: true", "Pi-Proof-Posts: 1"));
    server.on("connection", socket => {
      const children = mode === "multiple" ? [{ id: 9 },{ id: 10 }] : mode === "task" ? [{ id: 9, owner: { conversationId: 1 } }] :
        ["child","root-and-child","child-foreign","child-badframe","child-rootupdate","child-rootresnapshot"].includes(mode) ? [{ id: 9 }] : [];
      const entries = ["root","root-and-child"].includes(mode) ? [{ model: [{ role: "assistant", stopReason: "error", errorMessage: "synthetic-private" }] }] : [];
      for (const frame of historyFrames(children, entries)) socket.send(JSON.stringify(frame));
      if (mode === "private-malformed") socket.send("synthetic-private-malformed");
      socket.on("message", data => {
        const command = JSON.parse(String(data)); commands.push(command);
        assert.equal(command.type, "conversation.open"); assert.equal(command.conversationId, 9);
        const opened = historyFrames([], [{ model: [{ role: "assistant", stopReason: "error", errorMessage: "synthetic-private" }] }]);
        for (const frame of opened.slice(1,3)) socket.send(JSON.stringify({ ...frame, conversationId: 9 }));
        socket.send(JSON.stringify({ type: "command.result", command: "conversation.open", requestId: command.requestId, ok: true }));
        if (mode === "child-foreign") socket.send(JSON.stringify({ ...opened[1], conversationId: 777 }));
        if (mode === "child-badframe") socket.send(JSON.stringify({ type: "conversation.inbox", items: [] }));
        if (mode === "child-rootupdate") socket.send(JSON.stringify({ type: "conversation.events", conversationId: 1,
          events: [{ type: "entry_appended", entry: { model: [{ role: "assistant", content: "synthetic-private" }] } }] }));
        if (mode === "child-rootresnapshot") socket.send(JSON.stringify(opened[1]));
      });
    });
    const abort = new AbortController();
    try {
      await withOwnerSockets(abort.signal, async sockets => {
        const frames = [], socket = new WebSocket("ws://127.0.0.1:" + server.address().port);
        sockets.add(socket); const trace = observeOwnerSocket(socket, frames);
        await once(socket, "open");
        const wait = predicate => waitOwnerFrame(frames, socket, predicate, abort.signal, 500);
        await wait(frame => frame?.type === "session.snapshot");
        const connection = { frames, witness: trace.witness, wait,
          close: () => closeOwnerSocket(socket, abort.signal),
          async command(command) {
            socket.send(JSON.stringify(command));
            const result = await wait(frame => frame?.type === "command.result" && frame.requestId === command.requestId);
            assert.equal(result.ok, true); return result;
          } };
        if (["child-foreign","child-badframe"].includes(mode)) await assert.rejects(inspectHistoryConnection(connection));
        else {
          const report = await inspectHistoryConnection(connection);
          assert.equal(report.inspected, ["root","child","child-rootupdate"].includes(mode));
          assert.equal(report.postsAtUpgrade, report.inspected ? 1 : undefined);
          if (mode === "child-rootupdate") {
            assert.equal(report.classification, "ACTIVITY_DURING_INSPECTION");
            assert.equal(report.subsequentEventScope, "ROOT_AND_SELECTED_CONVERSATION");
          }
          if (mode === "child-rootresnapshot") assert.equal(report.classification, "ACTIVITY_OR_INVENTORY_CHANGED");
          assert.equal(JSON.stringify(report).includes("synthetic-private"), false);
        }
        assert.equal(socket.readyState, WebSocket.CLOSED);
      });
      assert.equal(commands.length, mode === "child" || mode.startsWith("child-") ? 1 : 0);
    } finally {
      for (const socket of server.clients) socket.terminate();
      await new Promise(resolve => server.close(resolve));
    }
  }
});
function failedRecoveryObservation() {
  return { state: "OBSERVED", classification: "MODEL_ERROR_OR_ABORT_OBSERVED", inspected: true,
    postsAtUpgrade: 1, entryCount: 3, userMessageCount: 1, assistantCount: 1, errorOrAbortCount: 1,
    completedAssistantCount: 0, askJevCallCount: 0, askJevResultCount: 0, matchedTypedJevResultCount: 0,
    subsequentEventCount: 0, inventoryCount: 2, openedConversationCount: 1, pendingObserved: false,
    subsequentEventScope: "ROOT_AND_SELECTED_CONVERSATION" };
}
test("one seed recovery consumes a durable admission before external work and keeps all old UNKNOWN audits", async () => {
  const { mkdtemp, readFile, unlink, rmdir } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { withRegistration } = await import("./custody.mjs");
  const { beginSeedRecovery, recoveryHistoryAllowed, proofIdentity } = await import("./owner.mjs");
  const dir = await mkdtemp(tmpdir() + "/owner-seed-recovery-"), path = dir + "/registration.json";
  const prior = { state: "UNKNOWN", attemptedStage: "seed",
    reconciliation: { state: "UNKNOWN", forensicOnce: { state: "UNKNOWN" } },
    historyInspection: failedRecoveryObservation() };
  try {
    await withRegistration(path, store => store.save({ state: "READY", proof: prior }));
    const before = await readFile(path, "utf8");
    await withRegistration(path, async store => {
      await assert.rejects(beginSeedRecovery(store, Date.now() - 1));
      assert.equal(await readFile(path, "utf8"), before);
    });
    for (const [key,value] of Object.entries({ userMessageCount: 2, assistantCount: 2, errorOrAbortCount: 0,
      completedAssistantCount: 1, askJevCallCount: 1, askJevResultCount: 1, matchedTypedJevResultCount: 1,
      pendingObserved: true, subsequentEventCount: 1, inventoryCount: 3, openedConversationCount: 0, inspected: false })) {
      assert.throws(() => recoveryHistoryAllowed({ ...prior.historyInspection, [key]: value }));
    }
    const child = `
      const {withRegistration}=await import(${JSON.stringify(new URL("./custody.mjs", import.meta.url).href)});
      const {beginSeedRecovery}=await import(${JSON.stringify(new URL("./owner.mjs", import.meta.url).href)});
      await withRegistration(process.argv[1], async store => {
        await beginSeedRecovery(store,Date.now()+300000);console.log("RECOVERY_DURABLE_BEFORE_EXTERNAL");
        if(process.argv[2]==="crash")process.kill(process.pid,"SIGKILL");
      }).catch(()=>{console.error("RECOVERY_REFUSED");process.exitCode=1;});
    `;
    const execute = (crash = false) => promisify(execFile)(process.execPath, ["--input-type=module", "-e", child, path, crash ? "crash" : "normal"], { timeout: 5000 });
    await assert.rejects(execute(true), error => error.signal === "SIGKILL" && error.stdout.trim() === "RECOVERY_DURABLE_BEFORE_EXTERNAL");
    await assert.rejects(execute(), error => error.stderr.trim() === "RECOVERY_REFUSED");
    const marked = JSON.parse(await readFile(path, "utf8")).proof;
    assert.deepEqual(marked.seedRecovery.originalUnknown, prior);
    assert.deepEqual(marked.reconciliation, prior.reconciliation);
    assert.equal(marked.state, "UNKNOWN");
    for (const value of [null, false, {}, { state: "UNKNOWN" }]) {
      await withRegistration(path, store => store.save({ state: "READY", proof: { ...prior, seedRecovery: value } }));
      await assert.rejects(execute());
    }
    assert.throws(() => proofIdentity({ url: "https://pi.roccho.workers.dev", session: "owner-jev-proof-20261020",
      host: "64a8f191-83c2-5eeb-8dc0-612bc80970db", stage: "history", continue: true, "recover-seed-once": true }));
  } finally {
    for (const name of ["registration.json","registration.json.lock"]) await unlink(dir + "/" + name).catch(() => {});
    await rmdir(dir);
  }
});
test("terminal provider diagnostics accept only the own fixed envelope, never raw provider text", async () => {
  const { providerFailureReceipt, proofWitness, safeWitnessStatus } = await import("./owner.mjs");
  const envelope = { scope: "PI_PROOF_PROVIDER_FAILURE", version: 1, attempt: 2, httpStatus: 401, outcome: "HTTP" };
  const failure = errorMessage => [{ role: "assistant", stopReason: "error", errorMessage }];
  assert.deepEqual(providerFailureReceipt(failure(JSON.stringify(envelope))), envelope);
  assert.equal(providerFailureReceipt([{ role: "assistant", stopReason: "stop" }]), undefined);
  for (const value of ["synthetic-private-HTTP401", JSON.stringify({ ...envelope, private: "synthetic-private" }),
    JSON.stringify({ ...envelope, attempt: 6 }), JSON.stringify({ ...envelope, httpStatus: "401" }),
    JSON.stringify({ ...envelope, outcome: "TRANSPORT" }), JSON.stringify({ ...envelope, scope: "provider" })]) {
    const result = providerFailureReceipt(failure(value));
    assert.equal(result.outcome, "UNKNOWN");
    assert.equal(JSON.stringify(result).includes("synthetic-private"), false);
  }
  const witness = { boot: "00000000-0000-4000-8000-000000000608", posts: 4, prior: "false" };
  proofWitness(witness, 4, "false"); assert.equal(safeWitnessStatus(witness).posts, 4);
});
test("recovery uses the unique existing conversation and emits only ONE open, never create or prompt", async () => {
  const { prepareRecoveryConversation, observeOwnerSocket, withOwnerSockets, waitOwnerFrame, closeOwnerSocket } = await import("./owner.mjs");
  const { WebSocket, WebSocketServer } = await import("ws");
  const { once } = await import("node:events");
  for (const mode of ["valid","posts0","posts2","prior","completed","jev","pending","ambiguous","root-work"]) {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 }); await once(server, "listening");
    const commands = [];
    server.on("headers", headers => headers.push("Pi-Proof-Boot: 00000000-0000-4000-8000-000000000608",
      "Pi-Proof-Prior-Token: " + (mode === "prior" ? "true" : "false"),
      "Pi-Proof-Posts: " + (mode === "posts0" ? 0 : mode === "posts2" ? 2 : 1)));
    server.on("connection", socket => {
      for (const frame of historyFrames(mode === "ambiguous" ? [{ id: 9 },{ id: 10 }] : [{ id: 9 }],
        mode === "root-work" ? [{ model: [] }] : [])) socket.send(JSON.stringify(frame));
      socket.on("message", data => {
        const command = JSON.parse(String(data)); commands.push(command);
        assert.equal(command.type, "conversation.open"); assert.equal(command.conversationId, 9);
        const entries = [{ model: [{ role: "user", content: "synthetic-old-failed" }] },
          { model: [] }, { model: [{ role: "assistant", stopReason: mode === "completed" ? "stop" : "error",
            rawStopReason: mode === "completed" ? "completed" : undefined, responseId: mode === "completed" ? "old" : undefined,
            content: mode === "jev" ? [{ type: "toolCall", name: "ask_jev", id: "old" }] : [] }] }];
        const opened = historyFrames([], entries);
        if (mode === "pending") opened[1].events[0].compactions.push({ id: "pending" });
        for (const frame of opened.slice(1,3)) socket.send(JSON.stringify({ ...frame, conversationId: 9 }));
        socket.send(JSON.stringify({ type: "command.result", command: "conversation.open", requestId: command.requestId, ok: true }));
      });
    });
    const abort = new AbortController();
    try {
      await withOwnerSockets(abort.signal, async sockets => {
        const frames = [], socket = new WebSocket("ws://127.0.0.1:" + server.address().port); sockets.add(socket);
        const trace = observeOwnerSocket(socket, frames); await once(socket, "open");
        const wait = predicate => waitOwnerFrame(frames, socket, predicate, abort.signal, 500);
        const connection = { frames, witness: trace.witness, wait,
          close: () => closeOwnerSocket(socket, abort.signal),
          async command(command) { socket.send(JSON.stringify(command));
            return wait(frame => frame?.type === "command.result" && frame.requestId === command.requestId); } };
        if (mode === "valid") assert.equal(await prepareRecoveryConversation(connection), 9);
        else await assert.rejects(prepareRecoveryConversation(connection));
        await connection.close();
      });
      assert.equal(commands.length, ["valid","completed","jev","pending"].includes(mode) ? 1 : 0);
    } finally {
      for (const socket of server.clients) socket.terminate();
      await new Promise(resolve => server.close(resolve));
    }
  }
});
function transportCorrectionFrames(clockDelta = false) {
  const frames = historyFrames([{ id: 9 }]);
  const messages = [
    { role: "user", content: "synthetic-old-input" },
    { role: "system", content: "", sections: { preamble: "fixture", clock: "Current time: 2026-10-21T01:00Z." } },
    { role: "assistant", stopReason: "error", content: [], errorMessage: "Proof provider request failed" },
    { role: "user", content: "synthetic-second-input" },
    ...(clockDelta ? [{ role: "system", content: "", sections: { clock: "Current time: 2026-10-21T01:01Z." } }] : []),
    { role: "assistant", stopReason: "error", content: [], errorMessage: JSON.stringify({
      scope: "PI_PROOF_PROVIDER_FAILURE", version: 1, attempt: 2, httpStatus: null, outcome: "TRANSPORT" }) },
  ];
  const entries = messages.map((message,id) => ({ id: id + 1, kind: "pi." + message.role, model: [message] }));
  const opened = historyFrames([], entries);
  frames.push(...opened.slice(1,3).map(frame => ({ ...frame, conversationId: 9 })));
  return frames;
}
test("transport snapshot accepts only source-shaped failed entries and the same attempt2 trusted envelope", async () => {
  const { transportSnapshotAllowed } = await import("./owner.mjs");
  const witness = { ...historyWitness(2), prior: "false" };
  for (const delta of [false,true]) assert.equal(transportSnapshotAllowed(transportCorrectionFrames(delta),9,witness).errorOrAbortCount,2);
  for (const mutate of [
    f => { f.find(frame => frame.type === "conversation.events" && frame.conversationId === 9).events[0].entries.push({ kind: "pi.unknown", model: [] }); },
    f => { f.find(frame => frame.type === "conversation.events" && frame.conversationId === 9).events[0].entries[0].edits = []; },
    f => { f.find(frame => frame.type === "conversation.events" && frame.conversationId === 9).events[0].entries[0].head = "self"; },
    f => { f.find(frame => frame.type === "conversation.events" && frame.conversationId === 9).events[0].entries[4].model[0].sections.preamble = "synthetic-new-instructions"; },
    f => { f.find(frame => frame.type === "conversation.events" && frame.conversationId === 9).events[0].entries[4].model[0].toolsAdded = []; },
    f => { f.find(frame => frame.type === "conversation.events" && frame.conversationId === 9).events[0].entries[4].model[0].toolsRemoved = []; },
    f => { f.find(frame => frame.type === "conversation.events" && frame.conversationId === 9).events[0].entries[4].model[0].sections.clock = null; },
    f => { const entries=f.find(frame => frame.type === "conversation.events" && frame.conversationId === 9).events[0].entries;
      entries[4].model[0].sections.clock=entries[1].model[0].sections.clock; },
    f => { f.find(frame => frame.type === "conversation.events" && frame.conversationId === 9).events[0].entries[1].model[0].sections.clock=undefined; },
    f => { f.find(frame => frame.type === "conversation.events" && frame.conversationId === 9).events[0].entries[1].model[0].sections.clock=42; },
    f => { f.find(frame => frame.type === "conversation.events" && frame.conversationId === 9).events[0].entries.at(-1).model[0].errorMessage = "synthetic-private-transport"; },
    f => { f.find(frame => frame.type === "conversation.events" && frame.conversationId === 9).events[0].entries.at(-1).model[0].errorMessage = JSON.stringify({
      scope: "PI_PROOF_PROVIDER_FAILURE", version: 1, attempt: 1, httpStatus: null, outcome: "TRANSPORT" }); },
    f => { f.find(frame => frame.type === "conversation.events" && frame.conversationId === 9).events[0].entries.at(-1).model[0].errorMessage = JSON.stringify({
      scope: "PI_PROOF_PROVIDER_FAILURE", version: 1, attempt: 2, httpStatus: 401, outcome: "HTTP" }); },
    f => { f.find(frame => frame.type === "conversation.events" && frame.conversationId === 9).events[0].compactions.push({ id: "pending" }); },
    f => { f.push({ type: "conversation.events", conversationId: 1, events: [{ type: "run_start" }] }); },
  ]) { const frames=transportCorrectionFrames(true);mutate(frames);assert.throws(()=>transportSnapshotAllowed(frames,9,witness)); }
  for (const posts of [0,1,3,4,5]) assert.throws(()=>transportSnapshotAllowed(transportCorrectionFrames(),9,{...witness,posts}));
});
test("distinct transport correction mark survives process death and preserves the consumed old recovery", async () => {
  const { mkdtemp, readFile, unlink, rmdir } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { withRegistration } = await import("./custody.mjs");
  const { beginTransportRecovery, proofIdentity } = await import("./owner.mjs");
  const original={state:"UNKNOWN",attemptedStage:"seed",reconciliation:{state:"UNKNOWN",forensicOnce:{state:"UNKNOWN"}},
    historyInspection:failedRecoveryObservation()};
  const prior={...original,seedRecovery:{state:"UNKNOWN",originalUnknown:original,conversationId:9}};
  const dir=await mkdtemp(tmpdir()+"/owner-transport-"),path=dir+"/registration.json";
  try {
    await withRegistration(path,store=>store.save({state:"READY",proof:prior}));
    const before=await readFile(path,"utf8");
    await withRegistration(path,async store=>{
      await assert.rejects(beginTransportRecovery(store,Date.now()-1));assert.equal(await readFile(path,"utf8"),before);
    });
    const child=`
      const {withRegistration}=await import(${JSON.stringify(new URL("./custody.mjs",import.meta.url).href)});
      const {beginTransportRecovery}=await import(${JSON.stringify(new URL("./owner.mjs",import.meta.url).href)});
      await withRegistration(process.argv[1],async store=>{
        await beginTransportRecovery(store,Date.now()+300000);console.log("TRANSPORT_MARK_DURABLE");
        if(process.argv[2]==="crash")process.kill(process.pid,"SIGKILL");
      }).catch(()=>{console.error("TRANSPORT_REFUSED");process.exitCode=1;});
    `;
    const execute=(crash=false)=>promisify(execFile)(process.execPath,["--input-type=module","-e",child,path,crash?"crash":"normal"],{timeout:5000});
    await assert.rejects(execute(true),error=>error.signal==="SIGKILL"&&error.stdout.trim()==="TRANSPORT_MARK_DURABLE");
    await assert.rejects(execute(),error=>error.stderr.trim()==="TRANSPORT_REFUSED");
    const marked=JSON.parse(await readFile(path,"utf8")).proof;
    assert.deepEqual(marked.transportRecovery.originalUnknown,prior);assert.deepEqual(marked.seedRecovery,prior.seedRecovery);
    for (const marker of [null,false,{}, {state:"UNKNOWN"}]) {
      await withRegistration(path,store=>store.save({state:"READY",proof:{...prior,transportRecovery:marker}}));
      await assert.rejects(execute());
    }
    for (const stage of ["history","refresh","recall"]) assert.throws(()=>proofIdentity({url:"https://pi.roccho.workers.dev",
      session:"owner-jev-proof-20261020",host:"64a8f191-83c2-5eeb-8dc0-612bc80970db",stage,continue:true,"recover-transport-once":true}));
  } finally {
    for(const name of ["registration.json","registration.json.lock"])await unlink(dir+"/"+name).catch(()=>{});
    await rmdir(dir);
  }
});
test("real transport-correction loopback opens only the previously saved inventory ID", async () => {
  const { prepareTransportConversation, observeOwnerSocket, withOwnerSockets, waitOwnerFrame, closeOwnerSocket } = await import("./owner.mjs");
  const {WebSocket,WebSocketServer}=await import("ws");const {once}=await import("node:events");
  for(const saved of [9,10]) {
    const server=new WebSocketServer({host:"127.0.0.1",port:0});await once(server,"listening");
    const commands=[];
    server.on("headers",headers=>headers.push("Pi-Proof-Boot: 00000000-0000-4000-8000-000000000608","Pi-Proof-Prior-Token: false","Pi-Proof-Posts: 2"));
    server.on("connection",socket=>{
      for(const frame of historyFrames([{id:9}]))socket.send(JSON.stringify(frame));
      socket.on("message",data=>{
        const command=JSON.parse(String(data));commands.push(command);
        for(const frame of transportCorrectionFrames(true).slice(3))socket.send(JSON.stringify(frame));
        socket.send(JSON.stringify({type:"command.result",command:"conversation.open",requestId:command.requestId,ok:true}));
      });
    });
    const abort=new AbortController();
    try {
      await withOwnerSockets(abort.signal,async sockets=>{
        const frames=[],socket=new WebSocket("ws://127.0.0.1:"+server.address().port);sockets.add(socket);
        const trace=observeOwnerSocket(socket,frames);await once(socket,"open");
        const wait=predicate=>waitOwnerFrame(frames,socket,predicate,abort.signal,500);
        const connection={frames,witness:trace.witness,wait,close:()=>closeOwnerSocket(socket,abort.signal),
          async command(command){socket.send(JSON.stringify(command));return wait(frame=>frame.type==="command.result"&&frame.requestId===command.requestId);}};
        if(saved===9)assert.equal(await prepareTransportConversation(connection,saved),9);
        else await assert.rejects(prepareTransportConversation(connection,saved));
        await connection.close();
      });
      assert.deepEqual(commands.map(command=>[command.type,command.conversationId]),saved===9?[["conversation.open",9]]:[]);
    } finally {for(const socket of server.clients)socket.terminate();await new Promise(resolve=>server.close(resolve));}
  }
});

test("OpenCode proof branches without custody/OAuth, correlates coding results and checks actual wire identity across reconnect", async () => {
  const { proofIdentity, runOpenCodeProof, openCodeWireReceipts } = await import("./owner.mjs");
  const values = { stage: "opencode", url: "https://pi.roccho.workers.dev/",
    session: "owner-jev-opencode-proof-20261021", continue: true, cloudflared: "unused" };
  proofIdentity(values);
  for (const changed of [{ url: "https://foreign.invalid/" }, { session: "owner-jev-proof-20261020" },
    { continue: false }, { "recover-transport-once": true }])
    assert.throws(() => proofIdentity({ ...values, ...changed }));
  for (const mode of ["valid", "different-header", "same-boot"]) {
    let connects = 0, idle = 0, expected, observedPrompt;
    const commands = [];
    const wire = (attempt, digest = "a".repeat(64)) => ({ schema: "pi.opencode.wire.v1",
      sessionSha256: digest, ownUserAgent: true, attempt });
    const assistant = (attempt, stopReason, content, digest) => ({ role: "assistant",
      stopReason, rawStopReason: "completed", responseId: "opencode-fixture-" + attempt,
      model: "gpt-6-luna", content, piProofWire: wire(attempt,digest) });
    const dependencies = {
      accessToken: () => "fixture-owner-cookie",
      idle: async () => { idle++; },
      connect: async options => {
        assert.deepEqual(Object.keys(options.headers), ["Cookie"]);
        assert.equal(options.priorHeader, "pi-proof-prior-owner");
        assert.equal(options.session, values.session);
        const index = connects++;
        return {
          witness: { boot: index === 0 || mode === "same-boot" ? "00000000-0000-4000-8000-000000000001" :
            "00000000-0000-4000-8000-000000000002", prior: "false", posts: [0,2,3][index] },
          close: async () => {},
          command: async command => { commands.push(command); return { conversationId: 8 }; },
          turn: async (id, prompt) => {
            assert.equal(id,8);
            if (index === 0) {
              const caseId = /test case ([0-9a-f]{48})/.exec(prompt)?.[1];
              assert.ok(caseId); assert.match(prompt,/function first/);
              expected = { caseId, finding: "Empty array dereferences undefined", assessment: { type: "noul", noul: 0.8123 } };
              return [
                assistant(1,"toolUse",[{type:"toolCall",id:"code-call",name:"ask_jev",arguments:{}}]),
                { role:"toolResult", toolName:"ask_jev",toolCallId:"code-call",isError:false,
                  content:[{type:"text",text:JSON.stringify(expected.assessment)}] },
                assistant(2,"stop",[{type:"text",text:JSON.stringify(expected)}]),
              ];
            }
            observedPrompt=prompt;
            assert.ok(!prompt.includes(expected.caseId));assert.ok(!prompt.includes("0.8123"));
            assert.ok(!prompt.includes(expected.finding));assert.match(prompt,/previous code review/);
            return [assistant(3,"stop",[{type:"text",text:JSON.stringify(expected)}],
              mode === "different-header" ? "b".repeat(64) : undefined)];
          },
        };
      },
    };
    if (mode === "valid") { await runOpenCodeProof(values,dependencies); assert.equal(connects,3); }
    else await assert.rejects(runOpenCodeProof(values,dependencies));
    assert.equal(idle,1);
    assert.equal(commands[0].type,"conversation.create");
    if(mode!=="same-boot") { assert.equal(commands[1].type,"conversation.open");assert.equal(commands[1].conversationId,8);assert.ok(observedPrompt); }
  }
  const valid = {role:"assistant",stopReason:"stop",rawStopReason:"completed",responseId:"one",
    piProofWire:{schema:"pi.opencode.wire.v1",attempt:3,ownUserAgent:true,sessionSha256:"a".repeat(64)}};
  assert.throws(()=>openCodeWireReceipts([{...valid,piProofWire:undefined}],[3]));
  assert.throws(()=>openCodeWireReceipts([{...valid,piProofWire:{...valid.piProofWire,ownUserAgent:false}}],[3]));
  assert.throws(()=>openCodeWireReceipts([{...valid,piProofWire:{...valid.piProofWire,attempt:2}}],[3]));
});

function creditFailureFrames() {
  const frames=transportCorrectionFrames();
  const snap=frames.find(f=>f.type==="conversation.events"&&f.conversationId===9).events[0];
  snap.entries=snap.entries.slice(0,3);
  snap.entries[2].model[0].errorMessage=JSON.stringify({scope:"PI_PROOF_PROVIDER_FAILURE",version:1,attempt:1,httpStatus:403,outcome:"HTTP"});
  return frames;
}
test("PAYG recovery accepts only the actual settled single403 history, no reset or guessed ID",async()=>{
  const {creditSnapshotAllowed,prepareCreditConversation,runOpenCodeProof,proofIdentity}=await import("./owner.mjs");
  const witness={...historyWitness(1),prior:"false"};
  assert.equal(creditSnapshotAllowed(creditFailureFrames(),9,witness).errorOrAbortCount,1);
  for(const change of [
    f=>{f.find(x=>x.type==="conversation.events"&&x.conversationId===9).events[0].entries.push({kind:"pi.unknown",model:[]});},
    f=>{f.find(x=>x.type==="conversation.events"&&x.conversationId===9).events[0].entries[0].edits=[];},
    f=>{f.find(x=>x.type==="conversation.events"&&x.conversationId===9).events[0].entries[2].model[0].content=[{type:"toolCall",id:"unexpected",name:"ask_jev"}];},
    f=>{f.find(x=>x.type==="conversation.events"&&x.conversationId===9).events[0].compactions.push({id:"pending"});},
    f=>{f.find(x=>x.type==="conversation.events"&&x.conversationId===9).events[0].run={};},
    f=>{f.push({type:"conversation.events",conversationId:1,events:[{type:"run_start"}]});},
    f=>{f.find(x=>x.type==="conversation.events"&&x.conversationId===9).events[0].entries[2].model[0].errorMessage=JSON.stringify({scope:"PI_PROOF_PROVIDER_FAILURE",version:1,attempt:2,httpStatus:403,outcome:"HTTP"});},
    f=>{f.find(x=>x.type==="conversation.events"&&x.conversationId===9).events[0].entries[2].model[0].errorMessage="HTTP403";},
  ]){const frames=creditFailureFrames();change(frames);assert.throws(()=>creditSnapshotAllowed(frames,9,witness));}
  for(const posts of [0,2,3,4])assert.throws(()=>creditSnapshotAllowed(creditFailureFrames(),9,{...witness,posts}));
  const {WebSocket,WebSocketServer}=await import("ws");const {once}=await import("node:events");
  const {observeOwnerSocket,withOwnerSockets,waitOwnerFrame,closeOwnerSocket}=await import("./owner.mjs");
  const server=new WebSocketServer({host:"127.0.0.1",port:0});await once(server,"listening");const commands=[];
  server.on("headers",h=>h.push("Pi-Proof-Boot: "+witness.boot,"Pi-Proof-Prior-Owner: false","Pi-Proof-Posts: 1"));
  server.on("connection",socket=>{
    for(const f of historyFrames([{id:9}]))socket.send(JSON.stringify(f));
    socket.on("message",data=>{
      const c=JSON.parse(String(data));commands.push(c);
      for(const f of creditFailureFrames().slice(3))socket.send(JSON.stringify(f));
      socket.send(JSON.stringify({type:"command.result",command:"conversation.open",requestId:c.requestId,ok:true}));
    });
  });
  try{
    const abort=new AbortController();await withOwnerSockets(abort.signal,async sockets=>{
      const frames=[],socket=new WebSocket("ws://127.0.0.1:"+server.address().port);sockets.add(socket);
      const trace=observeOwnerSocket(socket,frames,()=>{},"pi-proof-prior-owner");await once(socket,"open");
      const wait=predicate=>waitOwnerFrame(frames,socket,predicate,abort.signal,500);
      const connection={frames,witness:trace.witness,wait,close:()=>closeOwnerSocket(socket,abort.signal),
        async command(c){socket.send(JSON.stringify(c));return wait(f=>f.type==="command.result"&&f.requestId===c.requestId);}};
      assert.equal(await prepareCreditConversation(connection),9);await connection.close();
    });
    assert.deepEqual(commands.map(c=>[c.type,c.conversationId]),[["conversation.open",9]]);
  }finally{for(const socket of server.clients)socket.terminate();await new Promise(r=>server.close(r));}
  const values={stage:"opencode-credit-recover",url:"https://pi.roccho.workers.dev/",
    session:"owner-jev-opencode-proof-20261021",continue:true,cloudflared:"unused"};
  proofIdentity(values);
  let connects=0,idle=0,expected;const sent=[];
  const assistant=(attempt,stopReason,content)=>({role:"assistant",stopReason,rawStopReason:"completed",model:"gpt-6-luna",
    responseId:"credit-"+attempt,content,piProofWire:{schema:"pi.opencode.wire.v1",attempt,sessionSha256:"a".repeat(64),ownUserAgent:true}});
  await runOpenCodeProof(values,{accessToken:()=>"fixture",idle:async()=>{idle++;},connect:async()=>{
    const index=connects++,frames=index===0?historyFrames([{id:9}]):[];
    return {frames,witness:{...witness,boot:index===0?witness.boot:"00000000-0000-4000-8000-000000000609",posts:[1,3,4][index]},
      wait:async predicate=>{const frame=frames.find(predicate);assert.ok(frame);return frame;},close:async()=>{},
      command:async c=>{sent.push(c);assert.equal(c.type,"conversation.open");assert.equal(c.conversationId,9);
        if(index===0){frames.push(...creditFailureFrames().slice(3));frames.push({type:"command.result",command:"conversation.open",requestId:c.requestId,ok:true});}
        return {ok:true};},
      turn:async(id,prompt)=>{
        assert.equal(id,9);
        if(index===0){
          const caseId=/test case ([0-9a-f]{48})/.exec(prompt)[1];
          expected={caseId,finding:"Empty input dereferences undefined",assessment:{type:"noul",noul:0.721}};
          return [assistant(2,"toolUse",[{type:"toolCall",id:"credit-tool",name:"ask_jev",arguments:{}}]),
            {role:"toolResult",toolName:"ask_jev",toolCallId:"credit-tool",isError:false,content:[{type:"text",text:JSON.stringify(expected.assessment)}]},
            assistant(3,"stop",[{type:"text",text:JSON.stringify(expected)}])];
        }
        for(const value of [expected.caseId,expected.finding,"0.721"])assert.ok(!prompt.includes(value));
        return [assistant(4,"stop",[{type:"text",text:JSON.stringify(expected)}])];
      }};
  }});
  assert.equal(connects,3);assert.equal(idle,1);assert.deepEqual(sent.map(c=>c.type),["conversation.open","conversation.open"]);
});

test("actual PAYG CLI dispatch reaches API branch before UID/home/profile/OAuth, with external commands blocked",async()=>{
  const {execFile}=await import("node:child_process");const {promisify}=await import("node:util");
  const shim=`import cp from "node:child_process";import {syncBuiltinESMExports} from "node:module";
    process.stderr.isTTY=true;process.getuid=()=>9999;
    cp.execFileSync=()=>{throw new Error("KEYLESS_EXTERNAL_COMMAND_BLOCKED");};syncBuiltinESMExports();`;
  await assert.rejects(promisify(execFile)(process.execPath,["--import","data:text/javascript,"+encodeURIComponent(shim),
    new URL("./owner.mjs",import.meta.url).pathname,"--url","https://pi.roccho.workers.dev/",
    "--session","owner-jev-opencode-proof-20261021","--cloudflared","fixture-must-not-execute",
    "--stage","opencode-credit-recover","--continue"],{timeout:5000}),error=>{
      assert.equal(error.code,1);
      assert.match(error.stdout,/"phase":"CF_CACHE"/);
      assert.match(error.stderr,/STOPPED_NOT_PROVEN/);
      assert.ok(!error.stderr.includes("KEYLESS_EXTERNAL_COMMAND_BLOCKED"));
      return true;
    });
});
