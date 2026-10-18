import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';

const base = process.env.WORKER_URL;
const token = process.env.PROOF_TOKEN;
const version = process.env.GITHUB_SHA;
const output = process.argv[2];
const requirePush = process.env.REQUIRE_WEBPUSH === 'true';
if (!base?.match(/^https:\/\/[a-z0-9.-]+\.workers\.dev$/) || !token || !version || !output) throw new Error('PROOF_INPUT_REQUIRED');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const workerCodes = new Set(['UNAUTHORIZED', 'NOT_FOUND', 'RECEIPT_LIMIT', 'RECEIPT_MISSING', 'INVALID_SINCE', 'RUN_RECEIPT_WRITE_FAILED', 'INTERNAL_FAILURE']);
class ProofError extends Error {
  constructor(stage, code, httpStatus = null) { super(code); this.diagnostic = { stage, code, httpStatus }; }
}
async function call(path, method, stage) {
  let response;
  try { response = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(50_000), redirect: 'error' }); }
  catch { throw new ProofError(stage, 'REQUEST_FAILED'); }
  let body;
  try { body = await response.json(); }
  catch { throw new ProofError(stage, 'INVALID_RESPONSE_JSON', response.status); }
  if (!response.ok) throw new ProofError(stage, workerCodes.has(body?.code) ? body.code : 'UNRECOGNIZED_WORKER_ERROR', response.status);
  return body;
}
const receipt = { schema: 'event-reservoir.providerProof/1', version, worker: base, http: false, rss: false, cron: false, mozilla: false, fullPoc: false };
function acceptMozilla(run) {
  const push = run.inputs?.webpush;
  if (!receipt.mozilla && push?.status === 'OK' && push.verified === true && push.reconnected === true && push.replayed === true && push.decrypted >= 2 && push.acknowledged >= 1) {
    receipt.mozilla = true;
    receipt.mozillaEvidence = run;
  }
}
let stage = 'readiness';
try {
  const started = Date.now();
  // Secret updates can propagate after public health already reports the new source.
  // Readiness proves this exact version accepts our token and can read R2. Only GET is retried.
  let ready, lastReadinessFailure;
  for (let attempt = 0; attempt < 30; attempt++) {
    receipt.readinessAttempts = attempt + 1;
    try {
      ready = await call(`/evidence?since=${started}`, 'GET', stage);
      if (ready.version === version) break;
      lastReadinessFailure = { stage, code: 'DEPLOYED_VERSION_MISMATCH', httpStatus: 200 };
    } catch (error) { lastReadinessFailure = error.diagnostic ?? { stage, code: 'READINESS_FAILED', httpStatus: null }; }
    await sleep(1000);
  }
  if (lastReadinessFailure) receipt.lastReadinessFailure = lastReadinessFailure;
  if (ready?.version !== version) throw new ProofError(stage, lastReadinessFailure?.code ?? 'READINESS_NOT_OBSERVED', lastReadinessFailure?.httpStatus);
  receipt.authenticatedReadiness = true;
  stage = 'manual-proof';
  const proof = await call('/proof', 'POST', stage);
  receipt.manual = proof;
  assert.equal(proof.version, version);
  receipt.http = proof.inputs.http.status === 'OK' && proof.inputs.http.replay?.oneObject === true && proof.inputs.http.replay?.unchanged === true;
  assert.equal(receipt.http, true, 'HTTP_REAL_INPUT_PROOF_FAILED');
  // Read from the deployed Worker/R2; parsed fixture data is not acceptable live evidence.
  // Old provider fixtures omit RSS and remain historical, not upgraded to RSS PASS.
  if (proof.inputs.rss) {
    stage = 'rss-readback';
    const rssRead = await call('/rss', 'GET', stage);
    receipt.rss = proof.inputs.rss.status === 'OK' && proof.inputs.rss.verified === true && proof.inputs.rss.replayVerified === true && rssRead.total >= proof.inputs.rss.entries && rssRead.items?.length > 0;
    receipt.rssReadback = { total: rssRead.total, returned: rssRead.items?.length ?? 0 };
    if (!receipt.rss) throw new ProofError(stage, 'RSS_REAL_INPUT_NOT_READABLE');
  }
  acceptMozilla(proof);
  const deadline = Date.now() + Number(process.env.CRON_WAIT_MS ?? 25 * 60_000);
  stage = 'cron-evidence';
  while (Date.now() < deadline) {
    const evidence = await call(`/evidence?since=${started}`, 'GET', stage);
    const runs = evidence.runs.filter(run => run.version === version && run.trigger === 'scheduled' && run.scheduledTime >= started).sort((a, b) => a.scheduledTime - b.scheduledTime);
    for (const run of runs) acceptMozilla(run);
    const pair = runs.slice(-2);
    if (!receipt.cron && pair.length === 2 && pair[1].scheduledTime - pair[0].scheduledTime === 120_000 && pair.every(run => run.inputs.http.status === 'OK' && run.inputs.http.verified)) {
      receipt.cron = true; receipt.scheduled = pair;
    }
    if (receipt.cron && (!requirePush || receipt.mozilla)) break;
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
  receipt.diagnostic = error.diagnostic ?? { stage, code: receipt.failure, httpStatus: null };
  process.exitCode = 1;
} finally {
  await writeFile(output, JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify({ status: receipt.status, http: receipt.http, cron: receipt.cron, mozilla: receipt.mozilla, fullPoc: receipt.fullPoc }));
}
