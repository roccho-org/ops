import { abortAllDurableObjects, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { OAuthCredential } from "@earendil-works/pi-ai";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bootstrapWorkerCredential, createWorkerModels, WorkerCredentialStore } from "../src/worker-oauth.ts";
import { createChatHarnessOptions } from "../src/chat.ts";
import { bindJevProof } from "../src/worker-jev.ts";

// Two graceful evictions can each drain for 30s. This bound includes both;
// assertion polling stays 10s. Cleanup is a forced reset, never a storage reset.
// https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/#durable-objects
vi.setConfig({ testTimeout: 80_000, hookTimeout: 10_000 });
const nativeFetch = globalThis.fetch;
const fixture = (): OAuthCredential =>
  JSON.parse((env as unknown as { PI_PROOF_AUTH: string }).PI_PROOF_AUTH);
const bootstrapSession: string = JSON.parse(
  (env as unknown as { PI_CHATGPT_BOOTSTRAP: string }).PI_CHATGPT_BOOTSTRAP,
).session;
const wait = { timeout: 10_000, interval: 20 };

async function closeSocket(socket: WebSocket) {
  if (socket.readyState === WebSocket.CLOSED) return;
  const closed = new Promise<void>((resolve) =>
    socket.addEventListener("close", () => resolve(), { once: true }),
  );
  socket.close(1000, "proof complete");
  await closed;
}

afterEach(async () => {
  await abortAllDurableObjects();
});

async function seed(session: string, credential: OAuthCredential) {
  const stub = env.SESSIONS.getByName(session);
  await runInDurableObject(stub, async (_instance, state) => {
    await state.blockConcurrencyWhile(async () => {});
    await new WorkerCredentialStore(state.storage).modify("openai", async () => credential);
  });
  await evictDurableObject(stub);
}

async function saved(session: string) {
  return runInDurableObject(env.SESSIONS.getByName(session), async (_instance, state) =>
    new WorkerCredentialStore(state.storage).read("openai"),
  );
}

async function connect(session: string, conversationId = 1, headers: Record<string, string> = {}) {
  const response = await exports.default.fetch(
    `https://example.com/api/sessions/${session}?username=Owner`,
    { headers: { Upgrade: "websocket", ...headers } },
  );
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  const messages: unknown[] = [];
  socket.addEventListener("message", (event) => { messages.push(JSON.parse(String(event.data))); });
  socket.accept();
  await vi.waitFor(() => expect(messages.length).toBeGreaterThanOrEqual(4), wait);
  const result = (requestId: string) => messages.find((message) =>
    (message as { requestId?: string }).requestId === requestId,
  ) as { ok: boolean; conversationId: number } | undefined;
  if (conversationId !== 1) {
    const requestId = `open-${conversationId}`;
    socket.send(JSON.stringify({ type: "conversation.open", requestId, conversationId }));
    await vi.waitFor(() => expect(result(requestId)?.ok).toBe(true), wait);
  }
  return {
    socket,
    response,
    messages,
    get conversationId() { return conversationId; },
    create: async (requestId: string) => {
      socket.send(JSON.stringify({ type: "conversation.create", requestId }));
      await vi.waitFor(() => expect(result(requestId)?.ok).toBe(true), wait);
      conversationId = result(requestId)!.conversationId;
    },
    submit: (requestId: string, content: string) =>
      socket.send(JSON.stringify({ type: "prompt.submit", conversationId, requestId, content })),
  };
}

// OpenAI wire events, not fauxProvider or a replacement for the inference code.
function responseStream(text: string) {
  const item = {
    id: "fixture-message", type: "message", role: "assistant", status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  const response = {
    id: "fixture-response", object: "response", created_at: 1,
    model: "gpt-6-luna", status: "completed", output: [item],
    usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 },
  };
  const events = [
    { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
    { type: "response.content_part.added", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
    { type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: item.id, delta: text },
    { type: "response.output_text.done", output_index: 0, content_index: 0, item_id: item.id, text },
    { type: "response.content_part.done", output_index: 0, content_index: 0, part: item.content[0] },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response },
  ];
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", {
    headers: { "content-type": "text/event-stream" },
  });
}

