import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, chmod, symlink, unlink, rmdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { withRegistration, replaceCredential, ready, refreshTiming } from "./custody.mjs";
const moduleURL = new URL("./custody.mjs", import.meta.url).href;
const host = "00000000-0000-4000-8000-000000000608";
function credential(access = "synthetic-old", expiry = 1) {
  return { access, refresh: "synthetic-refresh-" + access, clientId: "issued-client",
    actualExpiresAt: expiry, identity: { subject: "synthetic-owner" } };
}
async function fixture(fn) {
  const dir = await mkdtemp(join(dirname(fileURLToPath(import.meta.url)), ".custody-test-"));
  const path = join(dir, "registration.json"); await chmod(dir, 0o700);
  try { await fn(path); } finally {
    for (const name of ["registration.json", "registration.json.lock", "effect", "link"]) await unlink(join(dir, name)).catch(() => {});
    await rmdir(dir);
  }
}
function child(code, path) {
  const process = spawn(globalThis.process.execPath, ["--input-type=module", "-e",
    'import {withRegistration,replaceCredential,ready,refreshTiming} from ' + JSON.stringify(moduleURL) + ';' + code], {
    env: { ...globalThis.process.env, RECORD: path, HOST: host }, stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  process.stdout.on("data", data => { stdout += data; });
  process.stderr.on("data", data => { stderr += data; });
  const done = new Promise((resolve, reject) => {
    process.once("error", reject); process.once("exit", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { process, done, async marker() {
    if (stdout.includes("MARK")) return;
    await new Promise((resolve, reject) => {
      process.stdout.on("data", () => { if (stdout.includes("MARK")) resolve(); });
      process.once("exit", () => reject(new Error("No crash boundary reached")));
    });
  } };
}
test("real processes serialize refresh, reread replacement, and preserve one rotation", async () => fixture(async path => {
  await withRegistration(path, store => store.save({ state: "READY", host, credential: credential() }));
  const code = `
await withRegistration(process.env.RECORD,async store=>{
 const old=ready(store.get(),process.env.HOST);
 if(!refreshTiming(old).allowed){console.log("REUSED");return;}
 await replaceCredential(store,process.env.HOST,"refresh",async()=>{
  await new Promise(r=>setTimeout(r,100));
  return {...old,access:"synthetic-new",refresh:"synthetic-new-refresh",actualExpiresAt:Date.now()+3600000};
 });console.log("ROTATED");
});`;
  const [a,b] = await Promise.all([child(code,path).done, child(code,path).done]);
  assert.equal(a.code,0,a.stderr); assert.equal(b.code,0,b.stderr);
  assert.deepEqual([a.stdout.trim(),b.stdout.trim()].sort(),["REUSED","ROTATED"]);
  await withRegistration(path, async store => assert.equal(ready(store.get(),host).access,"synthetic-new"));
}));
test("SIGKILL after durable premark or after token return blocks restart", async () => {
  for (const boundary of ["before-send","after-return"]) await fixture(async path => {
    await withRegistration(path, store => store.save({ state:"READY",host,credential:credential() }));
    const action = boundary === "after-return" ?
      'await import("node:fs/promises").then(fs=>fs.writeFile(process.env.RECORD.replace(/registration.json$/,"effect"),"SENT"));' : "";
    const running = child(`
await withRegistration(process.env.RECORD,store=>replaceCredential(store,process.env.HOST,"refresh",async old=>{
 ${action}
 process.stdout.write("MARK"); await new Promise(()=>{setInterval(()=>{},1000);});
 return old;
}));`,path);
    await running.marker(); running.process.kill("SIGKILL"); await running.done;
    const restarted = await child(`
await withRegistration(process.env.RECORD,async store=>{
 try {ready(store.get(),process.env.HOST);process.exitCode=2;} catch {console.log("BLOCKED");}
});`,path).done;
    assert.equal(restarted.code,0,restarted.stderr); assert.equal(restarted.stdout.trim(),"BLOCKED");
    assert.equal(JSON.parse(await readFile(path,"utf8")).state,"IN_DOUBT");
    if(boundary==="after-return") assert.equal(await readFile(join(dirname(path),"effect"),"utf8"),"SENT");
  });
});
test("persistence failure and mismatched replacement leave registration unusable",async()=>fixture(async path=>{
  await withRegistration(path,async store=>{
    await store.save({state:"READY",host,credential:credential()});
    await assert.rejects(replaceCredential(store,host,"refresh",async()=>({...credential(),identity:{subject:"other"}})));
    assert.throws(()=>ready(store.get(),host));
  });
  await withRegistration(path,async store=>{
    let saves=0;
    const failed={get:store.get,async save(next){if(++saves===2)throw Error("synthetic disk failure");await store.save(next);}};
    await assert.rejects(replaceCredential(failed,host,"reauth",async()=>credential("new")));
    assert.throws(()=>ready(store.get(),host));
  });
}));
test("unsafe metadata rejects before effects; timing is not fabricated",async()=>fixture(async path=>{
  await writeFile(path,"{}",{mode:0o644});
  await assert.rejects(withRegistration(path,()=>assert.fail("unsafe record accepted")));
  await unlink(path); await symlink(join(dirname(path),"link"),path);
  await assert.rejects(withRegistration(path,()=>assert.fail("symlink accepted")));
  assert.equal(refreshTiming(credential("x",Date.now()+3600000)).allowed,false);
  assert.equal(refreshTiming({...credential(),earliestRefreshAt:123},123000).allowed,true);
  assert.equal(refreshTiming({...credential(),earliestRefreshAt:123},122999).allowed,false);
  const instant = "2026-10-21T10:00:00.000Z";
  const timestamp = Date.parse(instant);
  assert.equal(refreshTiming({...credential(),earliestRefreshAt:instant},timestamp).allowed,true);
  assert.equal(refreshTiming({...credential(),earliestRefreshAt:instant},timestamp-1).allowed,false);
  assert.equal(refreshTiming({...credential("x",timestamp+1),earliestRefreshAt:instant},timestamp).allowed,false);
  for(const raw of [null,{},true,"not-a-date","2026-02-31T00:00:00Z","2026-01-01T00:00:00+00:60",Infinity,1e99,-1]) {
    assert.throws(()=>refreshTiming({...credential(),earliestRefreshAt:raw}));
  }
}));
