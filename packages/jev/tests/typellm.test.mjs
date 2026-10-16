import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const entry = process.env.TYPELLM_PROVIDER_ENTRY ?? new URL("../src/typellm.mjs", import.meta.url);
const { bindTypeLLM, generateTyped, TypedProviderError } = await import(entry);
const request = { context: "fixture", questions: {
  enough: { type: "boolean", instructions: "Are the parts present?" },
  parts: { type: "array", minItems: 0, maxItems: 4, items: { type: "object", properties: {
    label: { type: "string" }, kind: { type: "string", enum: ["component", "group"] },
  } } },
} };
const raw = () => ({ model: "model-canary", result: { enough: false, parts: [{ label: "検証", kind: "group" }] },
  thinking: { enough: "private-thinking-canary" }, usage: { input_tokens: 50, thinking_tokens: 0 }, elapsed: 0.5 });
const response = value => new Response(JSON.stringify(value), { status: 200 });
const invoke = (data = raw(), options = {}) => generateTyped({ request,
  provider: bindTypeLLM({ apiKey: "key-canary", fetch: async () => response(data), ...options }) });
const refuse = (operation, code) => assert.rejects(operation, error => error instanceof TypedProviderError
  && error.code === code && error.message === code && !JSON.stringify(error).includes("canary"));

test("single typed POST, fixed model/endpoint, no redirect/retry, exact normalized answers", async () => {
  let calls = 0;
  const value = await invoke(raw(), { fetch: async (url, init) => {
    calls++;
    assert.equal(url, "https://api.typellm.ai/v1/generate");
    assert.equal(init.headers.authorization, "Bearer key-canary");
    assert.equal(init.redirect, "error");
    const wire = JSON.parse(init.body);
    assert.equal(wire.context, "fixture");
    assert.equal(wire.model, "typellm-latest");
    assert.deepEqual(wire.options, { temperature: 0 });
    assert.equal(wire.questions.parts.thinking, false);
    assert.equal(wire.timeout, 30);
    return response(raw());
  } });
  assert.equal(calls, 1);
  assert.deepEqual(value, { result: raw().result, usage: raw().usage, elapsed: 0.5 });
  assert.ok(!JSON.stringify(value).includes("canary"));
});

test("invalid/unsupported input refuses before transport", async () => {
  let calls = 0;
  const provider = bindTypeLLM({ apiKey: "key-canary", fetch: async () => { calls++; return response(raw()); } });
  const mutations = [
    x => { x.context = ""; }, x => { x.context = "a".repeat(128 * 1024); },
    x => { x.endpoint = "https://other.invalid"; }, x => { x.questions = {}; },
    x => { x.questions.parts.maxItems = 51; }, x => { x.questions.parts.items.type = "array"; },
    x => { x.questions.parts.items.properties.label.maxLength = 10; },
    x => { x.questions.enough.when = { other: true }; },
    x => { x.questions.parts.items.properties.kind.enum = ["group", "group"]; },
    x => { x.questions = Object.fromEntries(Array.from({ length: 65 }, (_, i) => ["q" + i, { type: "boolean" }])); },
    x => { x.questions.constructor = { type: "boolean" }; },
  ];
  for (const change of mutations) { const x = structuredClone(request); change(x);
    await refuse(() => generateTyped({ request: x, provider }), "input_invalid"); }
  await refuse(() => generateTyped({ request, provider: bindTypeLLM() }), "auth_missing");
  assert.equal(calls, 0);
});

test("wrong/missing/extra typed answers never become application data", async () => {
  const mutations = [
    x => { x.result.enough = "false"; }, x => { delete x.result.parts; },
    x => { x.result.extra = "private-canary"; }, x => { x.result.parts[0].extra = true; },
    x => { x.result.parts[0].kind = "operation"; }, x => { x.result.parts[0].label = "x".repeat(2049); },
    x => { x.result.parts = Array(5).fill(x.result.parts[0]); },
    x => { x.status = "needs_input"; }, x => { x.skipped = ["parts"]; },
    x => { x.usage.input_tokens = -1; }, x => { x.elapsed = "0.5"; },
  ];
  for (const change of mutations) { const x = raw(); change(x);
    await refuse(() => invoke(x), "provider_contract_error"); }
});

test("errors discard raw details; HTTP errors do not read bodies; no retries", async () => {
  for (const status of [301, 401, 402, 429, 503, 504]) {
    let calls = 0, reads = 0;
    await assert.rejects(() => invoke(raw(), { fetch: async () => {
      calls++; return { ok: false, status, get body() { reads++; throw Error("private-canary"); } };
    } }), e => e.code === "provider_http_error" && e.upstreamStatus === status && !JSON.stringify(e).includes("canary"));
    assert.equal(calls, 1); assert.equal(reads, 0);
  }
  await refuse(() => invoke(raw(), { fetch: async () => { throw Error("key-canary"); } }), "provider_unavailable");
  for (const body of ["not-json-canary", new Uint8Array([255]), " ".repeat(1024 * 1024 + 1)])
    await refuse(() => invoke(raw(), { fetch: async () => new Response(body) }), "provider_invalid_response");
});

test("deadline covers body reads; cancellation and oversize release the stream", async () => {
  let cancels = 0;
  await refuse(() => invoke(raw(), { deadlineMs: 10, fetch: async () => ({ ok: true,
    body: new ReadableStream({ cancel() { cancels++; } }),
  }) }), "provider_timeout");
  assert.equal(cancels, 1);
  const controller = new AbortController(); controller.abort();
  await refuse(() => generateTyped({ request, signal: controller.signal,
    provider: bindTypeLLM({ apiKey: "key-canary", fetch: () => { throw Error("must not send"); } }) }), "cancelled");
  const body = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(1024 * 1024 + 1)); }, cancel() { cancels++; } });
  await refuse(() => invoke(raw(), { fetch: async () => ({ ok: true, body }) }), "provider_invalid_response");
  assert.equal(cancels, 2); assert.equal(body.locked, false);
});

test("CLI refuses malformed/oversize input and absent key with one closed stdout line", () => {
  for (const [input, code, error] of [["no JSON", 1, "input_invalid"],
    ["x".repeat(128 * 1024 + 1), 1, "input_invalid"], [JSON.stringify(request), 2, "auth_missing"]]) {
    const run = spawnSync(process.execPath, [fileURLToPath(new URL("../cli/typellm.mjs", import.meta.url))], {
      env: {}, encoding: "utf8", input,
    });
    assert.equal(run.status, code); assert.equal(run.stderr, "");
    assert.equal(run.stdout, JSON.stringify({ error }) + "\n");
  }
});
