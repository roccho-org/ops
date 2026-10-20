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

export function proofIdentity(values) {
  const url = new URL(values.url);
  if (url.origin !== "https://pi.roccho.workers.dev" || url.pathname !== "/" ||
      url.username || url.password || url.search || url.hash ||
      values.session !== "owner-jev-proof-20261020" ||
      values.host !== "64a8f191-83c2-5eeb-8dc0-612bc80970db" ||
      !["login","reauth","refresh","seed","recall"].includes(values.stage) ||
      (["seed","recall"].includes(values.stage) && values.continue !== true)) throw new Error("Proof identity mismatch");
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
await withRegistration(path, async store => {
const stage = values.stage;
if (!["login", "reauth", "refresh", "seed", "recall"].includes(stage)) throw new Error("Explicit lifecycle stage required");
const { openaiChatGPTOAuth } = await loadOwnerOAuth();
const abort = new AbortController();
process.once("SIGINT", () => abort.abort());
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
if (stage === "seed" && record.proof) throw new Error("Proof already attempted; never resend");
if (stage === "recall" && (record.proof?.state !== "SEEDED" || (record.rotations ?? 0) <= record.proof.rotations)) {
  throw new Error("Completed seed and actual durable refresh required");
}
const previousProof = record.proof;
if (stage === "recall" && (previousProof.session !== values.session || previousProof.origin !== values.url || previousProof.host !== values.host)) throw new Error("Proof binding mismatch");
await store.save({ ...record, proof: { ...previousProof, state: "UNKNOWN", attemptedStage: stage } });
const origin = new URL(values.url);
assert.equal(origin.protocol, "https:");
assert.equal(origin.pathname, "/");
const accessJwt = execFileSync(values.cloudflared, ["access", "token", "--app", origin.origin],
  { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const bearer = { token: credential.access, expires: credential.expires };
const catalogResponse = await fetch("https://api.openai.com/v1/models", {
  headers: { Authorization: "Bearer " + bearer.token }, redirect: "error", signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15_000)]),
});
assert.equal(catalogResponse.ok, true, "Account catalog unavailable; stop without retry");
const catalog = await catalogResponse.json();
assert.ok(Array.isArray(catalog.models) && catalog.models.some(model => model.visibility === "list" && model.slug === "gpt-6-luna"), "Configured model unavailable; separate model review required");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function connect() {
  assert.ok(bearer.expires > Date.now() + 30_000, "Access expired; stop without reauthentication/retry");
  const url = new URL("/api/sessions/" + values.session, origin);
  url.protocol = "wss:";
  const ws = new WebSocket(url, {
    headers: { Cookie: "CF_Authorization=" + accessJwt,
      "Pi-Proof-Access": bearer.token, "Pi-Proof-Expires": String(bearer.expires) },
    followRedirects: false, handshakeTimeout: 15_000,
  });
  const frames = [];
  let witness;
  ws.on("upgrade", response => { witness = {
    boot: response.headers["pi-proof-boot"], prior: response.headers["pi-proof-prior-token"],
    posts: typeof response.headers["pi-proof-posts"] === "string" && /^[0-3]$/.test(response.headers["pi-proof-posts"]) ? Number(response.headers["pi-proof-posts"]) : NaN,
  }; });
  ws.on("message", data => frames.push(JSON.parse(String(data))));
  await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", () => reject(new Error("Owner WebSocket rejected"))); });
  async function wait(predicate) {
    const end = Date.now() + 60_000;
    while (Date.now() < end) {
      const found = frames.find(predicate);
      if (found) return found;
      if (ws.readyState !== WebSocket.OPEN) throw new Error("Connection lost; outcome unknown");
      await delay(50);
    }
    throw new Error("Outcome unknown; do not resend");
  }
  await wait(frame => frame.type === "session.snapshot");
  return {
    witness, frames,
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
      return new Promise(resolve => { ws.once("close", resolve); ws.close(1000, "finite proof"); });
    },
  };
}
function assistant(messages) {
  const reply = messages.filter(message => message.role === "assistant" && message.stopReason === "stop").at(-1);
  assert.ok(reply, "No completed new assistant reply");
  return reply.content.filter(part => part.type === "text").map(part => part.text).join("");
}
if (stage === "seed") {
const first = await connect();
proofWitness(first.witness, 0, "false");
const created = await first.command({ type: "conversation.create", requestId: randomUUID() });
const marker = randomBytes(24).toString("hex");
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
await store.save({ ...store.get(), proof: { state: "SEEDED", session: values.session,
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
const messages = await reopened.turn(previousProof.conversationId,
  "Recall the marker and exact Jev assessment as its original typed object from our earlier exchange. Return only JSON with keys marker and assessment. Do not call tools.");
const parsed = JSON.parse(assistant(messages));
assert.equal(parsed.marker, previousProof.marker);
assert.deepEqual(parsed.assessment, previousProof.assessment);
const completions = [...previousProof.completions, ...completionReceipt(messages, ["stop"])];
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
});
}
export function completionReceipt(messages, expected) {
  const completions = messages.filter(message => message.role === "assistant").map(message => ({
    responseId: message.responseId ?? null, model: message.model ?? null, stopReason: message.stopReason,
    rawStopReason: message.rawStopReason, sdkUsage: message.usage ? { input: message.usage.input,
      output: message.usage.output, totalTokens: message.usage.totalTokens } : null,
  }));
  assert.deepEqual(completions.map(item => item.stopReason), expected);
  assert.ok(completions.every(item => typeof item.responseId === "string" && item.responseId.length > 0 && item.rawStopReason === "completed"));
  return completions;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run().catch(() => { console.error(JSON.stringify({ scope: "OWNER_LIFECYCLE", status: "STOPPED_NOT_PROVEN", noAutomaticResend: true })); process.exitCode = 1; });
