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
    assert.equal(wire.questions.enough.thinking, false);
    assert.equal(Object.hasOwn(wire.questions.parts, "thinking"), false);
    assert.equal(wire.timeout, 30);
    return response(raw());
  } });
  assert.equal(calls, 1);
  assert.deepEqual(value, { result: raw().result, usage: raw().usage, elapsed: 0.5 });
  assert.ok(!JSON.stringify(value).includes("canary"));
});

test("bounded top-level thinking is opt-in and never reflects reasoning text", async () => {
  for (const budget of [1, 512, 4096]) {
    const typed = { context: "fixture", questions: {
      name: { type: "string", instructions: "Read its name", thinking: true, thinking_budget: budget },
      count: { type: "integer", depends_on: ["name"] },
      explicitOff: { type: "boolean", thinking: false },
    } };
    let calls = 0;
    const value = await generateTyped({ request: typed, provider: bindTypeLLM({ apiKey: "key-canary", fetch: async (url, init) => {
      calls++; assert.equal(url, "https://api.typellm.ai/v1/generate"); assert.equal(init.redirect, "error");
      const wire = JSON.parse(init.body);
      assert.deepEqual(wire.questions, { ...typed.questions, count: { ...typed.questions.count, thinking: false } });
      assert.equal(wire.model, "typellm-latest"); assert.deepEqual(wire.options, { temperature: 0 }); assert.equal(wire.timeout, 30);
      return response({ result: { name: "fixture", count: 1, explicitOff: false },
        thinking: { name: "private-thinking-canary" }, usage: { input_tokens: 50, thinking_tokens: 1 }, elapsed: 0.5 });
    } }) });
    assert.equal(calls, 1); assert.deepEqual(value.result, { name: "fixture", count: 1, explicitOff: false });
    assert.deepEqual(value.usage, { input_tokens: 50, thinking_tokens: 1 });
    assert.equal(Object.hasOwn(value, "thinking"), false); assert.equal(JSON.stringify(value).includes("canary"), false);
  }
});

test("unsupported or unbounded thinking refuses before transport", async () => {
  let calls = 0;
  const provider = bindTypeLLM({ apiKey: "key-canary", fetch: async () => { calls++; throw Error("must not send"); } });
  for (const schema of [
    { type: "string", thinking: true }, { type: "string", thinking_budget: 512 },
    ...[0, -1, 4097, 1.5, "512", null].map(thinking_budget => ({ type: "string", thinking: true, thinking_budget })),
    { type: "boolean", thinking: false, thinking_budget: 512 },
    { type: "string", thinking: "auto", thinking_budget: 512 }, { type: "string", thinking_effort: "low" },
    { type: "object", thinking: false, properties: { a: { type: "string" } } },
    { type: "object", properties: { a: { type: "string", thinking: true, thinking_budget: 512 } } },
    { type: "array", minItems: 0, maxItems: 1, items: { type: "string", thinking: true, thinking_budget: 512 } },
  ]) await refuse(() => generateTyped({ request: { context: "fixture", questions: { a: schema } }, provider }), "input_invalid");
  assert.equal(calls, 0);
});

test("hosted schema admits object/array containers without scalar-only thinking keys", async () => {
  const typed = { context: "fixture", questions: { profile: { type: "object", properties: {
    label: { type: "string" }, nested: { type: "object", properties: { ready: { type: "boolean" } } },
  } }, parts: request.questions.parts } };
  const result = { profile: { label: "fixture", nested: { ready: true } }, parts: [] };
  let calls = 0;
  const value = await generateTyped({ request: typed, provider: bindTypeLLM({ apiKey: "key-canary", fetch: async (_url, init) => {
    calls++;
    const wire = JSON.parse(init.body);
    // Regression from a real hosted400 and official TypeLLM0.7.2 schema.py:
    // thinking is scalar-only; array-item properties cannot take it either.
    assert.deepEqual(wire.questions, typed.questions);
    assert.equal(Object.hasOwn(wire.questions.profile, "thinking"), false);
    assert.equal(Object.hasOwn(wire.questions.parts, "thinking"), false);
    assert.equal(Object.hasOwn(wire.questions.parts.items.properties.label, "thinking"), false);
    return response({ result });
  } }) });
  assert.equal(calls, 1); assert.deepEqual(value.result, result);
});

