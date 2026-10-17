import { abortAllDurableObjects, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { OAuthCredential } from "@earendil-works/pi-ai";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bootstrapWorkerCredential, createWorkerModels, WorkerCredentialStore } from "../src/worker-oauth.ts";

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

async function connect(session: string) {
  const response = await exports.default.fetch(
    `https://example.com/api/sessions/${session}?username=Owner`,
    { headers: { Upgrade: "websocket" } },
  );
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  const messages: unknown[] = [];
  socket.addEventListener("message", (event) => { messages.push(JSON.parse(String(event.data))); });
  socket.accept();
  await vi.waitFor(() => expect(messages.length).toBeGreaterThanOrEqual(4), wait);
  return {
    socket,
    messages,
    submit: (requestId: string, content: string) =>
      socket.send(JSON.stringify({ type: "prompt.submit", conversationId: 1, requestId, content })),
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
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
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
  }));
  return { inference, rotations: () => rotations };
}

async function submissionStatus(session: string, requestId: string, expected: string) {
  await vi.waitFor(async () => {
    const status = await runInDurableObject(env.SESSIONS.getByName(session), async (_instance, state) => {
      const storage = await openDurableObjectSqliteStorage(state.storage);
      return (await storage.submissionByRequest(ROOT_CONVERSATION_ID, requestId, BACKGROUND_CONTEXT))?.status;
    });
    expect(status).toBe(expected);
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
    await evictDurableObject(env.SESSIONS.getByName(session));
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
    await evictDurableObject(env.SESSIONS.getByName(session));
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
    await evictDurableObject(env.SESSIONS.getByName(session));
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
    await evictDurableObject(env.SESSIONS.getByName(session));
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
