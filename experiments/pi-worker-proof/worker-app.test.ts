import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { OAuthCredential } from "@earendil-works/pi-ai";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { describe, expect, it, vi } from "vitest";
import { createWorkerModels, WorkerCredentialStore } from "../src/worker-oauth.ts";

const fixture = (): OAuthCredential =>
  JSON.parse((env as unknown as { PI_PROOF_AUTH: string }).PI_PROOF_AUTH);
const wait = { timeout: 2_000, interval: 20 };

async function seed(session: string, credential: OAuthCredential) {
  console.info("fixture-stage", session, "seed");
  const stub = env.SESSIONS.getByName(session);
  await runInDurableObject(stub, async (_instance, state) => {
    await state.blockConcurrencyWhile(async () => {});
    await new WorkerCredentialStore(state.storage).modify("openai", async () => credential);
  });
  await evictDurableObject(stub);
  console.info("fixture-stage", session, "seeded-and-evicted");
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
  console.info("fixture-stage", session, "connected");
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
    id: "fixture-message",
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  const response = {
    id: "fixture-response",
    object: "response",
    created_at: 1,
    model: "gpt-6-luna",
    status: "completed",
    output: [item],
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
    // Both installed transports supply URL + RequestInit. Inspect their bytes
    // directly: creating a Request introduces an unrelated workerd body stream.
    if (input instanceof Request) throw new Error("Unexpected Request transport: inspect the pinned SDK seam");
    const url = String(input);
    expect(init?.method).toBe("POST");
    const rawBody = String(init?.body ?? "");
    if (url === "https://auth.openai.com/api/accounts/oauth/token") {
      rotations++;
      console.info("fixture-stage", "refresh-request");
      const body = new URLSearchParams(rawBody);
      expect(body.get("grant_type")).toBe("refresh_token");
      expect(body.get("client_id")).toBe(fixture().clientId);
      expect(body.get("refresh_token")).toBe(fixture().refresh);
      expect(body.get("resource")).toBe("https://api.openai.com/v1");
      if (revoked) return new Response("fixture-invalid-grant", { status: 401 });
      console.info("fixture-stage", "refresh-response");
      return Response.json({
        access_token: "fixture-access-rotated",
        refresh_token: "fixture-refresh-rotated",
        expires_in: 3600,
        scope: "chatgpt.tokens.use.direct",
      });
    }
    expect(url).toBe("https://api.openai.com/v1/responses");
    const body: unknown = JSON.parse(rawBody);
    expect(body).toMatchObject({ stream: true, model: "gpt-6-luna" });
    inference.push({ authorization: new Headers(init?.headers).get("authorization"), body });
    console.info("fixture-stage", "inference-request");
    const reply = replies.shift();
    if (reply === undefined) throw new Error("Unexpected extra mock inference");
    return responseStream(reply);
  }));
  return { inference, rotations: () => rotations };
}

async function unanswered(session: string, requestId: string) {
  await vi.waitFor(async () => {
    const status = await runInDurableObject(env.SESSIONS.getByName(session), async (_instance, state) => {
      const storage = await openDurableObjectSqliteStorage(state.storage);
      return (await storage.submissionByRequest(ROOT_CONVERSATION_ID, requestId, BACKGROUND_CONTEXT))?.status;
    });
    expect(status).toBe("unanswered");
  }, wait);
}

describe("real Worker app path with synthetic OAuth and mocked remote responses", () => {
  it("completes chat, persists rotation, evicts the DO, and continues the same conversation", async () => {
    const session = "oauth-app-resume";
    await seed(session, { ...fixture(), expires: 0 });
    const remote = mockRemote(["fixture-first-answer", "fixture-second-answer"]);
    const first = await connect(session);
    first.submit("oauth-first", "Remember fixture-plan");
    await vi.waitFor(() => {
      expect(JSON.stringify(first.messages)).toContain("fixture-first-answer");
      expect(JSON.stringify(first.messages)).toContain('"stopReason":"stop"');
    }, wait);
    console.info("fixture-stage", session, "first-answer");
    expect(await saved(session)).toMatchObject({ access: "fixture-access-rotated", refresh: "fixture-refresh-rotated" });
    first.socket.close(1000, "recreate");
    await evictDurableObject(env.SESSIONS.getByName(session));

    const second = await connect(session);
    expect(JSON.stringify(second.messages)).toContain("fixture-first-answer");
    expect(JSON.stringify(second.messages)).toContain("Remember fixture-plan");
    second.submit("oauth-second", "Continue fixture-plan");
    await vi.waitFor(() => expect(JSON.stringify(second.messages)).toContain("fixture-second-answer"), wait);
    expect(remote.rotations()).toBe(1);
    expect(remote.inference).toHaveLength(2);
    expect(remote.inference.map((item) => item.authorization)).toEqual([
      "Bearer fixture-access-rotated", "Bearer fixture-access-rotated",
    ]);
    const history = JSON.stringify(remote.inference[1].body);
    for (const text of ["Remember fixture-plan", "fixture-first-answer", "Continue fixture-plan"]) {
      expect(history).toContain(text);
    }
    const publicFrames = JSON.stringify([...first.messages, ...second.messages]);
    for (const token of [fixture().access, fixture().refresh, "fixture-access-rotated", "fixture-refresh-rotated"]) {
      expect(publicFrames).not.toContain(token);
    }
    second.socket.close(1000, "complete");
    await evictDurableObject(env.SESSIONS.getByName(session));
    const third = await connect(session);
    expect(JSON.stringify(third.messages)).toContain("fixture-second-answer");
    expect(JSON.stringify(third.messages)).toContain('"stopReason":"stop"');
    expect(await saved(session)).toMatchObject({ refresh: "fixture-refresh-rotated" });
    third.socket.close(1000, "verified");
  });

  it("does not infer or invent credentials when the app's DO has no grant", async () => {
    const session = "oauth-app-missing";
    const client = await connect(session);
    client.submit("missing-grant", "Do not bill an API key");
    await unanswered(session, "missing-grant");
    expect(fetch).not.toHaveBeenCalled();
    expect(await saved(session)).toBeUndefined();
    client.socket.close(1000, "verified");
  });

  it("fails closed on revoked refresh and preserves state across recreation", async () => {
    const session = "oauth-app-revoked";
    const expired = { ...fixture(), expires: 0 };
    await seed(session, expired);
    const remote = mockRemote([], true);
    const client = await connect(session);
    client.submit("revoked-grant", "Do not fall back");
    await unanswered(session, "revoked-grant");
    expect(remote.rotations()).toBe(1);
    expect(remote.inference).toHaveLength(0);
    expect(await saved(session)).toEqual(expired);
    client.socket.close(1000, "recreate");
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
      console.info("fixture-stage", session, "both-auth-results");
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
        await expect(createWorkerModels(state.storage).getAuth("openai")).rejects.toMatchObject({
          cause: { message: "fixture-write-failure" },
        });
        expect(write).toHaveBeenCalledTimes(1);
      } finally {
        write.mockRestore();
      }
    });
    expect(remote.rotations()).toBe(1);
    expect(remote.inference).toHaveLength(0);
    expect(await saved(session)).toEqual(expired);
  });
});