const dependentRequest = () => {
  const item = () => ({ type: "object", properties: {
    label: { type: "string", depends_on: ["kind"] },
    kind: { type: "string", enum: ["a", "b"] },
    quantity: { type: "string", enum: ["0", "1", "2"], depends_on: ["kind", "label"] },
  } });
  return { context: "dependency fixture", questions: {
    first: item(), second: { ...item(), depends_on: ["first"] },
    third: { ...item(), depends_on: ["first", "second"] },
  } };
};

test("sibling and inherited object dependencies reach one POST with unchanged answer paths", async () => {
  const typed = dependentRequest(), result = {
    first: { label: "one", kind: "a", quantity: "1" },
    second: { label: "two", kind: "b", quantity: "2" },
    third: { label: "", kind: "a", quantity: "0" },
  };
  let calls = 0;
  const value = await generateTyped({ request: typed, provider: bindTypeLLM({ apiKey: "key-canary", fetch: async (_url, init) => {
    calls++;
    assert.deepEqual(JSON.parse(init.body).questions, typed.questions);
    return response({ result });
  } }) });
  assert.equal(calls, 1); assert.deepEqual(value, { result });
});

test("invalid dependency scope, inherited cycles and array dependencies refuse before transport", async () => {
  let calls = 0;
  const provider = bindTypeLLM({ apiKey: "key-canary", fetch: async () => { calls++; throw Error("must not send"); } });
  const array = () => ({ type: "array", minItems: 0, maxItems: 1, items: { type: "string" } });
  const mutations = [
    x => { x.questions.first.depends_on = "second"; },
    x => { x.questions.first.depends_on = ["missing"]; },
    x => { x.questions.first.depends_on = ["first"]; },
    x => { x.questions.first.depends_on = ["third"]; },
    x => { x.questions.first.properties.kind.depends_on = ["kind"]; },
    x => { x.questions.first.properties.kind.depends_on = ["quantity"]; },
    x => { x.questions.first.properties.label.depends_on = ["kind", "kind"]; },
    x => { x.questions.first.properties.label.depends_on = ["first.kind"]; },
    x => { x.questions.second.properties.kind.depends_on = ["first"]; },
    x => { x.questions.first.depends_on = Array(65).fill("second"); },
    x => { x.questions.extra = array(); x.questions.first.depends_on = ["extra"]; },
    x => { x.questions.extra = { ...array(), depends_on: [] }; },
    x => { x.questions.extra = array(); x.questions.extra.items.depends_on = []; },
  ];
  for (const change of mutations) {
    const typed = dependentRequest(); change(typed);
    await refuse(() => generateTyped({ request: typed, provider }), "input_invalid");
  }
  assert.equal(calls, 0);
});