function mockRemote(replies: string[], revoked = false) {
  const inference: { authorization: string | null; body: unknown }[] = [];
  let rotations = 0;
  // Do not use vi.fn here: its call/result history retains DO-owned Signal and
  // Response objects, which can themselves prevent a real instance eviction.
  // Record only detached request evidence and counts, not I/O-bearing objects.
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    if (input instanceof Request) throw new Error("Unexpected Request transport: inspect the pinned SDK seam");
    const url = String(input);
    expect(init?.method).toBe("POST");
    const rawBody = String(init?.body ?? "");
    if (url === "https://auth.openai.com/api/accounts/oauth/token") {
      rotations++;
      const body = new URLSearchParams(rawBody);
      expect(body.get("grant_type")).toBe("refresh_token");
      expect(body.get("client_id")).toBe(fixture().clientId);
      expect(body.get("refresh_token")).toBe(fixture().refresh);
      expect(body.get("resource")).toBe("https://api.openai.com/v1");
      if (revoked) return new Response("fixture-invalid-grant", { status: 401 });
      return Response.json({
        access_token: "fixture-access-rotated", refresh_token: "fixture-refresh-rotated",
        expires_in: 3600, scope: "chatgpt.tokens.use.direct",
      });
    }
    expect(url).toBe("https://api.openai.com/v1/responses");
    const body: unknown = JSON.parse(rawBody);
    expect(body).toMatchObject({ stream: true, model: "gpt-6-luna" });
    inference.push({ authorization: new Headers(init?.headers).get("authorization"), body });
    const reply = replies.shift();
    if (reply === undefined) throw new Error("Unexpected extra mock inference");
    return responseStream(reply);
  });
  return { inference, rotations: () => rotations };
}

async function submissionStatus(session: string, requestId: string, expected: string | readonly string[], conversationId: number = ROOT_CONVERSATION_ID) {
  await vi.waitFor(async () => {
    const status = await runInDurableObject(env.SESSIONS.getByName(session), async (_instance, state) => {
      const storage = await openDurableObjectSqliteStorage(state.storage);
      return (await storage.submissionByRequest(conversationId as typeof ROOT_CONVERSATION_ID, requestId, BACKGROUND_CONTEXT))?.status;
    });
    expect(typeof expected === "string" ? [expected] : expected).toContain(status);
  }, wait);
}

