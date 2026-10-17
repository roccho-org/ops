import assert from "node:assert/strict";
import test from "node:test";
import { askJevQuestions, askJevChoice, askJevScore, bindJev, JevError, JevContractError } from "../src/client.mjs";
import { judgeNamedChoices } from "../src/batch.mjs";
import { bindJevReview } from "../../jev-review/jev.mjs";

const questions = () => ({
  fits: { type: "noul", instructions: "Does it fit?" },
  pick: { type: "choice", instructions: "Select", criteria: { A: "first", B: "second" } },
  quality: { type: "score", instructions: "Rate", criteria: ["low", "high"] },
});
const response = () => ({ model: "resolved-model", answers: {
  fits: { type: "noul", noul: 0.75 },
  pick: { type: "choice", choice: "A", confidence: 0.8, probabilities: { A: 0.8, B: 0.2 } },
  quality: { type: "score", score: 0.6, legend: { 0: "low", 1: "high" },
    confidence: 0.9, probabilities: { 0: 0.4, 1: 0.6 } },
} });
const providerFor = data => ({ available: true, post: async () => data });

test("mixed named questions use one POST and keep answers by name, not order", async () => {
  let calls = 0;
  const raw = response();
  raw.answers = Object.fromEntries(Object.entries(raw.answers).reverse());
  raw.privateExtra = "synthetic-body-canary";
  raw.usage = { input_tokens: 3, output_tokens: 2, total_tokens: 5, unknown: 9, secret: "canary" };
  const provider = bindJev({ apiKey: "synthetic-key-canary", fetch: async (url, init) => {
    calls++;
    assert.equal(url, "https://api.typesafe.ai/v1/systemone");
    const wire = JSON.parse(init.body);
    assert.equal(wire.model, "jev-latest");
    assert.deepEqual(wire.state, { purpose: "fixture" });
    assert.deepEqual(wire.questions, questions());
    return { ok: true, json: async () => raw };
  } });
  const result = await askJevQuestions({ state: { purpose: "fixture" }, questions: questions(), provider });
  assert.equal(calls, 1);
  assert.deepEqual(result, { ...response(), usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } });
  assert.ok(!JSON.stringify(result).includes("canary"));
});

test("missing, extra, mistyped and invalid typed answers are refused", async () => {
  const mutations = [
    x => { delete x.answers.fits; },
    x => { x.answers.extra = x.answers.fits; },
    x => { [x.answers.fits, x.answers.pick] = [x.answers.pick, x.answers.fits]; },
    x => { x.answers.fits.noul = 1.01; },
    x => { x.answers.fits.noul = NaN; },
    x => { x.answers.pick.choice = "unoffered"; },
    x => { x.answers.pick.probabilities.A = Infinity; },
    x => { delete x.answers.pick.probabilities.B; },
    x => { x.answers.quality.score = 2; },
    x => { x.answers.quality.legend[0] = "changed"; },
    x => { x.answers.quality.confidence = -1; },
    x => { x.model = null; },
  ];
  for (const mutate of mutations) {
    const data = response(); mutate(data);
    await assert.rejects(() => askJevQuestions({ state: "fixture", questions: questions(), provider: providerFor(data) }), JevContractError);
  }
});

test("invalid named requests refuse before the provider is called", async () => {
  let calls = 0;
  const provider = { available: true, post: async () => { calls++; throw Error("must not call"); } };
  const valid = { state: "fixture", questions: questions(), provider };
  const invalid = [
    { state: "" }, { state: [] }, { questions: {} }, { questions: [] },
    { questions: { "": { type: "noul", instructions: "Q?" } } },
    { questions: { q: { type: "unknown", instructions: "Q?" } } },
    { questions: { q: { type: "noul", instructions: " " } } },
    { questions: { q: { type: "noul", instructions: "Q?", criteria: {} } } },
    { questions: { q: { type: "noul", instructions: "Q?", unexpected: true } } },
    { questions: { q: { type: "choice", instructions: "Q?", criteria: { A: "one" } } } },
    { questions: { q: { type: "score", instructions: "Q?", criteria: ["one", 2] } } },
    { deadlineMs: 0 }, { deadlineMs: NaN }, { deadlineMs: 1.5 }, { deadlineMs: 2_147_483_648 },
  ];
  for (const change of invalid) {
    await assert.rejects(() => askJevQuestions({ ...valid, ...change }), e => e instanceof JevError && e.code === "input_invalid");
  }
  const cyclic = {}; cyclic.self = cyclic;
  await assert.rejects(() => askJevQuestions({ ...valid, state: cyclic }), JevError);
  await assert.rejects(() => askJevQuestions({ ...valid, provider: undefined }), e => e.code === "auth_missing");
  assert.equal(calls, 0);
});

