// One question, independently evaluated candidates, one existing Jev transport call.
import {JevError, JevContractError} from "./client.mjs";
import {JevTransportError} from "./core.mjs";

const own = (value, key) => Object.hasOwn(value, key);
const plain = value => value !== null && typeof value === "object"
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const invalid = () => { throw new JevError("input_invalid", "Invalid multi-select input"); };
const contract = () => { throw new JevContractError("Invalid multi-select response"); };

// Only JSON data properties are accepted; accessors and toJSON conversions cannot
// silently change the state or candidate descriptions sent to the provider.
function entries(value) {
  if (!plain(value)) invalid();
  return Reflect.ownKeys(value).map(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || !descriptor.enumerable || !own(descriptor, "value")) invalid();
    return [key, descriptor.value];
  });
}
function fields(value, expected) {
  const result = Object.fromEntries(entries(value));
  if (Object.keys(result).length !== expected.length || expected.some(key => !own(result, key))) invalid();
  return result;
}
function jsonData(value, ancestors = new Set(), depth = 0) {
  if (depth > 64) invalid();
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object" || ancestors.has(value)) invalid();
  ancestors.add(value);
  let result;
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1) invalid();
    result = Array.from({length: value.length}, (_, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !own(descriptor, "value")) invalid();
      return jsonData(descriptor.value, ancestors, depth + 1);
    });
  } else {
    result = Object.fromEntries(entries(value).map(([key, item]) => [key, jsonData(item, ancestors, depth + 1)]));
  }
  ancestors.delete(value);
  return result;
}
function plan(request, thresholds) {
  const input = fields(request, ["state", "question", "choices"]);
  const policy = fields(thresholds, ["reject", "accept"]);
  if (![policy.reject, policy.accept].every(p => typeof p === "number" && Number.isFinite(p))
      || policy.reject < 0 || policy.accept > 1 || policy.reject >= policy.accept) invalid();
  if (typeof input.question !== "string" || !input.question.trim()
      || input.state === null || !["string", "object"].includes(typeof input.state)) invalid();
  const choices = entries(input.choices).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  if (!choices.length || choices.some(([id, description]) => !id || typeof description !== "string" || !description.trim())) invalid();
  const questions = Object.fromEntries(choices.map(([, candidate], index) => [
    "q" + index,
    {type: "noul", instructions: {
      question: input.question,
      candidate,
      evaluation: "Does candidate apply as an answer to question for the provided state? Evaluate this candidate independently; multiple candidates may apply.",
    }},
  ]));
  return {ids: choices.map(([id]) => id), policy,
    body: {model: "jev-latest", state: jsonData(input.state), questions}};
}
function normalize(data, ids, policy) {
  if (!plain(data) || !own(data, "model") || typeof data.model !== "string" || !data.model.trim()
      || !own(data, "answers") || !plain(data.answers)) contract();
  const keys = Object.keys(data.answers);
  if (keys.length !== ids.length || ids.some((_, index) => !own(data.answers, "q" + index))) contract();
  const scores = Object.fromEntries(ids.map((id, index) => {
    const answer = data.answers["q" + index];
    if (!plain(answer) || Object.keys(answer).length !== 2 || !own(answer, "type") || answer.type !== "noul"
        || !own(answer, "noul") || typeof answer.noul !== "number" || !Number.isFinite(answer.noul)
        || answer.noul < 0 || answer.noul > 1) contract();
    return [id, answer.noul];
  }));
  const selected = [], notSelected = [], undecided = [];
  for (const id of ids) {
    if (scores[id] >= policy.accept) selected.push(id);
    else if (scores[id] <= policy.reject) notSelected.push(id);
    else undecided.push(id);
  }
  return {observation: "OBSERVED", status: undecided.length ? "REVIEW" : "COMPLETE",
    model: data.model, scores, selected, notSelected, undecided};
}

export async function judgeMultiSelect({request, thresholds, provider, signal} = {}) {
  const {ids, policy, body} = plan(request, thresholds);
  if (!provider?.available) throw new JevError("auth_missing", "Jev provider unavailable");
  if (typeof provider.post !== "function") invalid();
  let data;
  try { data = await provider.post(body, {signal, deadlineMs: 10_000}); }
  catch (error) {
    if (error instanceof JevTransportError) throw error;
    throw new JevError("provider_unreachable", "Failed to reach provider");
  }
  return normalize(data, ids, policy);
}