describe("real Worker app path with synthetic OAuth and mocked remote responses", () => {
  it("imports the binding, completes chat, persists rotation, evicts, and continues with old history", async () => {
    const session = bootstrapSession;
    const remote = mockRemote(["fixture-first-answer", "fixture-second-answer"]);
    // No internal credential seeding: the real Session constructor consumes the binding.
    const first = await connect(session);
    expect(await saved(session)).toMatchObject({ ...fixture(), expires: 0 });
    first.submit("oauth-first", "Remember fixture-plan");
    await vi.waitFor(() => {
      const frames = JSON.stringify(first.messages);
      expect(frames).toContain("fixture-first-answer");
      expect(frames).toContain('"stopReason":"stop"');
      expect(frames).toContain('"type":"run_end"');
    }, wait);
    expect(await saved(session)).toMatchObject({ access: "fixture-access-rotated", refresh: "fixture-refresh-rotated" });
    console.info("fixture-stage", "first-response-and-rotation-saved");
    await closeSocket(first.socket);
    console.info("fixture-stage", "first-socket-closed");
    await abortAllDurableObjects();
    console.info("fixture-stage", "first-DO-evicted");

    const second = await connect(session);
    expect(JSON.stringify(second.messages)).toContain("fixture-first-answer");
    expect(JSON.stringify(second.messages)).toContain("Remember fixture-plan");
    second.submit("oauth-second", "Continue fixture-plan");
    await vi.waitFor(() => {
      expect(JSON.stringify(second.messages)).toContain("fixture-second-answer");
      expect(JSON.stringify(second.messages)).toContain('"type":"run_end"');
    }, wait);
    expect(remote.rotations()).toBe(1);
    expect(remote.inference).toHaveLength(2);
    expect(remote.inference.map((item) => item.authorization)).toEqual([
      "Bearer fixture-access-rotated", "Bearer fixture-access-rotated",
    ]);
    const history = JSON.stringify(remote.inference[1].body);
    for (const text of ["Remember fixture-plan", "fixture-first-answer", "Continue fixture-plan"]) expect(history).toContain(text);
    const publicFrames = JSON.stringify([...first.messages, ...second.messages]);
    for (const token of [fixture().access, fixture().refresh, "fixture-access-rotated", "fixture-refresh-rotated"]) expect(publicFrames).not.toContain(token);
    await closeSocket(second.socket);
    await abortAllDurableObjects();
    const third = await connect(session);
    expect(JSON.stringify(third.messages)).toContain("fixture-second-answer");
    expect(JSON.stringify(third.messages)).toContain('"stopReason":"stop"');
    expect(await saved(session)).toMatchObject({ refresh: "fixture-refresh-rotated" });
    await closeSocket(third.socket);
    console.info("fixture-stage", "two-evictions-history-and-rotated-auth-read-back");
  });

  it("denies native network access and does not copy the bootstrap grant into another DO", async () => {
    const denied = await nativeFetch("https://pi-proof-no-network.invalid/");
    expect(denied.status).toBe(401);
    expect(await denied.text()).toBe("MOCK_ONLY: native outbound denied");
    const session = "oauth-app-missing";
    const client = await connect(session);
    client.submit("missing-grant", "Do not bill an API key");
    await submissionStatus(session, "missing-grant", "unanswered");
    expect(fetch).not.toHaveBeenCalled();
    expect(await saved(session)).toBeUndefined();
    await closeSocket(client.socket);
  });

  it("fails closed on revoked refresh and preserves state across recreation", async () => {
    const session = "oauth-app-revoked";
    const expired = { ...fixture(), expires: 0 };
    await seed(session, expired);
    const remote = mockRemote([], true);
    const client = await connect(session);
    client.submit("revoked-grant", "Do not fall back");
    await submissionStatus(session, "revoked-grant", "unanswered");
    expect(remote.rotations()).toBe(1);
    expect(remote.inference).toHaveLength(0);
    expect(await saved(session)).toEqual(expired);
    await closeSocket(client.socket);
    await abortAllDurableObjects();
    expect(await saved(session)).toEqual(expired);
  });

  it("serializes shared-DO refresh and reads the persisted result from a new store", async () => {
    const session = "oauth-store-concurrent";
    await seed(session, { ...fixture(), expires: 0 });
    const remote = mockRemote([]);
    await runInDurableObject(env.SESSIONS.getByName(session), async (_instance, state) => {
      const models = createWorkerModels(state.storage);
      const result = await Promise.all([models.getAuth("openai"), models.getAuth("openai")]);
      expect(result.map((value) => value?.auth.apiKey)).toEqual(["fixture-access-rotated", "fixture-access-rotated"]);
      expect(await new WorkerCredentialStore(state.storage).list()).toEqual([{ providerId: "openai", type: "oauth" }]);
    });
    expect(remote.rotations()).toBe(1);
    await abortAllDurableObjects();
    expect(await saved(session)).toMatchObject({ refresh: "fixture-refresh-rotated" });
  });

  it("does not release newly issued auth when its durable write fails", async () => {
    const session = "oauth-store-write-failure";
    const expired = { ...fixture(), expires: 0 };
    await seed(session, expired);
    const remote = mockRemote([]);
    await runInDurableObject(env.SESSIONS.getByName(session), async (_instance, state) => {
      const write = vi.spyOn(state.storage, "put").mockRejectedValueOnce(new Error("fixture-write-failure"));
      try {
        await expect(createWorkerModels(state.storage).getAuth("openai")).rejects.toMatchObject({ cause: { message: "fixture-write-failure" } });
        expect(write).toHaveBeenCalledTimes(1);
      } finally { write.mockRestore(); }
    });
    expect(remote.rotations()).toBe(1);
    expect(remote.inference).toHaveLength(0);
    expect(await saved(session)).toEqual(expired);
  });

  it("rejects malformed bootstrap data and never resurrects a consumed binding after deletion", async () => {
    const session = "oauth-bootstrap-guards";
    await runInDurableObject(env.SESSIONS.getByName(session), async (_instance, state) => {
      await state.blockConcurrencyWhile(async () => {
        for (const raw of ["not-json-secret-must-not-escape", JSON.stringify({ session, credential: { ...fixture(), expires: null } })]) {
          await expect(bootstrapWorkerCredential(state, { SESSIONS: env.SESSIONS, PI_CHATGPT_BOOTSTRAP: raw })).rejects.toThrow("Invalid Pi subscription bootstrap");
          expect(await new WorkerCredentialStore(state.storage).read("openai")).toBeUndefined();
        }
        const configured = { SESSIONS: env.SESSIONS, PI_CHATGPT_BOOTSTRAP: JSON.stringify({ session, credential: fixture() }) };
        await bootstrapWorkerCredential(state, configured);
        const store = new WorkerCredentialStore(state.storage);
        expect(await store.read("openai")).toEqual(fixture());
        await store.delete("openai");
        await bootstrapWorkerCredential(state, configured);
        expect(await store.read("openai")).toBeUndefined();
      });
    });
  });
});
function jevToolStream(calls = 1, prefix = "jev") {
  const output = Array.from({ length: calls }, (_, index) => ({
    id: `${prefix}-item-${index}`, call_id: `${prefix}-call-${index}`, type: "function_call",
    name: "ask_jev", arguments: JSON.stringify({ state: "fixture-state", question: "How likely is this fixture?" }),
    status: "completed",
  }));
  const response = {
    id: "jev-fixture-response", object: "response", created_at: 1,
    model: "gpt-6-luna", status: "completed", output,
    usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 },
  };
  const events: unknown[] = [
    { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
  ];
  for (const [index, item] of output.entries()) {
    events.push(
      { type: "response.output_item.added", output_index: index, item: { ...item, arguments: "", status: "in_progress" } },
      { type: "response.function_call_arguments.delta", output_index: index, item_id: item.id, delta: item.arguments },
      { type: "response.function_call_arguments.done", output_index: index, item_id: item.id, arguments: item.arguments },
      { type: "response.output_item.done", output_index: index, item },
    );
  }
  events.push({ type: "response.completed", response });
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", {
    headers: { "content-type": "text/event-stream" },
  });
}