test("wire and validation keep the same question snapshot during pending calls", async () => {
  let finish, wire;
  const input = { state: { purpose: "original" }, questions: questions() };
  const provider = { available: true, post: body => {
    wire = structuredClone(body);
    // Even an injected provider cannot rewrite the decoder's expected criteria.
    body.questions.pick.criteria = { X: "wrong", Y: "wrong" };
    return new Promise(resolve => { finish = resolve; });
  } };
  const pending = askJevQuestions({ ...input, provider });
  input.state.purpose = "changed";
  input.questions.pick.criteria.A = "changed";
  delete input.questions.quality;
  finish(response());
  assert.deepEqual(await pending, response());
  assert.equal(wire.state.purpose, "original");
  assert.deepEqual(wire.questions, questions());
});

test("single-question choice and score validate their sent criteria snapshot", async () => {
  for (const kind of ["choice", "score"]) {
    let finish;
    const criteria = kind === "choice" ? { A: "first", B: "second" } : ["low", "high"];
    const provider = { available: true, post: () => new Promise(resolve => { finish = resolve; }) };
    const pending = (kind === "choice" ? askJevChoice : askJevScore)({ text: "fixture", criteria, instructions: "Q?", provider });
    if (kind === "choice") { delete criteria.A; criteria.X = "changed"; }
    else criteria[0] = "changed";
    finish({ model: "resolved", answers: { live: response().answers[kind === "choice" ? "pick" : "quality"] } });
    const result = await pending;
    assert.equal(result[kind][kind], kind === "choice" ? "A" : 0.6);
  }
});

test("CLI, Worker and Review keep their distinct acceptance and model contracts", async () => {
  const weak = { type: "choice", choice: "A", confidence: 0.4, probabilities: { A: 2 } };
  await assert.rejects(() => askJevChoice({ text: "fixture", criteria: { A: "first", B: "second" }, instructions: "Q?",
    provider: providerFor({ model: "any-model", answers: { live: weak } }) }), JevContractError);
  assert.deepEqual(await judgeNamedChoices({ request: { state: {}, questions: { q: { instruction: "Q?", options: { A: "first", B: "second" } } } },
    provider: providerFor({ model: "any-model", answers: { q: weak } }) }),
  { answers: { q: { choice: "A", confidence: 0.4, probabilities: { A: 2 } } } });
  let sentModel;
  const review = bindJevReview({ key: "synthetic-key", fetchImpl: async (_url, init) => {
    sentModel = JSON.parse(init.body).model;
    return { ok: true, json: async () => ({ model: "jev-latest", answers: { q: { type: "noul", noul: 0.5 } } }) };
  } });
  await assert.rejects(() => review({}, { q: { type: "noul", instructions: "Q?" } }, { timeoutMs: 1000 }), /JEV_MODEL_MISMATCH/);
  assert.equal(sentModel, "jev-1.13.0");
});

test("named calls preserve cancellation, deadlines and no retry without raw exceptions", async () => {
  for (const mode of ["cancel", "timeout", "http", "network"]) {
    let calls = 0;
    const controller = new AbortController();
    const provider = bindJev({ apiKey: "synthetic-key-canary", fetch: async () => {
      calls++;
      if (mode === "http") return { ok: false, status: 503 };
      if (mode === "network") throw Error("synthetic-key-canary");
      return new Promise(() => {});
    } });
    const pending = askJevQuestions({ state: "fixture", questions: questions(), provider,
      signal: controller.signal, deadlineMs: mode === "timeout" ? 5 : 1000 });
    if (mode === "cancel") controller.abort();
    const expected = { cancel: "cancelled", timeout: "provider_timeout", http: "provider_http_error", network: "provider_unavailable" }[mode];
    await assert.rejects(() => pending, e => e.code === expected && !e.message.includes("canary"));
    assert.equal(calls, 1);
  }
});
