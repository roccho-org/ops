import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';

const base = process.env.WORKER_URL;
const token = process.env.PROOF_TOKEN;
const version = process.env.GITHUB_SHA;
const output = process.argv[2];
const requirePush = process.env.REQUIRE_WEBPUSH === 'true';
if (!base?.match(/^https:\/\/[a-z0-9.-]+\.workers\.dev$/) || !token || !version || !output) throw new Error('PROOF_INPUT_REQUIRED');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function call(path, method = 'GET') {
  const response = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(50_000), redirect: 'error' });
  if (!response.ok) throw new Error(`PROOF_HTTP_${response.status}`);
  return response.json();
}
const receipt = { schema: 'event-reservoir.providerProof/1', version, worker: base, http: false, cron: false, mozilla: false, fullPoc: false };
try {
  // Only safe GET readiness is retried. A POST with an unknown result is never replayed here.
  let health;
  for (let attempt = 0; attempt < 30; attempt++) {
    try { health = await call('/health'); if (health.version === version) break; } catch {}
    await sleep(1000);
  }
  assert.equal(health?.version, version, 'DEPLOYED_VERSION_MISMATCH');
  const started = Date.now();
  const proof = await call('/proof', 'POST');
  assert.equal(proof.version, version);
  receipt.manual = proof;
  receipt.http = proof.inputs.http.status === 'OK' && proof.inputs.http.replay?.oneObject === true && proof.inputs.http.replay?.unchanged === true;
  assert.equal(receipt.http, true, 'HTTP_REAL_INPUT_PROOF_FAILED');
  const push = proof.inputs.webpush;
  receipt.mozilla = push.status === 'OK' && push.reconnected === true && push.replayed === true && push.decrypted >= 2 && push.acknowledged >= 1;
  const deadline = Date.now() + Number(process.env.CRON_WAIT_MS ?? 25 * 60_000);
  while (Date.now() < deadline) {
    const evidence = await call(`/evidence?since=${started}`);
    const runs = evidence.runs.filter(run => run.version === version && run.trigger === 'scheduled' && run.scheduledTime >= started).sort((a, b) => a.scheduledTime - b.scheduledTime);
    const pair = runs.slice(-2);
    if (pair.length === 2 && pair[1].scheduledTime - pair[0].scheduledTime === 120_000 && pair.every(run => run.inputs.http.status === 'OK' && run.inputs.http.verified)) {
      receipt.cron = true; receipt.scheduled = pair; break;
    }
    await sleep(15_000);
  }
  assert.equal(receipt.cron, true, 'TWO_REAL_CRON_RUNS_NOT_OBSERVED');
  receipt.fullPoc = receipt.http && receipt.cron && receipt.mozilla;
  receipt.status = receipt.fullPoc ? 'PASS' : 'PARTIAL';
  receipt.remaining = receipt.mozilla ? [] : ['REAL_X_WEBPUSH_DECRYPT_SAVE_ACK_REPLAY'];
  if (requirePush && !receipt.fullPoc) process.exitCode = 2;
} catch (error) {
  receipt.status = 'FAIL';
  // Never publish arbitrary remote text, stack traces, subscription data or keys.
  receipt.failure = error?.code === 'ERR_ASSERTION' ? 'PROOF_ASSERTION_FAILED' : 'PROOF_EXECUTION_FAILED';
  process.exitCode = 1;
} finally {
  await writeFile(output, JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify({ status: receipt.status, http: receipt.http, cron: receipt.cron, mozilla: receipt.mozilla, fullPoc: receipt.fullPoc }));
}