test("bounded scalar graph accepts forward references at the existing field limit", async () => {
  const questions = Object.fromEntries(Array.from({ length: 64 }, (_, i) => ["q" + i, {
    type: "boolean", ...(i ? {} : { depends_on: Array.from({ length: 63 }, (_, j) => "q" + (j + 1)) }),
  }]));
  const result = Object.fromEntries(Object.keys(questions).map(key => [key, false]));
  let calls = 0;
  const value = await generateTyped({ request: { context: "fixture", questions },
    provider: bindTypeLLM({ apiKey: "key-canary", fetch: async () => { calls++; return response({ result }); } }) });
  assert.equal(calls, 1); assert.deepEqual(value.result, result);
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
    x => { x.questions.parts.thinking = true; }, x => { x.questions.parts.items.properties.label.thinking = false; },
    x => { x.questions.parts.items.properties.kind.enum = ["group", "group"]; },
    x => { x.questions.parts.items.properties.kind.enum = ["group"]; },
    x => { x.questions.parts.items.properties.kind.enum = Array.from({ length: 27 }, (_, i) => "kind" + i); },
    x => { x.questions.enough = { type: "string", enum: ["one"] }; },
    x => { x.questions = Object.fromEntries(Array.from({ length: 65 }, (_, i) => ["q" + i, { type: "boolean" }])); },
    x => { x.questions.constructor = { type: "boolean" }; },
  ];
  for (const change of mutations) { const x = structuredClone(request); change(x);
    await refuse(() => generateTyped({ request: x, provider }), "input_invalid"); }
  await refuse(() => generateTyped({ request, provider: bindTypeLLM() }), "auth_missing");
  assert.equal(calls, 0);
});

test("enum boundaries admit 26 array-item choices and 64 top-level choices", async () => {
  const typed = { context: "fixture", questions: {
    kind: { type: "string", enum: Array.from({ length: 64 }, (_, i) => "top" + i) },
    items: { type: "array", minItems: 0, maxItems: 1,
      items: { type: "string", enum: Array.from({ length: 26 }, (_, i) => "item" + i) } },
  } };
  const result = { kind: "top63", items: ["item25"] };
  const value = await generateTyped({ request: typed, provider: bindTypeLLM({ apiKey: "key-canary",
    fetch: async () => response({ result }) }) });
  assert.deepEqual(value.result, result);
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
    let calls = 0, reads = 0, signal;
    await assert.rejects(() => invoke(raw(), { fetch: async (_url, init) => {
      signal = init.signal;
      calls++; return { ok: false, status, get body() { reads++; throw Error("private-canary"); } };
    } }), e => e.code === "provider_http_error" && e.upstreamStatus === status && !JSON.stringify(e).includes("canary"));
    assert.equal(calls, 1); assert.equal(reads, 0); assert.equal(signal.aborted, true);
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
    const run = spawnSync(process.execPath, [fileURLToPath(new URL("../cli/index.mjs", import.meta.url))], {
      env: {}, encoding: "utf8", input,
    });
    assert.equal(run.status, code); assert.equal(run.stderr, "");
    assert.equal(run.stdout, JSON.stringify({ error }) + "\n");
  }
});

test("a late response after timeout is cancelled without reading it", async () => {
  let release, cancels = 0, reads = 0;
  const pending = invoke(raw(), { deadlineMs: 5, fetch: () => new Promise(resolve => { release = resolve; }) });
  await refuse(() => pending, "provider_timeout");
  release({ ok: true, body: { cancel() { cancels++; }, getReader() { reads++; throw Error("late-canary"); } } });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(reads, 0); assert.equal(cancels, 1);
});


// Public response observations stay separate from typed answer data and authority.
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
const metadataRequest = { context: "context-private-fixture", questions: { answer: { type: "string" } } };
const metadataRaw = (fields = {}) => ({ result: { answer: "answer-private-fixture" }, ...fields });
const metadataInvoke = rawValue => generateTyped({ request: metadataRequest,
  provider: { available: true, post: async () => rawValue } });
const metadataLookup = value => generateTyped.responseMetadata(value);
const metadataExpected = (modelStatus, model, idStatus, id) => ({
  schema: "typellm.response-metadata.v1", publicModelStatus: modelStatus, reportedPublicModel: model,
  responseIdStatus: idStatus, providerResponseId: id, backendIdentityStatus: "UNKNOWN",
});

