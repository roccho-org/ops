import assert from "node:assert/strict";
import {test} from "node:test";
import {prepareCases, runCases} from "jev/cases";
import {prepareMultiSelect} from "jev/multi-select";
import {bindJev} from "../src/client.mjs";
import {JevTransportError} from "../src/core.mjs";

const encoder = new TextEncoder();
const block = content => ({ref: "synthetic.txt", revision: "fixture-1", content,
  evaluationSpan: {startByte: 0, endByte: encoder.encode(content).length}});
const makeCase = (id = "first", states = ["alpha", "beta", "gamma"]) => ({id,
  collections: states.map((state, i) => ({id: "collection-" + i, blocks: [block(state)]})),
  question: "Which conditional output behaviors are stated?",
  choices: {alpha_text: "Mode alpha emits text.", beta_numbers: "Mode beta emits numbers.",
    alpha_numbers: "Mode alpha emits numbers.", beta_text: "Mode beta emits text."},
  thresholds: {reject: 0.2, accept: 0.8}});
const jsonl = (...cases) => cases.map(value => JSON.stringify(value)).join("\n");
const data = (wire, model = "synthetic-model", p = [0.95, 0.1, 0.9, 0.05]) => ({model,
  answers: Object.fromEntries(Object.keys(wire.questions).map((id, i) => [id, {type: "noul", noul: p[i]}]))});
const bound = inspect => bindJev({apiKey: "synthetic-key", fetch: async (_, init) => {
  const wire = JSON.parse(init.body);
  return {ok: true, json: async () => inspect ? inspect(wire) : data(wire)};
}});
const bad = error => error.code === "input_invalid";