describe("Worker Pi -> canonical Jev client -> SQLite proof (all remote replies mocked)", () => {
  it("commits typed tool output, recreates the DO and restores it for a neutral second user turn", async () => {
    const session = "jev-proof";
    await seed(session, fixture());
    const marker = "fixture-marker-6f1d84b8538a4fb9";
    const inference: unknown[] = [];
    let jevPosts = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      const body = JSON.parse(String(init?.body));
      if (String(input) === "https://api.typesafe.ai/v1/systemone") {
        jevPosts++;
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-jev-not-real");
        expect(init?.redirect).toBe("error");
        expect(body).toMatchObject({ model: "jev-latest", questions: { assessment: { type: "noul" } } });
        return Response.json({ model: "jev-latest", answers: { assessment: { type: "noul", noul: 0.734125 } } });
      }
      expect(String(input)).toBe("https://api.openai.com/v1/responses");
      expect(body).toMatchObject({ stream: true });
      inference.push(body);
      if (inference.length === 1) return jevToolStream();
      if (inference.length === 2) {
        expect(JSON.stringify(body)).toContain("0.734125");
        return responseStream("fixture-consumed-jev-answer");
      }
      if (inference.length === 3) {
        expect(JSON.stringify(body)).toContain(marker);
        expect(JSON.stringify(body)).toContain("0.734125");
        return responseStream("fixture-recalled-from-committed-history");
      }
      throw new Error("Unexpected extra model request");
    });
    const first = await connect(session);
    await first.create("jev-first-conversation");
    first.submit("jev-first", `Remember ${marker}; ask Jev once and use its answer.`);
    await vi.waitFor(() => {
      expect(JSON.stringify(first.messages)).toContain("fixture-consumed-jev-answer");
      expect(JSON.stringify(first.messages)).toContain('"type":"run_end"');
    }, wait);
    await closeSocket(first.socket);
    await evictDurableObject(env.SESSIONS.getByName(session));
    const second = await connect(session, first.conversationId);
    expect(JSON.stringify(second.messages)).toContain("0.734125");
    // Fresh client sends no previous values, transcript or prompt.
    second.submit("jev-recall", "Recall the marker and assessment from our earlier exchange.");
    await vi.waitFor(() => expect(JSON.stringify(second.messages)).toContain("fixture-recalled-from-committed-history"), wait);
    expect(jevPosts).toBe(1);
    expect(inference).toHaveLength(3); // 2 user turns; first has a tool continuation.
    expect(JSON.stringify([...first.messages, ...second.messages])).not.toContain("fixture-jev-not-real");
    await closeSocket(second.socket);
    const isolated = await connect("jev-isolated-session");
    for (const value of [marker, "0.734125"]) expect(JSON.stringify(isolated.messages)).not.toContain(value);
    await closeSocket(isolated.socket);
    expect(inference).toHaveLength(3); // isolation inspection invokes no model.
  });

  it("admits only one native POST when the model emits two calls in the same round", async () => {
    const session = "jev-proof";
    await seed(session, fixture());
    let models = 0, posts = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      if (String(input) === "https://api.typesafe.ai/v1/systemone") {
        posts++;
        return Response.json({ model: "jev-latest", answers: { assessment: { type: "noul", noul: 0.25 } } });
      }
      expect(String(input)).toBe("https://api.openai.com/v1/responses");
      return ++models === 1 ? jevToolStream(2) : responseStream("fixture-two-calls-settled");
    });
    const client = await connect(session);
    await client.create("jev-parallel-conversation");
    client.submit("jev-parallel", "Ask for the assessment.");
    await vi.waitFor(() => expect(JSON.stringify(client.messages)).toContain("fixture-two-calls-settled"), wait);
    expect(posts).toBe(1);
    expect(JSON.stringify(client.messages)).toContain("JEV_PROOF_ATTEMPT_CONSUMED");
    await closeSocket(client.socket);
  });
});
describe("bounded Jev proof failure and legacy boundaries", () => {
  it("preserves legacy defaults when proof composition is unselected", () => {
    const legacy = createChatHarnessOptions(async () => {});
    const proof = createChatHarnessOptions(async () => {}, undefined, bindJevProof("fixture"));
    expect(legacy.settings?.extensions?.[0]?.tools).toHaveLength(3);
    expect(legacy.settings?.stream).toBeUndefined();
    expect(legacy.settings?.retry).toBeUndefined();
    expect(legacy.settings?.compaction).toBeUndefined();
    expect(proof.settings?.extensions?.[0]?.tools?.map((tool) => tool.name)).toEqual(["ask_jev"]);
    expect(proof.settings?.stream?.maxRetries).toBe(0);
    expect(proof.settings?.retry).toMatchObject({ enabled: false, maxRetries: 0 });
    expect(proof.settings?.compaction).toBeUndefined();
    expect(bindJevProof()).toBeUndefined();
  });

  it("retains the consumed allowance after post-send interruption, recreation and a new task", async () => {
    const session = "jev-proof";
    await seed(session, fixture());
    let posts = 0, requests = 0;
    let newCallId = "";
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "https://api.typesafe.ai/v1/systemone") {
        posts++;
        return new Promise<Response>(() => {}); // sent, no committed response
      }
      expect(String(input)).toBe("https://api.openai.com/v1/responses");
      requests++;
      if (requests === 1) return jevToolStream(1, "jev-initial");
      if (String(init?.body).includes("Try a new assessment")) {
        const prefix = `jev-new-${requests}`;
        // Exact composite ID emitted by the pinned pi-ai Responses decoder.
        newCallId = `${prefix}-call-0|${prefix}-item-0`;
        return jevToolStream(1, prefix);
      }
      return responseStream("fixture-interruption-recovery");
    });
    const first = await connect(session);
    await first.create("jev-interrupted-conversation");
    first.submit("jev-interrupt-first", "Ask for one assessment.");
    await vi.waitFor(() => expect(posts).toBe(1), wait);
    first.socket.close(1000, "forced recreation test");
    await abortAllDurableObjects();
    const reopened = await connect(session, first.conversationId);
    reopened.submit("jev-interrupt-new-task", "Try a new assessment");
    await vi.waitFor(() => expect(JSON.stringify(reopened.messages)).toContain("JEV_PROOF_ATTEMPT_CONSUMED"), wait);
    await submissionStatus(session, "jev-interrupt-new-task", ["done", "unanswered"], first.conversationId);
    expect(newCallId).not.toBe("");
    const deniedNewCall = await runInDurableObject(env.SESSIONS.getByName(session), async (_instance, state) => {
      const storage = await openDurableObjectSqliteStorage(state.storage);
      const page = await storage.scanEntries(
        { conversationId: first.conversationId as typeof ROOT_CONVERSATION_ID }, 100, undefined, BACKGROUND_CONTEXT,
      );
      return page.items.some((entry) => entry.model?.some((message) =>
        message.role === "toolResult" && message.toolCallId === newCallId &&
        JSON.stringify(message.content).includes("JEV_PROOF_ATTEMPT_CONSUMED"),
      ));
    });
    expect(deniedNewCall).toBe(true);
    expect(posts).toBe(1);
    expect(requests).toBeGreaterThanOrEqual(2);
    console.info("fixture-interruption-counts", JSON.stringify({ userTurns: 2, modelRequests: requests, jevPosts: posts }));
    const frames = JSON.stringify(reopened.messages);
    expect(frames.includes("interrupted") || frames.includes("JEV_OUTCOME_UNKNOWN")).toBe(true);
    await closeSocket(reopened.socket);
  });

  it("halts an invalid-response round without provider-text exposure or retry", async () => {
    const session = "jev-proof";
    await seed(session, fixture());
    let posts = 0, requests = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      if (String(input) === "https://api.typesafe.ai/v1/systemone") {
        posts++;
        return Response.json({ model: "fixture", answers: { assessment: { type: "noul", noul: "fixture-provider-private" } } });
      }
      expect(String(input)).toBe("https://api.openai.com/v1/responses");
      if (++requests > 1) throw new Error("Unexpected continuation after UNKNOWN");
      return jevToolStream(2);
    });
    const client = await connect(session);
    await client.create("jev-invalid-conversation");
    client.submit("jev-invalid-result", "Ask for the assessment.");
    await vi.waitFor(() => {
      expect(JSON.stringify(client.messages)).toContain("JEV_OUTCOME_UNKNOWN");
      expect(JSON.stringify(client.messages)).toContain('"type":"run_end"');
    }, wait);
    expect(posts).toBe(1);
    expect(requests).toBe(1);
    expect(JSON.stringify(client.messages)).not.toContain("fixture-provider-private");
    await closeSocket(client.socket);
  });
});