test("public metadata preserves the three named exports and normalized return shape", async () => {
  const namespace = await import(entry);
  assert.deepEqual(Object.keys(namespace).sort(), ["TypedProviderError", "bindTypeLLM", "generateTyped"]);
  const descriptor = Object.getOwnPropertyDescriptor(generateTyped, "responseMetadata");
  assert.equal(typeof descriptor.value, "function");
  assert.equal(descriptor.enumerable, false); assert.equal(descriptor.writable, false);
  assert.equal(descriptor.configurable, false); assert.deepEqual(Object.keys(generateTyped), []);
  const rawValue = metadataRaw({ model: "public-model", id: "public-response" });
  const value = await metadataInvoke(rawValue);
  assert.deepEqual(value, { result: rawValue.result });
  assert.deepEqual(Reflect.ownKeys(value), ["result"]); assert.equal(Object.isFrozen(value), false);
  const observation = metadataLookup(value);
  assert.deepEqual(observation, metadataExpected("OBSERVED", "public-model", "OBSERVED", "public-response"));
  assert.equal(Object.isFrozen(observation), true);
  assert.throws(() => { observation.reportedPublicModel = "changed"; }, TypeError);
  rawValue.model = "later-raw-model"; value.result.answer = "changed-answer";
  assert.equal(metadataLookup(value), observation);
  assert.equal(observation.reportedPublicModel, "public-model");
  for (const copy of [{ ...value }, structuredClone(value), JSON.parse(JSON.stringify(value)), null, undefined, 1])
    assert.equal(metadataLookup(copy), null);
  const otherEntry = entry instanceof URL ? new URL(entry) : String(entry).startsWith("file:")
    ? new URL(entry) : pathToFileURL(entry);
  otherEntry.searchParams.set("metadata-module-instance", "isolated");
  const otherModule = await import(otherEntry.href);
  assert.equal(otherModule.generateTyped.responseMetadata(value), null);
});

test("metadata absent/accessor/descriptor failures do not fail a valid typed answer or execute getters", async () => {
  const absent = await metadataInvoke(metadataRaw());
  assert.deepEqual(metadataLookup(absent), metadataExpected("ABSENT", null, "ABSENT", null));
  let reads = 0;
  const accessor = metadataRaw();
  for (const field of ["model", "id"]) Object.defineProperty(accessor, field, {
    get() { reads++; throw Error("must-not-read-metadata-getter"); }, enumerable: true,
  });
  const value = await metadataInvoke(accessor);
  assert.equal(reads, 0); assert.deepEqual(value, { result: metadataRaw().result });
  assert.deepEqual(metadataLookup(value), metadataExpected("INVALID", null, "INVALID", null));
  const proxy = new Proxy(metadataRaw(), { getOwnPropertyDescriptor(target, key) {
    if (key === "model" || key === "id") throw Error("descriptor-private-fixture");
    return Reflect.getOwnPropertyDescriptor(target, key);
  } });
  assert.deepEqual(metadataLookup(await metadataInvoke(proxy)), metadataExpected("INVALID", null, "INVALID", null));
});

test("public metadata keeps exact bounded Unicode text and independently classifies invalid fields", async () => {
  for (const text of ["a", "a".repeat(256), "é".repeat(128), "😀".repeat(64), "model name"]) {
    const value = await metadataInvoke(metadataRaw({ model: text, id: text }));
    assert.deepEqual(metadataLookup(value), metadataExpected("OBSERVED", text, "OBSERVED", text));
  }
  for (const invalid of [undefined, null, 0, {}, ["x"], "", " ", " model", "model ", "\u00a0model",
    "a\nb", "a\tb", "a\u0000b", "a\u007fb", "a\u0085b", "a".repeat(257),
    "é".repeat(129), "😀".repeat(65), "\ud800", "\udc00", "a\ud800b"]) {
    const value = await metadataInvoke(metadataRaw({ model: invalid, id: "valid-response" }));
    assert.deepEqual(value, { result: metadataRaw().result });
    assert.deepEqual(metadataLookup(value), metadataExpected("INVALID", null, "OBSERVED", "valid-response"));
    const reversed = await metadataInvoke(metadataRaw({ model: "valid-model", id: invalid }));
    assert.deepEqual(metadataLookup(reversed), metadataExpected("OBSERVED", "valid-model", "INVALID", null));
  }
});

