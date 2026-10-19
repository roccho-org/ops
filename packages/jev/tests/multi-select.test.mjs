import assert from "node:assert/strict";
import {test} from "node:test";
import {judgeMultiSelect} from "jev/multi-select";
import {bindJev, JevError, JevContractError} from "../src/client.mjs";
import {JevTransportError} from "../src/core.mjs";

const thresholds = {reject: 0.2, accept: 0.8};
const request = () => ({state: {text: "A synthetic project builds and runs."},
  question: "Which capabilities are stated?",
  choices: {build: "It builds.", review: "It reviews.", run: "It runs.", ship: "It ships."}});
const response = (values = [0.95, 0.1, 0.9, 0.05]) => ({model: "synthetic-model",
  answers: Object.fromEntries(values.map((noul, i) => ["q" + i, {type: "noul", noul}]))});
const provider = (data, inspect = () => {}) => bindJev({apiKey: "synthetic-key",
  fetch: async (url, init) => { inspect(url, init); return {ok: true, json: async () => data}; }});
const invoke = (data = response(), extra = {}) => judgeMultiSelect({request: request(), thresholds, provider: provider(data), ...extra});

test("one public question selects multiple candidates with exactly one POST", async () => {
  let calls = 0;
  const input = request();
  const result = await judgeMultiSelect({request: input, thresholds, provider: provider(response(), (url, init) => {
    calls++;
    assert.equal(new URL(url).hostname, "api.typesafe.ai");
    assert.equal(init.method, "POST");
    const wire = JSON.parse(init.body);
    assert.equal(wire.model, "jev-latest");
    assert.deepEqual(wire.state, input.state);
    assert.deepEqual(Object.keys(wire.questions), ["q0", "q1", "q2", "q3"]);
    for (const [i, id] of Object.keys(input.choices).sort().entries()) {
      assert.equal(wire.questions["q" + i].type, "noul");
      assert.equal(wire.questions["q" + i].instructions.question, input.question);
      assert.equal(wire.questions["q" + i].instructions.candidate, input.choices[id]);
    }
  })});
  assert.equal(calls, 1);
  assert.deepEqual(result, {observation: "OBSERVED", status: "COMPLETE", model: "synthetic-model",
    scores: {build: 0.95, review: 0.1, run: 0.9, ship: 0.05},
    selected: ["build", "run"], notSelected: ["review", "ship"], undecided: []});
});
test("complete empty selection is distinct from observed undecided scores", async () => {
  const empty = await invoke(response([0, 0.1, 0.2, 0]));
  assert.equal(empty.status, "COMPLETE");
  assert.deepEqual(empty.selected, []);
  assert.deepEqual(empty.notSelected, ["build", "review", "run", "ship"]);
  const review = await invoke(response([0.5, 0.5, 0.5, 0.5]));
  assert.equal(review.observation, "OBSERVED");
  assert.equal(review.status, "REVIEW");
  assert.deepEqual(review.selected, []);
  assert.deepEqual(review.undecided, ["build", "review", "run", "ship"]);
});
test("explicit threshold endpoints are inclusive; all candidates may be selected", async () => {
  const result = await invoke(response([0, 0.2, 0.8, 1]));
  assert.deepEqual(result.notSelected, ["build", "review"]);
  assert.deepEqual(result.selected, ["run", "ship"]);
  assert.deepEqual(result.undecided, []);
  assert.equal((await invoke(response([1, 1, 1, 1]))).selected.length, 4);
  assert.equal((await invoke(response([0, 0, 1, 1]), {thresholds: {reject: 0, accept: 1}})).status, "COMPLETE");
});
test("conditional candidate text and question bytes are preserved; IDs are metadata", async () => {
  const input = {state: "DEV uses MFA; STG uses a role.", question: "  Which conditional requirements hold?\n",
    choices: {opaque_a: " DEV requires MFA.\n", opaque_b: "STG requires a role.", opaque_c: "DEV requires a role.", opaque_d: "STG requires MFA."}};
  await invoke(response(), {request: input, provider: provider(response(), (_, init) => {
    const wire = JSON.parse(init.body);
    assert.equal(wire.questions.q0.instructions.question, input.question);
    for (const [i, id] of Object.keys(input.choices).entries())
      assert.equal(wire.questions["q" + i].instructions.candidate, input.choices[id]);
    assert.ok(!init.body.includes("opaque_"));
  })});
});
test("candidate and answer insertion order do not change decoder mapping or canonical output", async () => {
  const original = await invoke();
  const reversed = request();
  reversed.choices = Object.fromEntries(Object.entries(reversed.choices).reverse());
  const data = response();
  data.answers = Object.fromEntries(Object.entries(data.answers).reverse());
  assert.deepEqual(await invoke(data, {request: reversed}), original);
});
test("opaque prototype, numeric and Unicode IDs round-trip as own properties", async () => {
  const input = {state: [], question: "Does the candidate apply?",
    choices: JSON.parse('{"__proto__":"alpha","constructor":"beta","1":"gamma","λ":"delta"}')};
  const result = await invoke(response([1, 1, 0, 0.5]), {request: input});
  assert.equal(Object.getPrototypeOf(result.scores), Object.prototype);
  assert.ok(Object.hasOwn(result.scores, "__proto__"));
  assert.equal(result.scores.__proto__, 1);
  assert.deepEqual(result.selected, ["1", "__proto__"]);
  assert.deepEqual(result.notSelected, ["constructor"]);
  assert.deepEqual(result.undecided, ["λ"]);
});
test("one candidate and empty text state remain representable without inventing absence", async () => {
  const result = await invoke(response([0]), {request: {state: "", question: "Does this apply?", choices: {only: "A stated condition"}}});
  assert.equal(result.observation, "OBSERVED");
  assert.deepEqual(result.notSelected, ["only"]);
});
test("invalid input and thresholds make no transport call", async () => {
  let calls = 0;
  const p = provider(response(), () => { calls++; });
  const badRequests = [null, {}, {...request(), extra: true}, {...request(), choices: {}},
    {...request(), question: " "}, {...request(), state: null}, {...request(), state: 3},
    {...request(), choices: {a: ""}}, {...request(), choices: {a: {text: "structured is outside this adapter"}}},
    {...request(), state: {value: Infinity}}, {...request(), state: new Date(0)},
    {...request(), state: [undefined]}, {...request(), state: [, 1]},
    {...request(), state: {value: 1n}}, {...request(), state: {value: undefined}},
    {...request(), choices: Object.assign(Object.create({inherited: "hidden"}), {a: "shown"})}];
  const cyclic = {}; cyclic.self = cyclic;
  badRequests.push({...request(), state: cyclic});
  let getterCalls = 0;
  const accessor = {}; Object.defineProperty(accessor, "value", {enumerable: true, get() {getterCalls++; return "x";}});
  badRequests.push({...request(), state: accessor});
  for (const bad of badRequests)
    await assert.rejects(() => judgeMultiSelect({request: bad, thresholds, provider: p}), e => e instanceof JevError && e.code === "input_invalid");
  for (const bad of [undefined, {}, {reject: 0.8, accept: 0.2}, {reject: 0.5, accept: 0.5},
    {reject: -0.1, accept: 0.8}, {reject: 0.2, accept: 1.1}, {reject: NaN, accept: 1},
    {reject: 0, accept: Infinity}, {reject: "0", accept: 1}, {...thresholds, extra: 1}])
    await assert.rejects(() => invoke(response(), {thresholds: bad, provider: p}), e => e.code === "input_invalid");
  assert.equal(calls, 0);
  assert.equal(getterCalls, 0);
});
test("missing, extra and malformed answers fail the whole observation instead of returning []", async () => {
  const mutations = [
    d => {delete d.model;}, d => {d.model = "";}, d => {d.model = 1;},
    d => {delete d.answers.q0;}, d => {d.answers.extra = {type: "noul", noul: 0};},
    d => {d.answers = [];}, d => {d.answers.q0 = null;},
    d => {d.answers.q0.type = "choice";}, d => {d.answers.q0.noul = "0.9";},
    d => {d.answers.q0.noul = NaN;}, d => {d.answers.q0.noul = Infinity;},
    d => {d.answers.q0.noul = -0.1;}, d => {d.answers.q0.noul = 1.1;},
    d => {d.answers.q0.extra = true;},
  ];
  for (const mutate of mutations) {
    const data = response(); mutate(data);
    await assert.rejects(() => invoke(data), e => e instanceof JevContractError);
  }
});
test("auth, HTTP, network and invalid JSON failures never become successful empty sets or retries", async () => {
  await assert.rejects(() => invoke(response(), {provider: {available: false}}), e => e.code === "auth_missing");
  for (const [fetch, code] of [
    [async () => ({ok: false, status: 429}), "provider_http_error"],
    [async () => {throw Error("synthetic-private-detail");}, "provider_unavailable"],
    [async () => ({ok: true, json: async () => {throw Error("synthetic-private-detail");}}), "provider_invalid_response"],
  ]) {
    let calls = 0;
    await assert.rejects(() => invoke(response(), {provider: bindJev({apiKey: "synthetic-key",
      fetch: (...args) => {calls++; return fetch(...args);}})}),
    e => e instanceof JevTransportError && e.code === code && !e.message.includes("detail"));
    assert.equal(calls, 1);
  }
  const original = new JevTransportError("provider_http_error", 503);
  await assert.rejects(() => invoke(response(), {provider: {available: true, post: async () => {throw original;}}}), e => e === original);
});
test("the existing single deadline covers stalled headers or response bodies", async t => {
  t.mock.timers.enable({apis: ["setTimeout"]});
  for (const body of [false, true]) {
    let calls = 0, signal;
    const pending = invoke(response(), {provider: bindJev({apiKey: "synthetic-key", fetch: async (_, init) => {
      calls++; signal = init.signal;
      return body ? {ok: true, json: () => new Promise(() => {})} : new Promise(() => {});
    }})});
    const checked = assert.rejects(() => pending, e => e instanceof JevTransportError && e.code === "provider_timeout");
    await Promise.resolve(); await Promise.resolve();
    t.mock.timers.tick(10_000);
    await checked;
    assert.equal(calls, 1);
    assert.equal(signal.aborted, true);
  }
});
test("caller cancellation retains the existing typed error and adds no retry", async () => {
  const controller = new AbortController();
  let calls = 0;
  const pending = invoke(response(), {signal: controller.signal,
    provider: bindJev({apiKey: "synthetic-key", fetch: () => {calls++; return new Promise(() => {});}})});
  const checked = assert.rejects(() => pending, e => e instanceof JevTransportError && e.code === "cancelled");
  controller.abort(); await checked;
  assert.equal(calls, 1);
  await assert.rejects(() => invoke(response(), {signal: controller.signal,
    provider: bindJev({apiKey: "synthetic-key", fetch: () => {calls++;}})}), e => e.code === "cancelled");
  assert.equal(calls, 1);
});