test("all JSONL cases and three collections loop independently with one POST per slot", async () => {
  const plan = await prepareCases("\n" + jsonl(makeCase(), makeCase("second", ["delta", "epsilon", "zeta"])) + "\n\n");
  const seen = [];
  const report = await runCases(plan, {maxCalls: 6, provider: bound(wire => {seen.push(wire.state); return data(wire);})});
  assert.deepEqual(seen, ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"]);
  assert.equal(report.status, "COMPLETE");
  assert.equal(report.plannedCalls, 6);
  assert.equal(report.admittedCalls, 6);
  assert.equal(report.slots.length, 6);
  assert.ok(report.slots.every(slot => slot.execution === "OBSERVED" && slot.answer.selected.length === 2));
  assert.deepEqual(report.slots.map(slot => [slot.caseId, slot.collectionId]),
    plan.preview.map(slot => [slot.caseId, slot.collectionId]));
});
test("UTF8 spans, multiple raw blocks, BOM and two LF match the exact sent preview", async () => {
  const input = makeCase();
  input.collections[0].blocks = [
    {ref: "unicode.txt", revision: "fixture-2", content: "xα😀y",
      evaluationSpan: {startByte: 1, endByte: 7}},
    block("\uFEFFbeta"),
  ];
  const plan = await prepareCases(jsonl(input));
  assert.equal(plan.preview[0].state, "α😀\n\n\uFEFFbeta");
  assert.deepEqual(plan.preview[0].blocks[0].evaluationSpan, {startByte: 1, endByte: 7});
  assert.equal(plan.preview[0].blocks[1].text.codePointAt(0), 0xfeff);
  const expectedHash = async text => Buffer.from(await crypto.subtle.digest("SHA-256", encoder.encode(text))).toString("hex");
  assert.equal(plan.preview[0].blocks[0].contentSha256, await expectedHash("xα😀y"));
  assert.equal(plan.preview[0].blocks[0].selectedSha256, await expectedHash("α😀"));
  const seen = [];
  await runCases(plan, {maxCalls: 3, provider: bound(wire => {seen.push(wire.state); return data(wire);})});
  assert.deepEqual(seen, plan.preview.map(slot => slot.state));
});
test("all invalid rows and duplicate IDs fail before any hash await or provider use", async () => {
  const base = makeCase();
  const variants = [
    "", "not-json", jsonl(base, base), jsonl({...base, extra: true}),
    jsonl({...base, id: ""}), jsonl({...base, collections: []}),
    jsonl({...base, collections: [base.collections[0]]}),
    jsonl({...base, collections: [base.collections[0], base.collections[0]]}),
    jsonl({...base, choices: {}}), jsonl({...base, question: ""}),
    jsonl({...base, thresholds: {reject: 0.8, accept: 0.2}}),
  ];
  const mutations = [
    c => {c.collections[0].blocks = [];},
    c => {c.collections[0].blocks[0].evaluationSpan.startByte = -1;},
    c => {c.collections[0].blocks[0].evaluationSpan.endByte = 999;},
    c => {c.collections[0].blocks[0].evaluationSpan.endByte = 0;},
    c => {c.collections[0].blocks[0].evaluationSpan.startByte = 0.5;},
    c => {c.collections[0].blocks[0] = {...block("α"), evaluationSpan: {startByte: 1, endByte: 2}};},
    c => {c.collections[0].blocks[0] = block("\ud800");},
    c => {c.collections[0].blocks[0].ref = "";},
    c => {c.collections[0].blocks[0].extra = true;},
    c => {c.collections[0].blocks[0].evaluationSpan.extra = true;},
  ];
  for (const mutate of mutations) {const input = makeCase(); mutate(input); variants.push(jsonl(input));}
  for (const value of variants) await assert.rejects(() => prepareCases(value), bad);
  await assert.rejects(() => prepareCases(jsonl(base) + "\nnot-json"), bad);
});
test("captured inputs precede the first hash await; plans are frozen and identity branded", async t => {
  const originalParse = JSON.parse;
  const parsed = [];
  t.mock.method(JSON, "parse", (...args) => {const value = originalParse(...args); parsed.push(value); return value;});
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  let release;
  const gate = new Promise(resolve => {release = resolve;});
  t.mock.method(crypto.subtle, "digest", async (...args) => {await gate; return digest(...args);});
  const pending = prepareCases(jsonl(makeCase()));
  parsed[0].question = "mutated";
  parsed[0].choices.alpha_text = "mutated";
  parsed[0].collections[0].blocks[0].content = "mutated";
  parsed[0].collections[0].blocks[0].evaluationSpan.endByte = 1;
  release();
  const prepared = await pending;
  t.mock.restoreAll();
  assert.notEqual(prepared.preview[0].question, "mutated");
  assert.notEqual(prepared.preview[0].choices.alpha_text, "mutated");
  assert.equal(prepared.preview[0].state, "alpha");
  assert.equal(prepared.preview[0].blocks[0].text, "alpha");
  assert.throws(() => {prepared.preview[0].state = "mutated";}, TypeError);
  await assert.rejects(() => runCases(JSON.parse(JSON.stringify(prepared)), {maxCalls: 0}), bad);
  const api = prepareMultiSelect({state: "text", question: "Does this apply?", choices: {a: "condition"}}, {reject: 0.2, accept: 0.8});
  assert.ok(Object.isFrozen(api.body.state) || typeof api.body.state === "string");
  assert.ok(Object.isFrozen(api.body.questions));
});
test("zero and partial explicit call budgets preserve every unrun slot", async () => {
  const prepared = await prepareCases(jsonl(makeCase()));
  const zero = await runCases(prepared, {maxCalls: 0});
  assert.equal(zero.admittedCalls, 0);
  assert.equal(zero.status, "INCOMPLETE");
  assert.ok(zero.slots.every(slot => slot.execution === "NOT_RUN" && slot.cause === "budget" && slot.answer === null));
  let calls = 0;
  const partial = await runCases(prepared, {maxCalls: 1, provider: bound(wire => {calls++; return data(wire);})});
  assert.equal(calls, 1);
  assert.deepEqual(partial.slots.map(slot => slot.execution), ["OBSERVED", "NOT_RUN", "NOT_RUN"]);
  assert.equal(partial.slots[1].cause, "budget");
  for (const maxCalls of [undefined, -1, 0.5, Infinity, NaN, "1", Number.MAX_SAFE_INTEGER + 1])
    await assert.rejects(() => runCases(prepared, {maxCalls}), bad);
});
test("known errors and unknown effects stop without retries and retain remaining slots", async () => {
  const plan = await prepareCases(jsonl(makeCase()));
  const variants = [
    ["ERROR", "provider_http_error", bindJev({apiKey: "synthetic-key", fetch: async () => ({ok: false, status: 503})})],
    ["ERROR", "provider_invalid_response", bindJev({apiKey: "synthetic-key", fetch: async () => ({ok: true, json: async () => {throw Error("private-detail");}})})],
    ["ERROR", "provider_contract_error", bound(wire => {const d = data(wire); delete d.answers.q0; return d;})],
    ["ERROR", "auth_missing", {available: false}],
    ["UNKNOWN", "provider_unavailable", bindJev({apiKey: "synthetic-key", fetch: async () => {throw Error("private-detail");}})],
    ["UNKNOWN", "execution_unknown", {available: true, post: async () => {throw new JevTransportError("unrecognized-private-detail");}}],
  ];
  for (const [execution, cause, provider] of variants) {
    const report = await runCases(plan, {maxCalls: 3, provider});
    assert.equal(report.status, "INCOMPLETE");
    assert.equal(report.admittedCalls, 1);
    assert.equal(report.slots[0].execution, execution);
    assert.equal(report.slots[0].cause, cause);
    assert.equal(report.slots[0].answer, null);
    assert.ok(report.slots.slice(1).every(slot => slot.execution === "NOT_RUN" && slot.cause === "stopped"));
    assert.ok(!JSON.stringify(report).includes("private-detail"));
  }
});
test("timeout and cancellation preserve UNKNOWN and NOT_RUN separately", async t => {
  const plan = await prepareCases(jsonl(makeCase()));
  t.mock.timers.enable({apis: ["setTimeout"]});
  const controller = new AbortController();
  for (const cancel of [false, true]) {
    let calls = 0;
    const pending = runCases(plan, {maxCalls: 3, signal: controller.signal,
      provider: bindJev({apiKey: "synthetic-key", fetch: () => {calls++; return new Promise(() => {});}})});
    await Promise.resolve(); await Promise.resolve();
    if (cancel) controller.abort(); else t.mock.timers.tick(10_000);
    const report = await pending;
    assert.equal(calls, 1);
    assert.equal(report.slots[0].execution, "UNKNOWN");
    assert.equal(report.slots[0].cause, cancel ? "cancelled" : "provider_timeout");
    assert.ok(report.slots.slice(1).every(slot => slot.execution === "NOT_RUN"));
  }
  const pre = await runCases(plan, {maxCalls: 3, signal: controller.signal});
  assert.equal(pre.admittedCalls, 0);
  assert.ok(pre.slots.every(slot => slot.execution === "NOT_RUN" && slot.cause === "cancelled"));
});
test("model drift retains the observed answer and stops remaining calls", async () => {
  const plan = await prepareCases(jsonl(makeCase(), makeCase("second")));
  let calls = 0;
  const report = await runCases(plan, {maxCalls: 6, provider: bound(wire => data(wire, ++calls === 1 ? "synthetic-a" : "synthetic-b"))});
  assert.equal(calls, 2);
  assert.equal(report.status, "INCOMPLETE");
  assert.equal(report.stop.code, "model_changed");
  assert.equal(report.slots[1].execution, "OBSERVED");
  assert.equal(report.slots[1].answer.model, "synthetic-b");
  assert.ok(report.slots.slice(2).every(slot => slot.execution === "NOT_RUN"));
});
test("observed undecided scores keep the outer REVIEW result", async () => {
  const plan = await prepareCases(jsonl(makeCase()));
  const report = await runCases(plan, {maxCalls: 3, provider: bound(wire => data(wire, "synthetic-model", [0.5, 0.5, 0.5, 0.5]))});
  assert.equal(report.status, "REVIEW");
  assert.equal(report.stop, null);
  assert.ok(report.slots.every(slot => slot.execution === "OBSERVED" && slot.answer.status === "REVIEW"));
});