test("parallel out-of-order responses retain per-result observations without a global last model", async () => {
  let releaseFirst, releaseSecond;
  const firstPending = generateTyped({ request: metadataRequest, provider: { available: true,
    post: () => new Promise(resolve => { releaseFirst = resolve; }) } });
  const secondPending = generateTyped({ request: metadataRequest, provider: { available: true,
    post: () => new Promise(resolve => { releaseSecond = resolve; }) } });
  releaseSecond(metadataRaw({ model: "second-model", id: "second-id" }));
  const second = await secondPending;
  releaseFirst(metadataRaw({ model: "first-model", id: "first-id" }));
  const first = await firstPending;
  assert.deepEqual(first, second);
  assert.deepEqual(metadataLookup(first), metadataExpected("OBSERVED", "first-model", "OBSERVED", "first-id"));
  assert.deepEqual(metadataLookup(second), metadataExpected("OBSERVED", "second-model", "OBSERVED", "second-id"));
});

const metadataCliPath = fileURLToPath(new URL("../cli/index.mjs", import.meta.url));
const metadataHash = input => createHash("sha256").update(input).digest("hex");
function metadataCli(input, { optIn = true, hasKey = true, data = metadataRaw({ model: "cli-public-model", id: "cli-public-id" }) } = {}) {
  // The preload replaces all HTTP with a synthetic response; no external API can run.
  const preload = [
    "globalThis.fetch = async (_url, init) => {",
    "  if (init.headers.authorization !== 'Bearer synthetic-cli-key') throw Error('bad synthetic auth');",
    "  const wire = JSON.parse(init.body);",
    "  if (wire.model !== 'typellm-latest' || wire.context !== 'context-private-fixture') throw Error('request changed');",
    "  return new Response(" + JSON.stringify(JSON.stringify(data)) + ", {status:200});",
    "};",
  ].join("\n");
  return spawnSync(process.execPath, ["--import", "data:text/javascript," + encodeURIComponent(preload),
    metadataCliPath, ...(optIn ? ["--response-metadata"] : [])], {
    input, env: hasKey ? { TYPELLM_API_KEY: "synthetic-cli-key" } : {}, encoding: "utf8",
    shell: false, windowsHide: true, maxBuffer: 4 * 1024 * 1024, timeout: 10000,
  });
}
function metadataFrame(run) {
  assert.equal(run.error, undefined); assert.equal(run.signal, null);
  const match = /^TYPELLM_RESPONSE_METADATA_JSON_BEGIN\n([^\n]+)\nTYPELLM_RESPONSE_METADATA_JSON_END\n$/.exec(run.stderr);
  assert.ok(match, "exactly one closed metadata frame");
  const frame = JSON.parse(match[1]);
  assert.deepEqual(Object.keys(frame).sort(), ["backendIdentityStatus", "metadataSchema", "providerResponseId",
    "publicModelStatus", "reportedPublicModel", "responseIdStatus", "responseMetadataStatus", "schema",
    "stdinBytes", "stdinComplete", "stdinSha256"]);
  assert.ok(Object.values(frame).every(x => x === null || ["string", "number", "boolean"].includes(typeof x)));
  assert.equal(frame.schema, "typellm.cli-response-metadata.v1"); assert.equal(frame.backendIdentityStatus, "UNKNOWN");
  for (const privateText of ["context-private-fixture", "answer-private-fixture", "synthetic-cli-key"])
    assert.equal(run.stderr.includes(privateText), false);
  return frame;
}