describe("finite transient proof transport — keyless mocks only", () => {
  it("verifies owner, emits supported wire, counts actual POSTs and loses access after real DO eviction", async () => {
    const { TransientWorkerProof } = await import("../src/worker-oauth.ts");
    const keys = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
    const jwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
    const encode = (value: string) => btoa(value).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
    const now = Math.floor(Date.now() / 1000);
    const header = encode(JSON.stringify({ alg: "RS256", kid: "fixture" }));
    const claims = encode(JSON.stringify({ iss: "https://fixture.cloudflareaccess.com",
      aud: "fixture-app", sub: "fixture-owner", iat: now, exp: now + 3600 }));
    const unsigned = header + "." + claims;
    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(unsigned));
    const jwt = unsigned + "." + encode(String.fromCharCode(...new Uint8Array(signature)));
    const subjectHash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("fixture-owner")))]
      .map(x => x.toString(16).padStart(2, "0")).join("");
    const config = { PI_ACCESS_ISSUER: "https://fixture.cloudflareaccess.com",
      PI_ACCESS_AUDIENCE: "fixture-app", PI_ACCESS_OWNER_HASH: subjectHash };
    const request = () => new Request("https://example.com/", { headers: {
      "Cf-Access-Jwt-Assertion": jwt, "Pi-Proof-Access": "fixture-oauth-bearer",
      "Pi-Proof-Expires": String(Date.now() + 300_000),
    } });
    let posts = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!(input instanceof Request)) {
        expect(String(input)).toBe(config.PI_ACCESS_ISSUER + "/cdn-cgi/access/certs");
        return Response.json({ keys: [{ ...jwk, kid: "fixture", alg: "RS256" }] });
      }
      expect(input.url).toBe("https://api.openai.com/v1/responses");
      expect(init?.redirect).toBe("error");
      const body = await input.json() as Record<string, unknown>;
      expect(body.store).toBe(false);
      expect(body.stream).toBe(true);
      for (const name of ["tools", "previous_response_id", "max_output_tokens", "max_tool_calls",
        "temperature", "top_p", "metadata", "prompt_cache_key", "prompt_cache_retention"]) expect(body).not.toHaveProperty(name);
      expect(JSON.stringify(body.input)).toContain('"type":"additional_tools"');
      expect(JSON.stringify(body.input)).not.toContain('"role":"system"');
      posts++;
      return responseStream("fixture-transient-answer");
    });
    const stub = env.SESSIONS.getByName("transient-transport");
    let firstBoot = "";
    await runInDurableObject(stub, async (_instance, state) => {
      const proof = new TransientWorkerProof(state.storage);
      await expect(proof.attach(new Request("https://example.com"), config)).rejects.toThrow();
      expect(await proof.counts()).toBe(0);
      const witness = await proof.attach(request(), config);
      expect(witness["Pi-Proof-Prior-Token"]).toBe("false");
      firstBoot = witness["Pi-Proof-Boot"];
      const models = proof.models();
      const model = models.getModel("openai", "gpt-6-luna")!;
      for (let i = 0; i < 2; i++) {
        const result = await models.completeSimple(model, {
          systemPrompt: "Finite proof", messages: [{ role: "user", content: "fixture", timestamp: Date.now() }],
          tools: [{ name: "ask_jev", description: "fixture", parameters: { type: "object", properties: {} } }],
        });
        expect(result.stopReason).toBe("stop");
      }
      expect(await proof.counts()).toBe(2);
      expect([...await state.storage.list({ prefix: "pi.oauth." })]).toHaveLength(0);
    });
    await evictDurableObject(stub);
    await runInDurableObject(stub, async (_instance, state) => {
      const proof = new TransientWorkerProof(state.storage);
      expect(proof.bootId).not.toBe(firstBoot);
      expect(proof.tokenPresent).toBe(false);
      await expect(proof.fetch("https://api.openai.com/v1/responses", { method: "POST" })).rejects.toThrow();
      expect(await proof.counts()).toBe(2);
      const witness = await proof.attach(request(), config);
      expect(witness["Pi-Proof-Prior-Token"]).toBe("false");
      await proof.fetch("https://api.openai.com/v1/responses", { method: "POST",
        body: JSON.stringify({ store: false, stream: true, input: [{ type: "additional_tools" }] }) });
      await expect(proof.fetch("https://api.openai.com/v1/responses", { method: "POST" })).rejects.toThrow("budget consumed");
      expect(await proof.counts()).toBe(3);
      expect([...await state.storage.list({ prefix: "pi.oauth." })]).toHaveLength(0);
    });
    expect(posts).toBe(3);
  });
});

