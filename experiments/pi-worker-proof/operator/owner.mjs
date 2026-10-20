/** Owner-native staged lifecycle proof. No Worker or provider action merely on import. */
import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { withRegistration, replaceCredential, ready, refreshTiming } from "./custody.mjs";

let lastPhase = "VALIDATE";
let lastHttpStatus;
function phase(name) { lastPhase = name; lastHttpStatus = undefined; console.log(JSON.stringify({ scope: "OWNER_PHASE_ENTERED", phase: name })); }
export function parseOwnerFrame(data) {
  try { return JSON.parse(String(data)); } catch { return { type: "invalid.owner.frame" }; }
}
export function proofIdentity(values) {
  const url = new URL(values.url);
  if (url.origin !== "https://pi.roccho.workers.dev" || url.pathname !== "/" ||
      url.username || url.password || url.search || url.hash ||
      values.session !== "owner-jev-proof-20261020" ||
      values.host !== "64a8f191-83c2-5eeb-8dc0-612bc80970db" ||
      !["login","reauth","refresh","seed","recall","reconcile"].includes(values.stage) ||
      (["seed","recall","reconcile"].includes(values.stage) && values.continue !== true)) throw new Error("Proof identity mismatch");
}
export async function loadOwnerOAuth() {
  delete process.env.PI_OAUTH_CALLBACK_HOST;
  return import("./dist/oauth.mjs");
}
export function proofWitness(witness, posts, prior) {
  assert.match(witness?.boot ?? "", /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  assert.ok(Number.isInteger(witness.posts));
  assert.equal(witness.posts, posts);
  assert.ok(witness.prior === "true" || witness.prior === "false");
  if (prior !== undefined) assert.equal(witness.prior, prior);
}
export function completedTurn(frame, conversationId, submissionId) {
  return frame.type === "conversation.events" && frame.conversationId === conversationId &&
    frame.events.some(event => event.type === "run_end" && event.inputs.includes(submissionId));
}
export function turnMessages(frames, conversationId) {
  const entries = new Map();
  for (const frame of frames) {
    if (frame.type !== "conversation.events" || frame.conversationId !== conversationId) continue;
    for (const event of frame.events ?? []) {
      if (event.type === "message_end" || event.type === "entry_appended") entries.set(event.entry.id, event.entry);
    }
  }
  return [...entries.values()].flatMap(entry => entry.model ?? []);
}
export async function withOwnerSockets(signal, operation) {
  const sockets = new Set();
  const close = () => { for (const socket of sockets) socket.terminate(); };
  signal.throwIfAborted();
  signal.addEventListener("abort", close, { once: true });
  try { return await operation(sockets); }
  finally { signal.removeEventListener("abort", close); close(); }
}
export function closeOwnerSocket(socket, signal) {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  if (signal.aborted) { socket.terminate(); return Promise.resolve(); }
  return new Promise(resolve => {
    const finish = () => { signal.removeEventListener("abort", cancel); resolve(); };
    const cancel = () => { socket.terminate(); finish(); };
    socket.once("close", finish);
    signal.addEventListener("abort", cancel, { once: true });
    socket.close(1000, "finite proof");
  });
}

const recordObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const emptyObject = value => recordObject(value) && Object.keys(value).length === 0;
const emptyArray = value => Array.isArray(value) && value.length === 0;
export function emptyRootCertificate(frames, witness) {
  proofWitness(witness, 0);
  let sessionSeen = false, rootSeen = false, inboxSeen = false;
  for (const frame of frames) {
    assert.ok(recordObject(frame));
    if (frame.type === "session.snapshot") {
      assert.ok(recordObject(frame.session));
      assert.deepEqual(frame.session.conversations, [{ id: 1 }]);
      assert.ok(recordObject(frame.session.activity) && emptyObject(frame.session.activity.tasks));
      sessionSeen = true;
    } else if (frame.type === "session.activity") {
      assert.ok(recordObject(frame.activity) && emptyObject(frame.activity.tasks));
    } else if (frame.type === "conversation.events") {
      assert.equal(frame.conversationId, 1);
      assert.ok(Array.isArray(frame.events) && frame.events.length > 0);
      for (const event of frame.events) {
        assert.deepEqual(Object.keys(event).sort(), ["agent","compactions","entries","inbox","nestedTools","tools","type","usage"]);
        assert.equal(event.type, "snapshot");
        for (const key of ["entries","tools","nestedTools","compactions","inbox"]) assert.ok(emptyArray(event[key]));
        assert.ok(recordObject(event.agent));
        assert.ok(recordObject(event.usage) && emptyObject(event.usage.models) && emptyObject(event.usage.tools));
        rootSeen = true;
      }
    } else if (frame.type === "conversation.inbox") {
      assert.equal(frame.conversationId, 1); assert.ok(emptyArray(frame.items)); inboxSeen = true;
    } else if (frame.type === "presence.typing") {
      assert.equal(frame.conversationId, 1); assert.ok(emptyArray(frame.usernames));
    } else throw new Error("Ambiguous reconciliation frame");
  }
  assert.ok(sessionSeen && rootSeen && inboxSeen, "Complete automatic root baseline required");
  return { boot: witness.boot, posts: 0, rootId: 1, empty: true };
}
export function proofStageAllowed(proof, stage) {
  if (stage === "reconcile") {
    assert.ok(proof?.state === "UNKNOWN" && proof.attemptedStage === "seed" && !proof.reconciliation,
      "Only the retained unlocalized seed can be reconciled once");
  } else if (stage === "seed" && proof !== undefined) {
    assert.ok(proof.state === "RECONCILED_EMPTY" && proof.originalUnknown?.state === "UNKNOWN" &&
      proof.reconciliation?.empty === true && proof.reconciliation.posts === 0 && proof.reconciliation.rootId === 1);
    proofWitness({ ...proof.reconciliation, prior: "false" }, 0, "false");
  }
}
export async function waitOwnerFrame(frames, socket, predicate, signal, timeout = 60_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    signal.throwIfAborted();
    const found = frames.find(predicate);
    if (found) return found;
    if (socket.readyState !== WebSocket.OPEN) throw new Error("Connection lost; outcome unknown");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("Outcome unknown; do not resend");
}
export async function reconcileConnection(connection) {
  await connection.wait(frame => frame.type === "conversation.events" && frame.conversationId === 1 &&
    Array.isArray(frame.events) && frame.events.some(event => event.type === "snapshot"));
  await connection.wait(frame => frame.type === "conversation.inbox" && frame.conversationId === 1);
  await connection.close();
  return emptyRootCertificate(connection.frames, connection.witness);
}

async function run() {
const { values } = parseArgs({ options: {
  url: { type: "string" }, session: { type: "string" }, host: { type: "string" },
  cloudflared: { type: "string" }, stage: { type: "string" }, continue: { type: "boolean" },
} });
proofIdentity(values);
if (!process.stderr.isTTY || !values.url || !values.session || !values.host || !values.cloudflared) {
  throw new Error("Owner interactive terminal and url/session/host/cloudflared arguments required");
}
if (process.getuid() !== 1001 || homedir() !== "/home/dev") throw new Error("Wrong native owner context");
const { lstat } = await import("node:fs/promises");
const home = await lstat(homedir());
if (home.isSymbolicLink() || home.uid !== 1001 || (home.mode & 0o777) !== 0o700) throw new Error("Unsafe native owner home");
const path = homedir() + "/.config/pi-worker-owner/registration.json";
const abort = new AbortController();
process.once("SIGINT", () => abort.abort());
await withOwnerSockets(abort.signal, async sockets => withRegistration(path, async store => {
const stage = values.stage;
if (!["login", "reauth", "refresh", "seed", "recall", "reconcile"].includes(stage)) throw new Error("Explicit lifecycle stage required");
const { openaiChatGPTOAuth } = await loadOwnerOAuth();
if (stage === "login" || stage === "reauth") {
  await replaceCredential(store, values.host, stage, () => openaiChatGPTOAuth.login({
    signal: abort.signal,
    notify(event) {
      if (event.type === "auth_url") process.stderr.write("Owner browser; existing SSH forward1455 required:\n" + event.url + "\n");
    },
    prompt({ signal }) { return new Promise((_, reject) => {
      if (signal.aborted) reject(new Error("cancelled"));
      else signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
    }); },
  }, {
    getDeviceId: () => values.host,
    registeredClientId: stage === "reauth" ? store.get().credential?.clientId ?? store.get().pendingClientId : undefined,
    async beforeTokenExchange(clientId) {
      await store.save({ ...store.get(), pendingClientId: clientId });
    },
  }));
  console.log(JSON.stringify({ scope: "LOCAL_CREDENTIAL_LIFECYCLE", stage, status: "READY", workerInference: "NOT_RUN" }));
  return;
}
const credential = ready(store.get(), values.host);
if (stage === "refresh") {
  const timing = refreshTiming(credential);
  if (!timing.allowed) {
    console.log(JSON.stringify({ scope: "LOCAL_REFRESH", status: timing.status, fieldType: timing.fieldType ?? null, refreshSent: false }));
    process.exitCode = 1; return;
  }
  await replaceCredential(store, values.host, "refresh", old =>
    openaiChatGPTOAuth.refresh(old, AbortSignal.any([abort.signal, AbortSignal.timeout(15_000)])));
  console.log(JSON.stringify({ scope: "LOCAL_REFRESH", status: "ROTATED_AND_DURABLE", workerInference: "NOT_RUN" }));
  return;
}
// A connection can resume persisted Harness work BEFORE a new prompt. This is bounded
// paid continuation consent, never a read-only status query or an automatic recovery.
if (!values.continue) throw new Error("Explicit --continue required before access attachment");
const record = store.get();
proofStageAllowed(record.proof, stage);
if (stage === "recall" && (record.proof?.state !== "SEEDED" || (record.rotations ?? 0) <= record.proof.rotations)) {
  throw new Error("Completed seed and actual durable refresh required");
}
const previousProof = record.proof;
if (stage === "recall" && (previousProof.session !== values.session || previousProof.origin !== values.url || previousProof.host !== values.host)) throw new Error("Proof binding mismatch");
if (stage === "reconcile") {
  await store.save({ ...record, proof: { ...previousProof, reconciliation: { state: "UNKNOWN" } } });
} else await store.save({ ...record, proof: { ...previousProof, state: "UNKNOWN", attemptedStage: stage } });
const origin = new URL(values.url);
assert.equal(origin.protocol, "https:");
assert.equal(origin.pathname, "/");
phase("CF_CACHE");
const accessJwt = execFileSync(values.cloudflared, ["access", "token", "--app", origin.origin],
  { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const bearer = { token: credential.access, expires: credential.expires };
if (stage !== "reconcile") {
phase("CATALOG_HTTP");
const catalogResponse = await fetch("https://api.openai.com/v1/models", {
  headers: { Authorization: "Bearer " + bearer.token }, redirect: "error", signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15_000)]),
});
lastHttpStatus = catalogResponse.status;
assert.equal(catalogResponse.ok, true, "Account catalog unavailable; stop without retry");
const catalog = await catalogResponse.json();
assert.ok(Array.isArray(catalog.models) && catalog.models.some(model => model.visibility === "list" && model.slug === "gpt-6-luna"), "Configured model unavailable; separate model review required");
}

async function connect() {
  abort.signal.throwIfAborted();
  assert.ok(bearer.expires > Date.now() + 30_000, "Access expired; stop without reauthentication/retry");
  const url = new URL("/api/sessions/" + values.session, origin);
  url.protocol = "wss:";
  phase("WORKER_WS");
  const ws = new WebSocket(url, {
    headers: { Cookie: "CF_Authorization=" + accessJwt,
      "Pi-Proof-Access": bearer.token, "Pi-Proof-Expires": String(bearer.expires) },
    followRedirects: false, handshakeTimeout: 15_000,
  });
  sockets.add(ws);
  ws.once("close", () => sockets.delete(ws));
  ws.on("error", () => {}); // All owned socket errors end this attempt; no reconnect.
  const frames = [];
  let witness;
  ws.on("upgrade", response => { witness = {
    boot: response.headers["pi-proof-boot"], prior: response.headers["pi-proof-prior-token"],
    posts: typeof response.headers["pi-proof-posts"] === "string" && /^[0-3]$/.test(response.headers["pi-proof-posts"]) ? Number(response.headers["pi-proof-posts"]) : NaN,
  }; });
  ws.on("unexpected-response", (_request, response) => {
    lastHttpStatus = response.statusCode;
    response.resume(); ws.terminate();
  });
  ws.on("message", data => {
    const frame = parseOwnerFrame(data);
    frames.push(frame);
    if (frame?.type === "invalid.owner.frame") { phase("INVALID_WS_FRAME"); ws.terminate(); }
  });
  await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", () => reject(new Error("Owner WebSocket rejected"))); });
  const wait = predicate => waitOwnerFrame(frames, ws, predicate, abort.signal);
  await wait(frame => frame.type === "session.snapshot");
  return {
    witness, frames, wait,
    async command(command) {
      ws.send(JSON.stringify(command));
      const result = await wait(frame => frame.type === "command.result" && frame.requestId === command.requestId);
      assert.equal(result.ok, true);
      return result;
    },
    async turn(conversationId, content) {
      const start = frames.length;
      const result = await this.command({ type: "prompt.submit", requestId: randomUUID(), conversationId, content });
      await wait(frame => completedTurn(frame, conversationId, result.submissionId));
      return turnMessages(frames.slice(start), conversationId);
    },
    close() {
      return closeOwnerSocket(ws, abort.signal);
    },
  };
}
function assistant(messages) {
  const reply = messages.filter(message => message.role === "assistant" && message.stopReason === "stop").at(-1);
  assert.ok(reply, "No completed new assistant reply");
  return reply.content.filter(part => part.type === "text").map(part => part.text).join("");
}
if (stage === "reconcile") {
  phase("RECONCILE_SNAPSHOT");
  const connection = await connect();
  const certificate = await reconcileConnection(connection);
  phase("RECONCILE_COMMIT");
  await store.save({ ...store.get(), proof: { state: "RECONCILED_EMPTY", originalUnknown: previousProof,
    reconciliation: certificate } });
  console.log(JSON.stringify({ scope: "CURRENT_SESSION_RECONCILED_EMPTY", posts: certificate.posts,
    rootId: certificate.rootId, originalEffectBoundary: "UNKNOWN", noClientCommands: true,
    nextSeed: "SEPARATE_GO_AFTER_EXIT_IDLE_NEW_BOOT" }));
  return;
}
if (stage === "seed") {
const first = await connect();
proofWitness(first.witness, 0, "false");
if (previousProof?.state === "RECONCILED_EMPTY") assert.notEqual(first.witness.boot, previousProof.reconciliation.boot, "Idle/recreated instance required after reconciliation");
phase("SEED_CREATE");
const created = await first.command({ type: "conversation.create", requestId: randomUUID() });
const marker = randomBytes(24).toString("hex");
phase("SEED_SUBMIT");
const messages = await first.turn(created.conversationId,
  "Remember marker " + marker + ". Call ask_jev exactly once with state describing this finite memory experiment and one likelihood question. Use its actual assessment, then repeat the marker and assessment.");
const results = messages.filter(message => message.role === "toolResult" && message.toolName === "ask_jev");
assert.equal(results.length, 1); assert.equal(results[0].isError, false);
const calls = messages.filter(message => message.role === "assistant").flatMap(message => message.content).filter(part => part.type === "toolCall");
assert.equal(calls.length, 1); assert.equal(calls[0].id, results[0].toolCallId);
const assessment = JSON.parse(results[0].content.filter(part => part.type === "text").map(part => part.text).join(""));
assert.equal(assessment.type, "noul"); assert.ok(Number.isFinite(assessment.noul));
const answer = assistant(messages);
assert.ok(answer.includes(marker) && answer.includes(String(assessment.noul)));
const completions = completionReceipt(messages, ["toolUse", "stop"]);
await first.close();
phase("SEED_COMMIT");
await store.save({ ...store.get(), proof: { ...previousProof, state: "SEEDED", session: values.session,
  origin: values.url, host: values.host, conversationId: created.conversationId, marker, assessment, boot: first.witness.boot,
  rotations: record.rotations ?? 0, completions, seededAt: Date.now() } });
console.log(JSON.stringify({ scope: "ACTUAL_WORKER_SEED_ONLY", status: "SEEDED", conversationId: created.conversationId,
  completions, successfulJevToolResults: 1, memoryRecall: "NOT_RUN" }));
} else {
assert.equal(previousProof.session, values.session);
const reopened = await connect();
proofWitness(reopened.witness, 2, "false");
assert.ok(reopened.witness.boot !== previousProof.boot && reopened.witness.prior === "false",
  "NOT_PROVEN: real DO recreation not observed; no recall prompt sent");
assert.equal(reopened.witness.posts, 2);
await reopened.command({ type: "conversation.open", requestId: randomUUID(), conversationId: previousProof.conversationId });
phase("RECALL_SUBMIT");
const messages = await reopened.turn(previousProof.conversationId,
  "Recall the marker and exact Jev assessment as its original typed object from our earlier exchange. Return only JSON with keys marker and assessment. Do not call tools.");
const parsed = JSON.parse(assistant(messages));
assert.equal(parsed.marker, previousProof.marker);
assert.deepEqual(parsed.assessment, previousProof.assessment);
const completions = [...previousProof.completions, ...completionReceipt(messages, ["stop"])];
assertDistinctCompletions(completions);
await reopened.close();
const receipt = await connect();
proofWitness(receipt.witness, 3);
await receipt.close();
await store.save({ ...store.get(), proof: { ...previousProof, state: "COMPLETE", completions } });
console.log(JSON.stringify({ scope: "ACTUAL_WORKER_CREDENTIAL_LIFECYCLE_PROOF", session: values.session,
  conversationId: previousProof.conversationId, completions, responsesPostAttempts: 3,
  successfulJevToolResults: 1, recreated: true, priorTokenAbsent: true, actualRefreshPersistedAcrossProcess: true,
  markerSha256: createHash("sha256").update(previousProof.marker).digest("hex"),
  assessment: previousProof.assessment, recallMatched: true, noClientHistoryReinjection: true,
  providerBillingUsage: "NOT_INDEPENDENTLY_VERIFIED" }));
}
}));
}
export function assertDistinctCompletions(completions) {
  assert.equal(new Set(completions.map(item => item.responseId)).size, completions.length, "Duplicate provider completion identity");
}
export function completionReceipt(messages, expected) {
  const completions = messages.filter(message => message.role === "assistant").map(message => ({
    responseId: message.responseId ?? null, model: message.model ?? null, stopReason: message.stopReason,
    rawStopReason: message.rawStopReason, sdkUsage: message.usage ? { input: message.usage.input,
      output: message.usage.output, totalTokens: message.usage.totalTokens } : null,
  }));
  assert.deepEqual(completions.map(item => item.stopReason), expected);
  assert.ok(completions.every(item => typeof item.responseId === "string" && item.responseId.length > 0 && item.rawStopReason === "completed"));
  assertDistinctCompletions(completions);
  return completions;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run().catch(() => { console.error(JSON.stringify({ scope: "OWNER_LIFECYCLE", status: "STOPPED_NOT_PROVEN", phase: lastPhase, httpStatus: Number.isInteger(lastHttpStatus) && lastHttpStatus >= 100 && lastHttpStatus <= 599 ? lastHttpStatus : null, noAutomaticResend: true })); process.exitCode = 1; });
