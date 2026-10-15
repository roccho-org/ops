import {judgeMultiSelect, prepareMultiSelect} from "./multi-select.mjs";
import {JevError, JevContractError} from "./client.mjs";

const plans = new WeakSet(); // Identity brand only; no stored definitions or results.
const own = (value, key) => Object.hasOwn(value, key);
const invalid = () => { throw new JevError("input_invalid", "Invalid case input"); };
const text = value => typeof value === "string" && value.trim().length > 0;
const fields = (value, keys) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).length !== keys.length || keys.some(key => !own(value, key))) invalid();
  return value;
};
const freeze = value => {
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
};
const encoder = new TextEncoder();
// Preserve a leading U+FEFF rather than silently consuming it as a BOM.
const decoder = new TextDecoder("utf-8", {fatal: true, ignoreBOM: true});
const hash = async bytes => Array.from(new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes)),
  value => value.toString(16).padStart(2, "0")).join("");

function captureBlock(input) {
  const block = fields(input, ["ref", "revision", "content", "evaluationSpan"]);
  const span = fields(block.evaluationSpan, ["startByte", "endByte"]);
  if (!text(block.ref) || !text(block.revision) || typeof block.content !== "string") invalid();
  const raw = encoder.encode(block.content);
  if (decoder.decode(raw) !== block.content) invalid(); // Refuse lone-surrogate replacement.
  const {startByte, endByte} = span;
  if (!Number.isSafeInteger(startByte) || !Number.isSafeInteger(endByte)
      || startByte < 0 || endByte <= startByte || endByte > raw.length) invalid();
  const selected = raw.slice(startByte, endByte);
  let selectedText;
  try { selectedText = decoder.decode(selected); }
  catch { invalid(); }
  if (!selectedText.trim() || encoder.encode(selectedText).length !== selected.length) invalid();
  return {raw, selected, metadata: {ref: block.ref, revision: block.revision,
    evaluationSpan: {startByte, endByte}, text: selectedText}};
}

export async function prepareCases(jsonlText) {
  if (!text(jsonlText)) invalid();
  const caseIds = new Set();
  const captured = [];
  // Complete parsing, validation, and snapshots precede the first hash await.
  for (const line of jsonlText.split("\n").filter(line => line.trim())) {
    let input;
    try { input = JSON.parse(line); } catch { invalid(); }
    fields(input, ["id", "collections", "question", "choices", "thresholds"]);
    if (!text(input.id) || caseIds.has(input.id) || !Array.isArray(input.collections) || input.collections.length < 2) invalid();
    caseIds.add(input.id);
    const collectionIds = new Set();
    for (const entry of input.collections) {
      const collection = fields(entry, ["id", "blocks"]);
      if (!text(collection.id) || collectionIds.has(collection.id)
          || !Array.isArray(collection.blocks) || !collection.blocks.length) invalid();
      collectionIds.add(collection.id);
      const blocks = collection.blocks.map(captureBlock);
      const state = blocks.map(block => block.metadata.text).join("\n\n");
      const api = prepareMultiSelect({state, question: input.question, choices: input.choices}, input.thresholds);
      captured.push({caseId: input.id, collectionId: collection.id, state,
        question: input.question,
        choices: Object.fromEntries(api.ids.map(id => [id, input.choices[id]])),
        thresholds: api.policy, blocks});
    }
  }
  if (!captured.length) invalid();
  await Promise.all(captured.flatMap(slot => slot.blocks.map(async block => {
    const [contentSha256, selectedSha256] = await Promise.all([hash(block.raw), hash(block.selected)]);
    Object.assign(block.metadata, {contentSha256, selectedSha256});
  })));
  const preview = captured.map(({blocks, ...slot}) => ({...slot, blocks: blocks.map(block => block.metadata)}));
  const prepared = freeze({plannedCalls: preview.length, preview});
  plans.add(prepared);
  return prepared;
}

const knownErrors = new Set(["auth_missing", "input_invalid", "provider_http_error", "provider_invalid_response"]);
const knownUnknowns = new Set(["provider_timeout", "cancelled", "provider_unavailable", "provider_unreachable"]);
function failure(error) {
  if (error instanceof JevContractError) return {execution: "ERROR", cause: "provider_contract_error"};
  if (knownErrors.has(error?.code)) return {execution: "ERROR", cause: error.code};
  if (knownUnknowns.has(error?.code)) return {execution: "UNKNOWN", cause: error.code};
  return {execution: "UNKNOWN", cause: "execution_unknown"};
}

export async function runCases(prepared, {provider, maxCalls, signal} = {}) {
  if (!plans.has(prepared) || !Number.isSafeInteger(maxCalls) || maxCalls < 0
      || (signal !== undefined && (typeof signal?.addEventListener !== "function"
        || typeof signal?.removeEventListener !== "function"))) invalid();
  const slots = prepared.preview.map(slot => ({caseId: slot.caseId, collectionId: slot.collectionId,
    execution: "NOT_RUN", answer: null, cause: "not_asked"}));
  let admittedCalls = 0, model, stop = null;
  for (let index = 0; index < prepared.preview.length; index++) {
    const input = prepared.preview[index], result = slots[index];
    if (signal?.aborted) { stop = {code: "cancelled", caseId: input.caseId, collectionId: input.collectionId}; break; }
    if (admittedCalls >= maxCalls) { stop = {code: "budget", caseId: input.caseId, collectionId: input.collectionId}; break; }
    admittedCalls++;
    try {
      const answer = await judgeMultiSelect({request: {state: input.state, question: input.question, choices: input.choices},
        thresholds: input.thresholds, provider, signal});
      Object.assign(result, {execution: "OBSERVED", answer, cause: null});
      if (model !== undefined && model !== answer.model) {
        stop = {code: "model_changed", caseId: input.caseId, collectionId: input.collectionId};
        break;
      }
      model = answer.model;
    } catch (error) {
      Object.assign(result, failure(error));
      stop = {code: result.cause, caseId: input.caseId, collectionId: input.collectionId};
      break;
    }
  }
  if (stop) for (const slot of slots) if (slot.execution === "NOT_RUN")
    slot.cause = stop.code === "budget" ? "budget" : stop.code === "cancelled" && admittedCalls === 0 ? "cancelled" : "stopped";
  const status = stop || slots.some(slot => slot.execution !== "OBSERVED") ? "INCOMPLETE"
    : slots.some(slot => slot.answer.status === "REVIEW") ? "REVIEW" : "COMPLETE";
  return {status, plannedCalls: prepared.plannedCalls, admittedCalls, slots, stop};
}