test("CLI opt-in binds public observations to exact complete stdin without changing stdout or default stderr", () => {
  const input = JSON.stringify(metadataRequest) + "\n";
  const normal = metadataCli(input, { optIn: false });
  const observed = metadataCli(input);
  assert.equal(normal.status, 0); assert.equal(observed.status, 0);
  assert.equal(normal.stderr, ""); assert.equal(normal.stdout, JSON.stringify({ result: metadataRaw().result }) + "\n");
  assert.equal(observed.stdout, normal.stdout);
  const frame = metadataFrame(observed);
  assert.equal(frame.stdinComplete, true); assert.equal(frame.stdinBytes, Buffer.byteLength(input));
  assert.equal(frame.stdinSha256, metadataHash(input));
  assert.equal(frame.responseMetadataStatus, "SDK_OBSERVATION_AVAILABLE");
  assert.equal(frame.metadataSchema, "typellm.response-metadata.v1");
  assert.equal(frame.reportedPublicModel, "cli-public-model"); assert.equal(frame.publicModelStatus, "OBSERVED");
  assert.equal(frame.providerResponseId, "cli-public-id"); assert.equal(frame.responseIdStatus, "OBSERVED");
  const noLf = metadataFrame(metadataCli(input.slice(0, -1)));
  assert.notEqual(noLf.stdinSha256, frame.stdinSha256);
  assert.equal(noLf.stdinSha256, metadataHash(input.slice(0, -1)));
});

test("CLI opt-in preserves absent/invalid public metadata without failing valid answers", () => {
  for (const [data, status] of [[metadataRaw(), "ABSENT"], [metadataRaw({ model: 1, id: "bad\nidentifier" }), "INVALID"]]) {
    const run = metadataCli(JSON.stringify(metadataRequest), { data });
    assert.equal(run.status, 0); assert.equal(run.stdout, JSON.stringify({ result: data.result }) + "\n");
    const frame = metadataFrame(run);
    assert.equal(frame.responseMetadataStatus, "SDK_OBSERVATION_AVAILABLE");
    assert.equal(frame.publicModelStatus, status); assert.equal(frame.responseIdStatus, status);
    assert.equal(frame.reportedPublicModel, null); assert.equal(frame.providerResponseId, null);
  }
});

test("CLI opt-in errors retain original exit/stdout and distinguish complete from incomplete stdin", () => {
  const cases = [
    { input: "no JSON\n", code: 1, error: "input_invalid", complete: true },
    { input: Buffer.from([255, 10]), code: 1, error: "input_invalid", complete: true },
    { input: "x".repeat(128 * 1024 + 1), code: 1, error: "input_invalid", complete: false },
    { input: JSON.stringify(metadataRequest), hasKey: false, code: 2, error: "auth_missing", complete: true },
    { input: JSON.stringify(metadataRequest), data: { result: { answer: 1 }, model: "must-not-be-observed" },
      code: 4, error: "provider_contract_error", complete: true },
  ];
  for (const current of cases) {
    const options = { ...(current.hasKey === false ? { hasKey: false } : {}),
      ...(current.data ? { data: current.data } : {}) };
    const normal = metadataCli(current.input, { ...options, optIn: false });
    const observed = metadataCli(current.input, options);
    assert.equal(normal.status, current.code); assert.equal(observed.status, current.code);
    assert.equal(normal.stderr, ""); assert.equal(normal.stdout, JSON.stringify({ error: current.error }) + "\n");
    assert.equal(observed.stdout, normal.stdout);
    const frame = metadataFrame(observed);
    assert.equal(frame.responseMetadataStatus, "NOT_OBSERVED"); assert.equal(frame.metadataSchema, null);
    assert.equal(frame.publicModelStatus, "UNKNOWN"); assert.equal(frame.responseIdStatus, "UNKNOWN");
    assert.equal(frame.reportedPublicModel, null); assert.equal(frame.providerResponseId, null);
    assert.equal(frame.stdinComplete, current.complete);
    assert.equal(frame.stdinBytes, current.complete ? Buffer.byteLength(current.input) : null);
    assert.equal(frame.stdinSha256, current.complete ? metadataHash(current.input) : null);
  }
});