it.skipIf((env as unknown as { PI_PROOF_TRANSIENT?: string }).PI_PROOF_TRANSIENT !== "true")(
  "selected-transient Session authenticates, uses Jev and loses access across actual recreation", async () => {
    const keys = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
    const jwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
    const encode = (value: string) => btoa(value).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
    const now = Math.floor(Date.now() / 1000);
    const unsigned = encode(JSON.stringify({ alg: "RS256", kid: "session-fixture" })) + "." +
      encode(JSON.stringify({ iss: "https://fixture.cloudflareaccess.com", aud: "fixture-app",
        sub: "fixture-owner", iat: now, exp: now + 3600 }));
    const signed = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(unsigned));
    const jwt = unsigned + "." + encode(String.fromCharCode(...new Uint8Array(signed)));
    const headers = { "Cf-Access-Jwt-Assertion": jwt, "Pi-Proof-Access": "fixture-volatile-oauth",
      "Pi-Proof-Expires": String(Date.now() + 600_000) };
    const bodies: unknown[] = [];
    let posts = 0;
    const marker = "fixture-transient-marker-7fb96e1a";
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "https://fixture.cloudflareaccess.com/cdn-cgi/access/certs") {
        return Response.json({ keys: [{ ...jwk, kid: "session-fixture", alg: "RS256" }] });
      }
      if (String(input) === "https://api.typesafe.ai/v1/systemone") {
        posts++;
        return Response.json({ model: "jev-latest", answers: { assessment: { type: "noul", noul: 0.41729 } } });
      }
      expect(input).toBeInstanceOf(Request);
      const request = input as Request;
      expect(init?.redirect).toBe("error");
      const body = await request.json() as Record<string, unknown>;
      expect(body.store).toBe(false);
      expect(body.stream).toBe(true);
      expect(body).not.toHaveProperty("tools");
      expect(JSON.stringify(body)).toContain('"type":"additional_tools"');
      bodies.push(body);
      if (bodies.length === 1) return jevToolStream(1, "transient-session");
      expect(JSON.stringify(body)).toContain("0.41729");
      if (bodies.length === 2) return responseStream("fixture-volatile-consumed");
      expect(JSON.stringify(body)).toContain(marker);
      return responseStream("fixture-volatile-recalled");
    });
    const session = "jev-proof";
    const first = await connect(session, 1, headers);
    const boot = first.response.headers.get("Pi-Proof-Boot");
    expect(first.response.headers.get("Pi-Proof-Prior-Token")).toBe("false");
    expect(boot).toBeTruthy();
    await first.create("transient-create");
    first.submit("transient-first", "Remember " + marker + " and ask Jev once.");
    await submissionStatus(session, "transient-first", "done", first.conversationId);
    await vi.waitFor(() => expect(JSON.stringify(first.messages)).toContain("fixture-volatile-consumed"), wait);
    expect(await saved(session)).toBeUndefined();
    await closeSocket(first.socket);
    await evictDurableObject(env.SESSIONS.getByName(session));
    const missing = await exports.default.fetch("https://example.com/api/sessions/" + session, {
      headers: { Upgrade: "websocket", "Cf-Access-Jwt-Assertion": jwt },
    });
    expect(missing.status).toBe(403);
    expect(bodies).toHaveLength(2);
    expect(posts).toBe(1);
    await runInDurableObject(env.SESSIONS.getByName(session), async (_instance, state) => {
      expect(await state.storage.get("pi.proof.responses.posts")).toBe(2);
      expect([...await state.storage.list({ prefix: "pi.oauth." })]).toHaveLength(0);
    });
    const second = await connect(session, first.conversationId, headers);
    expect(second.response.headers.get("Pi-Proof-Boot")).not.toBe(boot);
    expect(second.response.headers.get("Pi-Proof-Prior-Token")).toBe("false");
    expect(second.response.headers.get("Pi-Proof-Posts")).toBe("2");
    second.submit("transient-second", "Recall the marker and assessment from our earlier exchange.");
    await submissionStatus(session, "transient-second", "done", first.conversationId);
    await vi.waitFor(() => expect(JSON.stringify(second.messages)).toContain("fixture-volatile-recalled"), wait);
    expect(bodies).toHaveLength(3);
    expect(posts).toBe(1);
    expect(await saved(session)).toBeUndefined();
    await closeSocket(second.socket);
  },
);
