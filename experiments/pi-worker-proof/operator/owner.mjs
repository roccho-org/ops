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
let lastSocketTrace;
let lastProviderFailure;
function phase(name) { lastPhase = name; lastHttpStatus = undefined; console.log(JSON.stringify({ scope: "OWNER_PHASE_ENTERED", phase: name })); }
export function parseOwnerFrame(data) {
  try { return JSON.parse(String(data)); } catch { return { type: "invalid.owner.frame" }; }
}
export function safeOwnerErrorCode(error) {
  const codes = ["ENOTFOUND","EAI_AGAIN","ECONNREFUSED","ECONNRESET","ETIMEDOUT","ENETUNREACH","EHOSTUNREACH",
    "EPROTO","ERR_TLS_CERT_ALTNAME_INVALID","CERT_HAS_EXPIRED","UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "DEPTH_ZERO_SELF_SIGNED_CERT","ERR_HTTP_INVALID_HEADER_VALUE","ERR_INVALID_CHAR","ERR_INVALID_URL"];
  return codes.includes(error?.code) ? error.code : error?.code === undefined ? "UNKNOWN" : "OTHER";
}
export function observeOwnerSocket(socket, frames, invalidFrame = () => {}) {
  const trace = { errorCode: "UNKNOWN", httpStatus: null, upgradeSeen101: false, witness: undefined };
  socket.on("error", error => { trace.errorCode = safeOwnerErrorCode(error); });
  socket.on("upgrade", response => {
    trace.httpStatus = response.statusCode;
    trace.upgradeSeen101 = response.statusCode === 101;
    trace.witness = {
      boot: response.headers["pi-proof-boot"], prior: response.headers["pi-proof-prior-token"],
      posts: typeof response.headers["pi-proof-posts"] === "string" && /^[0-5]$/.test(response.headers["pi-proof-posts"]) ? Number(response.headers["pi-proof-posts"]) : NaN,
    };
  });
  socket.on("unexpected-response", (_request, response) => {
    trace.httpStatus = response.statusCode; response.resume(); socket.terminate();
  });
  socket.on("message", data => {
    const frame = parseOwnerFrame(data); frames.push(frame);
    if (frame?.type === "invalid.owner.frame") { invalidFrame(); socket.terminate(); }
  });
  return trace;
}
export function safeWitnessStatus(witness) {
  return {
    bootPresent: typeof witness?.boot === "string" && witness.boot.length > 0,
    bootValid: typeof witness?.boot === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(witness.boot),
    posts: Number.isInteger(witness?.posts) && witness.posts >= 0 && witness.posts <= 5 ? witness.posts : null,
    priorToken: witness?.prior === "true" ? true : witness?.prior === "false" ? false : null,
  };
}
export function proofIdentity(values) {
  const url = new URL(values.url);
  if (url.origin !== "https://pi.roccho.workers.dev" || url.pathname !== "/" ||
      url.username || url.password || url.search || url.hash ||
      values.session !== "owner-jev-proof-20261020" ||
      values.host !== "64a8f191-83c2-5eeb-8dc0-612bc80970db" ||
      !["login","reauth","refresh","seed","recall","reconcile","history"].includes(values.stage) ||
      (["seed","recall","reconcile","history"].includes(values.stage) && values.continue !== true) ||
      (values["forensic-once"] === true && values.stage !== "reconcile") ||
      (values["recover-seed-once"] === true && values.stage !== "seed") ||
      (values["recover-transport-once"] === true && (values.stage !== "seed" || values["recover-seed-once"] === true))) throw new Error("Proof identity mismatch");
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
function conversationSnapshot(value) {
  const required = ["agent","compactions","entries","inbox","nestedTools","tools","type","usage"];
  return recordObject(value) && value.type === "snapshot" &&
    required.every(key => Object.hasOwn(value, key)) &&
    Object.keys(value).every(key => [...required,"run","generation","compactionFailure"].includes(key)) &&
    ["entries","tools","nestedTools","compactions","inbox"].every(key => Array.isArray(value[key])) &&
    recordObject(value.agent) && recordObject(value.usage) &&
    recordObject(value.usage.models) && recordObject(value.usage.tools) && Object.keys(value.usage).sort().join(",") === "models,tools";
}
function emptyConversationSnapshot(value) {
  return conversationSnapshot(value) && !["run","generation","compactionFailure"].some(key => Object.hasOwn(value,key)) &&
    ["entries","tools","nestedTools","compactions","inbox"].every(key => emptyArray(value[key])) &&
    emptyObject(value.usage.models) && emptyObject(value.usage.tools);
}
function automaticSnapshot(frames, id) {
  const snapshots = frames.filter(frame => frame?.type === "conversation.events" && frame.conversationId === id)
    .flatMap(frame => Array.isArray(frame.events) ? frame.events : []).filter(event => event?.type === "snapshot");
  assert.equal(snapshots.length, 1);
  assert.ok(conversationSnapshot(snapshots[0]));
  const inboxes = frames.filter(frame => frame?.type === "conversation.inbox" && frame.conversationId === id);
  assert.ok(inboxes.length > 0 && inboxes.every(frame => Array.isArray(frame.items)));
  return { snapshot: snapshots[0], inboxes };
}
export function historyTarget(frames, witness) {
  let inventoryCount = null;
  try {
    proofWitness(witness, witness?.posts);
    assert.ok(witness.posts >= 1 && witness.posts <= 3);
    const sessions = frames.filter(frame => frame?.type === "session.snapshot");
    assert.equal(sessions.length, 1);
    const session = sessions[0].session;
    assert.ok(recordObject(session) && Array.isArray(session.conversations));
    inventoryCount = session.conversations.length;
    const ids = session.conversations.map(row => {
      assert.ok(recordObject(row) && Object.keys(row).length === 1 && Object.hasOwn(row,"id") &&
        Number.isSafeInteger(row.id) && row.id > 0);
      return row.id;
    });
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(ids.includes(1));
    assert.ok(recordObject(session.activity) && recordObject(session.activity.tasks));
    const root = automaticSnapshot(frames, 1);
    if (!emptyObject(session.activity.tasks) || frames.some(frame =>
      frame?.type === "session.activity" && (!recordObject(frame.activity) || !emptyObject(frame.activity.tasks)))) {
      return { classification: "LIVE_OR_UNKNOWN_ACTIVITY", inventoryCount };
    }
    assert.ok(frames.every(frame => frame && ["session.snapshot","session.activity","conversation.events","conversation.inbox","presence.typing"].includes(frame.type) &&
      (!Object.hasOwn(frame,"conversationId") || frame.conversationId === 1)));
    const rootEvents = frames.filter(frame => frame.type === "conversation.events").flatMap(frame => frame.events);
    assert.ok(rootEvents.every(event => event?.type === "snapshot"));
    if (ids.length === 1) return { classification: "ROOT_AUTOMATIC", inventoryCount, conversationId: 1 };
    if (ids.length === 2 && emptyConversationSnapshot(root.snapshot) && root.inboxes.every(frame => emptyArray(frame.items))) {
      return { classification: "UNIQUE_OWNERLESS_NONROOT", inventoryCount, conversationId: ids.find(id => id !== 1) };
    }
    return { classification: "AMBIGUOUS_INVENTORY_OR_ROOT_WORK", inventoryCount };
  } catch { return { classification: "UNKNOWN_SCHEMA_OR_WITNESS", inventoryCount }; }
}
export function summarizeHistory(frames, id, witness) {
  proofWitness(witness, witness?.posts); assert.ok(witness.posts >= 1 && witness.posts <= 3);
  const { snapshot, inboxes } = automaticSnapshot(frames, id);
  const messages = snapshot.entries.flatMap(entry => {
    assert.ok(recordObject(entry));
    if (entry.model === undefined) return [];
    assert.ok(Array.isArray(entry.model)); return entry.model;
  });
  assert.ok(messages.every(recordObject));
  const assistants = messages.filter(message => message.role === "assistant");
  const completed = assistants.filter(message => ["stop","toolUse"].includes(message.stopReason) &&
    message.rawStopReason === "completed" && typeof message.responseId === "string" && message.responseId.length > 0);
  const calls = assistants.flatMap(message => Array.isArray(message.content) ? message.content : [])
    .filter(part => part?.type === "toolCall" && part.name === "ask_jev" && typeof part.id === "string" && part.id.length > 0);
  const results = messages.filter(message => message.role === "toolResult" && message.toolName === "ask_jev");
  const matchedTyped = results.filter(result => {
    if (result.isError !== false || typeof result.toolCallId !== "string" || result.toolCallId.length === 0 ||
        calls.filter(call => call.id === result.toolCallId).length !== 1 || !Array.isArray(result.content) ||
        result.content.length !== 1 || result.content[0]?.type !== "text" || typeof result.content[0].text !== "string") return false;
    try {
      const assessment = JSON.parse(result.content[0].text);
      return recordObject(assessment) && Object.keys(assessment).sort().join(",") === "noul,type" &&
        assessment.type === "noul" && Number.isFinite(assessment.noul) && assessment.noul >= 0 && assessment.noul <= 1;
    } catch { return false; }
  }).length;
  const otherEvents = frames.filter(frame => frame?.type === "conversation.events" && [1,id].includes(frame.conversationId))
    .flatMap(frame => frame.events).filter(event => event?.type !== "snapshot").length;
  const pending = ["run","generation"].some(key => Object.hasOwn(snapshot,key)) ||
    snapshot.inbox.length > 0 || snapshot.tools.length > 0 || snapshot.nestedTools.length > 0 || snapshot.compactions.length > 0 ||
    inboxes.some(frame => frame.items.length > 0);
  const errors = assistants.filter(message => ["error","aborted"].includes(message.stopReason)).length;
  const distinctCompletions = new Set(completed.map(message => message.responseId)).size === completed.length;
  const classification = otherEvents > 0 ? "ACTIVITY_DURING_INSPECTION" : pending ? "LIVE_OR_UNRESOLVED_STATE" :
    Object.hasOwn(snapshot,"compactionFailure") ? "COMPACTION_FAILURE_OBSERVED" :
    errors > 0 ? "MODEL_ERROR_OR_ABORT_OBSERVED" : !distinctCompletions ? "AMBIGUOUS_COMPLETIONS" :
    matchedTyped > 0 ? "COMMITTED_JEV_RESULT_OBSERVED" : "SNAPSHOT_OBSERVED_ONLY";
  return { classification, postsAtUpgrade: witness.posts, entryCount: snapshot.entries.length,
    userMessageCount: messages.filter(message => message.role === "user").length, assistantCount: assistants.length,
    completedAssistantCount: completed.length, distinctCompletions, errorOrAbortCount: errors,
    askJevCallCount: calls.length, askJevResultCount: results.length, matchedTypedJevResultCount: matchedTyped,
    pendingObserved: pending, subsequentEventCount: otherEvents, subsequentEventScope: "ROOT_AND_SELECTED_CONVERSATION",
    providerHttpCause: "UNAVAILABLE_FROM_MASKED_HISTORY" };
}
export async function inspectHistoryConnection(connection, closeAfter = true) {
  await connection.wait(frame => frame?.type === "conversation.events" && frame.conversationId === 1 &&
    Array.isArray(frame.events) && frame.events.some(event => event?.type === "snapshot"));
  await connection.wait(frame => frame?.type === "conversation.inbox" && frame.conversationId === 1);
  const selected = historyTarget(connection.frames, connection.witness);
  if (selected.conversationId === undefined) {
    await connection.close();
    return { classification: selected.classification, inventoryCount: selected.inventoryCount, openedConversationCount: 0, inspected: false };
  }
  let openingRequestId;
  if (selected.conversationId !== 1) {
    openingRequestId = randomUUID();
    await connection.command({ type: "conversation.open", requestId: openingRequestId, conversationId: selected.conversationId });
    await connection.wait(frame => frame?.type === "conversation.events" && frame.conversationId === selected.conversationId &&
      Array.isArray(frame.events) && frame.events.some(event => event?.type === "snapshot"));
    await connection.wait(frame => frame?.type === "conversation.inbox" && frame.conversationId === selected.conversationId);
  }
  if (closeAfter) await connection.close();
  // Reject foreign/unknown frames rather than silently filtering them from the inspected snapshot.
  assert.ok(connection.frames.every(frame => {
    if (!recordObject(frame)) return false;
    if (["session.snapshot","session.activity"].includes(frame.type)) return true;
    if (frame.type === "command.result") return openingRequestId !== undefined &&
      frame.command === "conversation.open" && frame.requestId === openingRequestId && frame.ok === true;
    if (!Number.isSafeInteger(frame.conversationId) || ![1,selected.conversationId].includes(frame.conversationId)) return false;
    if (frame.type === "conversation.events") return Array.isArray(frame.events) && frame.events.length > 0 && frame.events.every(recordObject);
    if (frame.type === "conversation.inbox") return Array.isArray(frame.items);
    return frame.type === "presence.typing" && Array.isArray(frame.usernames);
  }));
  const rootSnapshotCount = connection.frames.filter(frame => frame.type === "conversation.events" && frame.conversationId === 1)
    .flatMap(frame => frame.events).filter(event => event.type === "snapshot").length;
  if (rootSnapshotCount !== 1 || connection.frames.filter(frame => frame.type === "session.snapshot").length !== 1 ||
      connection.frames.some(frame => frame.type === "session.activity" &&
        (!recordObject(frame.activity) || !emptyObject(frame.activity.tasks)))) {
    return { classification: "ACTIVITY_OR_INVENTORY_CHANGED", inventoryCount: selected.inventoryCount,
      openedConversationCount: selected.conversationId === 1 ? 0 : 1, inspected: false };
  }
  return { ...summarizeHistory(connection.frames, selected.conversationId, connection.witness),
    inventoryCount: selected.inventoryCount, openedConversationCount: selected.conversationId === 1 ? 0 : 1, inspected: true };
}
export async function beginHistoryInspection(store, expires) {
  const record = store.get();
  proofStageAllowed(record.proof, "history");
  assert.ok(Number.isFinite(expires) && expires > Date.now() + 30_000);
  await store.save({ ...record, proof: { ...record.proof, historyInspection: { state: "UNKNOWN" } } });
}
export async function saveHistoryObservation(store, observation) {
  const record = store.get();
  await store.save({ ...record, proof: { ...record.proof, historyInspection: { state: "OBSERVED", ...observation } } });
}
export function recoveryHistoryAllowed(observation) {
  assert.ok(observation?.classification === "MODEL_ERROR_OR_ABORT_OBSERVED" && observation.inspected === true);
  for (const [key, expected] of Object.entries({ postsAtUpgrade: 1, entryCount: 3, userMessageCount: 1, assistantCount: 1, errorOrAbortCount: 1,
    completedAssistantCount: 0, askJevCallCount: 0, askJevResultCount: 0, matchedTypedJevResultCount: 0,
    subsequentEventCount: 0, inventoryCount: 2, openedConversationCount: 1 })) assert.equal(observation[key], expected);
  assert.equal(observation.pendingObserved, false);
  assert.equal(observation.subsequentEventScope, "ROOT_AND_SELECTED_CONVERSATION");
}
export async function beginSeedRecovery(store, expires) {
  const record = store.get(), proof = record.proof;
  assert.ok(proof?.state === "UNKNOWN" && proof.attemptedStage === "seed" &&
    proof.reconciliation?.state === "UNKNOWN" && proof.reconciliation.forensicOnce?.state === "UNKNOWN" &&
    proof.historyInspection?.state === "OBSERVED" && !Object.hasOwn(proof, "seedRecovery"));
  recoveryHistoryAllowed(proof.historyInspection);
  assert.ok(Number.isFinite(expires) && expires > Date.now() + 30_000);
  await store.save({ ...record, proof: { ...proof, seedRecovery: { state: "UNKNOWN", originalUnknown: proof } } });
}
export async function prepareRecoveryConversation(connection) {
  proofWitness(connection.witness, 1, "false");
  await connection.wait(frame => frame?.type === "conversation.events" && frame.conversationId === 1 &&
    Array.isArray(frame.events) && frame.events.some(event => event?.type === "snapshot"));
  await connection.wait(frame => frame?.type === "conversation.inbox" && frame.conversationId === 1);
  const target = historyTarget(connection.frames, connection.witness);
  assert.equal(target.classification, "UNIQUE_OWNERLESS_NONROOT");
  const observation = await inspectHistoryConnection(connection, false);
  recoveryHistoryAllowed(observation);
  return target.conversationId;
}
export async function beginTransportRecovery(store, expires) {
  const record = store.get(), proof = record.proof;
  assert.ok(proof?.state === "UNKNOWN" && proof.attemptedStage === "seed" &&
    proof.reconciliation?.state === "UNKNOWN" && proof.reconciliation.forensicOnce?.state === "UNKNOWN" &&
    proof.historyInspection?.state === "OBSERVED" && proof.seedRecovery?.state === "UNKNOWN" &&
    recordObject(proof.seedRecovery.originalUnknown) && Number.isSafeInteger(proof.seedRecovery.conversationId) &&
    proof.seedRecovery.conversationId > 1 && !Object.hasOwn(proof, "transportRecovery"));
  recoveryHistoryAllowed(proof.historyInspection);
  assert.ok(Number.isFinite(expires) && expires > Date.now() + 30_000);
  await store.save({ ...record, proof: { ...proof, transportRecovery: { state: "UNKNOWN", originalUnknown: proof } } });
}
export function transportSnapshotAllowed(frames, id, witness) {
  proofWitness(witness, 2, "false");
  const report = summarizeHistory(frames, id, witness);
  for (const [key, expected] of Object.entries({ classification: "MODEL_ERROR_OR_ABORT_OBSERVED",
    userMessageCount: 2, assistantCount: 2, errorOrAbortCount: 2, completedAssistantCount: 0,
    askJevCallCount: 0, askJevResultCount: 0, matchedTypedJevResultCount: 0,
    pendingObserved: false, subsequentEventCount: 0 })) assert.equal(report[key], expected);
  const { snapshot } = automaticSnapshot(frames, id);
  const roles = snapshot.entries.map(entry => {
    assert.ok(!Object.hasOwn(entry, "head") && !Object.hasOwn(entry, "edits"));
    assert.ok(Array.isArray(entry.model) && entry.model.length === 1);
    const role = entry.model[0]?.role;
    assert.equal(entry.kind, { user: "pi.user", assistant: "pi.assistant", system: "pi.system" }[role]);
    assert.ok(["user","assistant","system"].includes(role));
    if (role === "assistant") assert.ok(emptyArray(entry.model[0].content));
    return role;
  });
  // Frozen prompt rendering adds one baseline and may add a clock delta at the next minute.
  assert.ok(JSON.stringify(roles) === JSON.stringify(["user","system","assistant","user","assistant"]) ||
    JSON.stringify(roles) === JSON.stringify(["user","system","assistant","user","system","assistant"]));
  if (roles.length === 6) {
    const delta = snapshot.entries[4].model[0];
    assert.equal(delta.content, "");
    assert.ok(Object.keys(delta).every(key => ["role","content","sections","timestamp"].includes(key)));
    assert.ok(recordObject(delta.sections) && Object.keys(delta.sections).join(",") === "clock");
    assert.match(delta.sections.clock, /^Current time: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z\.$/);
  }
  const latest = snapshot.entries.at(-1).model[0];
  assert.deepEqual(providerFailureReceipt([latest]), { scope: "PI_PROOF_PROVIDER_FAILURE",
    version: 1, attempt: 2, httpStatus: null, outcome: "TRANSPORT" });
  return report;
}
export async function prepareTransportConversation(connection, savedId) {
  proofWitness(connection.witness, 2, "false");
  await connection.wait(frame => frame?.type === "conversation.events" && frame.conversationId === 1 &&
    Array.isArray(frame.events) && frame.events.some(event => event?.type === "snapshot"));
  await connection.wait(frame => frame?.type === "conversation.inbox" && frame.conversationId === 1);
  const selected = historyTarget(connection.frames, connection.witness);
  assert.equal(selected.classification, "UNIQUE_OWNERLESS_NONROOT");
  assert.equal(selected.conversationId, savedId);
  const observation = await inspectHistoryConnection(connection, false);
  assert.ok(observation.inspected && observation.inventoryCount === 2 && observation.openedConversationCount === 1);
  transportSnapshotAllowed(connection.frames, savedId, connection.witness);
  return savedId;
}
export function providerFailureReceipt(messages) {
  const failures = messages.filter(message => message.role === "assistant" && ["error","aborted"].includes(message.stopReason));
  if (failures.length === 0) return undefined;
  const unknown = { scope: "PI_PROOF_PROVIDER_FAILURE", version: 1, attempt: null, httpStatus: null, outcome: "UNKNOWN" };
  if (failures.length !== 1) return unknown;
  try {
    const value = JSON.parse(failures[0].errorMessage);
    assert.deepEqual(Object.keys(value).sort(), Object.keys(unknown).sort());
    assert.equal(value.scope, unknown.scope); assert.equal(value.version, 1);
    assert.ok(value.attempt === null || (Number.isInteger(value.attempt) && value.attempt >= 1 && value.attempt <= 5));
    assert.ok(value.httpStatus === null || (Number.isInteger(value.httpStatus) && value.httpStatus >= 100 && value.httpStatus <= 599));
    assert.ok(["HTTP","TRANSPORT","NOT_SENT","UNKNOWN"].includes(value.outcome));
    assert.ok(value.outcome !== "HTTP" || (value.attempt !== null && value.httpStatus !== null));
    assert.ok(value.outcome === "HTTP" || value.httpStatus === null);
    assert.ok(value.outcome !== "TRANSPORT" || value.attempt !== null);
    assert.ok(!["NOT_SENT","UNKNOWN"].includes(value.outcome) || value.attempt === null);
    return value;
  } catch { return unknown; }
}
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
        assert.ok(emptyConversationSnapshot(event));
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
export function proofStageAllowed(proof, stage, forensicOnce = false) {
  if (stage === "reconcile") {
    assert.ok(proof?.state === "UNKNOWN" && proof.attemptedStage === "seed");
    if (forensicOnce) assert.ok(recordObject(proof.reconciliation) && proof.reconciliation.state === "UNKNOWN" && !Object.hasOwn(proof.reconciliation, "forensicOnce"),
      "Only one explicitly admitted forensic attempt after the first UNKNOWN");
    else assert.ok(!Object.hasOwn(proof, "reconciliation"), "Only the retained unlocalized seed can be reconciled once");
  } else if (stage === "history") {
    assert.ok(proof?.state === "UNKNOWN" && proof.attemptedStage === "seed" &&
      proof.reconciliation?.state === "UNKNOWN" && proof.reconciliation.forensicOnce?.state === "UNKNOWN" &&
      !Object.hasOwn(proof,"historyInspection"), "One distinct history inspection after consumed forensic admission");
  } else if (stage === "seed" && proof !== undefined) {
    assert.ok(proof.state === "RECONCILED_EMPTY" && proof.originalUnknown?.state === "UNKNOWN" &&
      proof.reconciliation?.empty === true && proof.reconciliation.posts === 0 && proof.reconciliation.rootId === 1);
    proofWitness({ ...proof.reconciliation, prior: "false" }, 0, "false");
  }
}
export async function beginReconciliation(store, forensicOnce, expires) {
  const record = store.get();
  proofStageAllowed(record.proof, "reconcile", forensicOnce);
  if (forensicOnce) assert.ok(Number.isFinite(expires) && expires > Date.now() + 30_000,
    "Fresh effective access required before consuming forensic admission");
  const reconciliation = forensicOnce
    ? { ...record.proof.reconciliation, forensicOnce: { state: "UNKNOWN" } }
    : { state: "UNKNOWN" };
  await store.save({ ...record, proof: { ...record.proof, reconciliation } });
}
export async function saveEmptyReconciliation(store, certificate) {
  const record = store.get();
  await store.save({ ...record, proof: { state: "RECONCILED_EMPTY", originalUnknown: record.proof,
    reconciliation: certificate } });
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
export async function reconcileConnection(connection, beforeVerify = () => {}) {
  await connection.wait(frame => frame.type === "conversation.events" && frame.conversationId === 1 &&
    Array.isArray(frame.events) && frame.events.some(event => event.type === "snapshot"));
  await connection.wait(frame => frame.type === "conversation.inbox" && frame.conversationId === 1);
  await connection.close();
  beforeVerify();
  return emptyRootCertificate(connection.frames, connection.witness);
}

async function run() {
const { values } = parseArgs({ options: {
  url: { type: "string" }, session: { type: "string" }, host: { type: "string" },
  cloudflared: { type: "string" }, stage: { type: "string" }, continue: { type: "boolean" },
  "forensic-once": { type: "boolean" }, "recover-seed-once": { type: "boolean" },
  "recover-transport-once": { type: "boolean" },
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
if (!["login", "reauth", "refresh", "seed", "recall", "reconcile", "history"].includes(stage)) throw new Error("Explicit lifecycle stage required");
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
if (!(stage === "seed" && (values["recover-seed-once"] === true || values["recover-transport-once"] === true))) proofStageAllowed(record.proof, stage, values["forensic-once"] === true);
if (stage === "recall" && (record.proof?.state !== "SEEDED" || (record.rotations ?? 0) <= record.proof.rotations)) {
  throw new Error("Completed seed and actual durable refresh required");
}
const previousProof = record.proof;
if (stage === "recall" && (previousProof.session !== values.session || previousProof.origin !== values.url || previousProof.host !== values.host)) throw new Error("Proof binding mismatch");
if (stage === "seed" && values["recover-transport-once"] === true) await beginTransportRecovery(store, credential.expires);
else if (stage === "seed" && values["recover-seed-once"] === true) await beginSeedRecovery(store, credential.expires);
else if (stage === "reconcile") {
  await beginReconciliation(store, values["forensic-once"] === true, credential.expires);
} else if (stage === "history") await beginHistoryInspection(store, credential.expires);
else await store.save({ ...record, proof: { ...previousProof, state: "UNKNOWN", attemptedStage: stage } });
const origin = new URL(values.url);
assert.equal(origin.protocol, "https:");
assert.equal(origin.pathname, "/");
phase("CF_CACHE");
const accessJwt = execFileSync(values.cloudflared, ["access", "token", "--app", origin.origin],
  { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const bearer = { token: credential.access, expires: credential.expires };
if (stage !== "reconcile" && stage !== "history") {
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
  lastSocketTrace = undefined;
  const ws = new WebSocket(url, {
    headers: { Cookie: "CF_Authorization=" + accessJwt,
      "Pi-Proof-Access": bearer.token, "Pi-Proof-Expires": String(bearer.expires) },
    followRedirects: false, handshakeTimeout: 15_000,
  });
  sockets.add(ws);
  ws.once("close", () => sockets.delete(ws));
  const frames = [];
  const trace = observeOwnerSocket(ws, frames, () => phase("INVALID_WS_FRAME"));
  lastSocketTrace = trace;
  await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", () => reject(new Error("Owner WebSocket rejected"))); });
  phase("AUTOMATIC_ROOT_WAIT");
  const wait = predicate => waitOwnerFrame(frames, ws, predicate, abort.signal);
  await wait(frame => frame.type === "session.snapshot");
  return {
    witness: trace.witness, frames, wait,
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
      const messages = turnMessages(frames.slice(start), conversationId);
      lastProviderFailure = providerFailureReceipt(messages);
      if (lastProviderFailure) throw new Error("Proof provider failure; no resend");
      return messages;
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
if (stage === "history") {
  phase("HISTORY_SNAPSHOT");
  const observation = await inspectHistoryConnection(await connect());
  phase("HISTORY_COMMIT");
  await saveHistoryObservation(store, observation);
  console.log(JSON.stringify({ scope: "HISTORY_DIAGNOSIS_ONLY", proofState: "UNKNOWN", ...observation,
    noPromptOrSeedRecovery: true, noAutomaticResend: true }));
  if (!observation.inspected) process.exitCode = 1;
  return;
}
if (stage === "reconcile") {
  phase("RECONCILE_SNAPSHOT");
  const connection = await connect();
  const certificate = await reconcileConnection(connection, () => phase("CERTIFICATE_VERIFY"));
  phase("RECONCILE_COMMIT");
  await saveEmptyReconciliation(store, certificate);
  console.log(JSON.stringify({ scope: "CURRENT_SESSION_RECONCILED_EMPTY", posts: certificate.posts,
    rootId: certificate.rootId, originalEffectBoundary: "UNKNOWN", noClientCommands: true,
    nextSeed: "SEPARATE_GO_AFTER_EXIT_IDLE_NEW_BOOT" }));
  return;
}
if (stage === "seed") {
const first = await connect();
const transportRecovery = values["recover-transport-once"] === true;
const recovery = values["recover-seed-once"] === true;
const offset = transportRecovery ? 2 : recovery ? 1 : 0;
proofWitness(first.witness, offset, "false");
if (previousProof?.state === "RECONCILED_EMPTY") assert.notEqual(first.witness.boot, previousProof.reconciliation.boot, "Idle/recreated instance required after reconciliation");
let conversationId;
if (transportRecovery) {
  phase("TRANSPORT_CORRECTION_EXISTING_CONVERSATION");
  conversationId = await prepareTransportConversation(first, previousProof.seedRecovery.conversationId);
} else if (recovery) {
  phase("RECOVERY_EXISTING_CONVERSATION");
  conversationId = await prepareRecoveryConversation(first);
  // Pin the actual current unique ID before any fresh prompt. Old history did not retain it.
  await store.save({ ...store.get(), proof: { ...store.get().proof,
    seedRecovery: { ...store.get().proof.seedRecovery, conversationId } } });
} else {
  phase("SEED_CREATE");
  conversationId = (await first.command({ type: "conversation.create", requestId: randomUUID() })).conversationId;
}
const marker = randomBytes(24).toString("hex");
phase("SEED_SUBMIT");
const messages = await first.turn(conversationId,
  "Remember marker " + marker + ". Call ask_jev exactly once with state describing this finite memory experiment and one likelihood question. Use its actual assessment, then repeat the marker and assessment.");
const results = messages.filter(message => message.role === "toolResult" && message.toolName === "ask_jev");
assert.equal(results.length, 1); assert.equal(results[0].isError, false);
const calls = messages.filter(message => message.role === "assistant").flatMap(message => message.content).filter(part => part.type === "toolCall");
assert.equal(calls.length, 1); assert.equal(calls[0].name, "ask_jev"); assert.equal(calls[0].id, results[0].toolCallId);
const assessment = JSON.parse(results[0].content.filter(part => part.type === "text").map(part => part.text).join(""));
assert.equal(assessment.type, "noul"); assert.ok(Number.isFinite(assessment.noul));
const answer = assistant(messages);
assert.ok(answer.includes(marker) && answer.includes(String(assessment.noul)));
const completions = completionReceipt(messages, ["toolUse", "stop"]);
await first.close();
phase("SEED_COMMIT");
await store.save({ ...store.get(), proof: { ...store.get().proof, state: "SEEDED", modelPostOffset: offset, session: values.session,
  origin: values.url, host: values.host, conversationId: conversationId, marker, assessment, boot: first.witness.boot,
  rotations: record.rotations ?? 0, completions, seededAt: Date.now() } });
console.log(JSON.stringify({ scope: "ACTUAL_WORKER_SEED_ONLY", status: "SEEDED", conversationId: conversationId,
  completions, successfulJevToolResults: 1, memoryRecall: "NOT_RUN" }));
} else {
assert.equal(previousProof.session, values.session);
const reopened = await connect();
const offset = previousProof.modelPostOffset ?? 0;
assert.ok(offset === 0 || offset === 1 || offset === 2);
proofWitness(reopened.witness, 2 + offset, "false");
assert.ok(reopened.witness.boot !== previousProof.boot && reopened.witness.prior === "false",
  "NOT_PROVEN: real DO recreation not observed; no recall prompt sent");
assert.equal(reopened.witness.posts, 2 + offset);
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
proofWitness(receipt.witness, 3 + offset);
await receipt.close();
await store.save({ ...store.get(), proof: { ...previousProof, state: "COMPLETE", completions } });
console.log(JSON.stringify({ scope: "ACTUAL_WORKER_CREDENTIAL_LIFECYCLE_PROOF", session: values.session,
  conversationId: previousProof.conversationId, completions, responsesPostAttempts: 3 + offset, historicalFailedAdmissions: offset,
  overallUserInputs: 2 + offset,
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
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run().catch(error => {
  const status = lastSocketTrace?.httpStatus ?? lastHttpStatus;
  console.error(JSON.stringify({ scope: "OWNER_LIFECYCLE", status: "STOPPED_NOT_PROVEN", phase: lastPhase,
    httpStatus: Number.isInteger(status) && status >= 100 && status <= 599 ? status : null,
    errorCode: lastSocketTrace?.errorCode ?? safeOwnerErrorCode(error),
    upgradeSeen101: lastSocketTrace?.upgradeSeen101 === true,
    witness: safeWitnessStatus(lastSocketTrace?.witness), providerFailure: lastProviderFailure ?? null, noAutomaticResend: true }));
  process.exitCode = 1;
});
