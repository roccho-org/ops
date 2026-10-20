/** Owner-only finite proof. Never imported or executed by CI. */
import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import assert from "node:assert/strict";
import WebSocket from "ws";

async function run() {
const { values } = parseArgs({ options: {
  url: { type: "string" }, session: { type: "string" }, host: { type: "string" },
  cloudflared: { type: "string" }, idleSeconds: { type: "string", default: "180" },
} });
if (!process.stderr.isTTY || !values.url || !values.session || !values.host || !values.cloudflared) {
  throw new Error("Owner interactive terminal and url/session/host/cloudflared arguments required");
}
const origin = new URL(values.url);
assert.equal(origin.protocol, "https:");
assert.equal(origin.pathname, "/");
const idleSeconds = Number(values.idleSeconds);
assert.ok(Number.isInteger(idleSeconds) && idleSeconds >= 10 && idleSeconds <= 300);
// Standard owner CLI may use its supported local cache. Never print its JWT.
const accessJwt = execFileSync(values.cloudflared, ["access", "token", "--app", origin.origin],
  { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
delete process.env.PI_OAUTH_CALLBACK_HOST;
const { openaiChatGPTOAuth } = await import("./dist/oauth.mjs");
const abort = new AbortController();
process.once("SIGINT", () => abort.abort());
const credential = await openaiChatGPTOAuth.login({
  signal: abort.signal,
  notify(event) {
    if (event.type === "auth_url") process.stderr.write("Open in the owner browser (SSH local forward 1455 required):\n" + event.url + "\n");
  },
  prompt({ signal }) {
    return new Promise((_, reject) => {
      if (signal.aborted) reject(new Error("cancelled"));
      else signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
    });
  },
}, { getDeviceId: () => values.host });
const bearer = { token: credential.access, expires: credential.expires };
// No credential persistence, refresh, local model request or prompt proxy.
delete credential.access;
delete credential.refresh;
const catalogResponse = await fetch("https://api.openai.com/v1/models", {
  headers: { Authorization: "Bearer " + bearer.token }, redirect: "error", signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15_000)]),
});
assert.equal(catalogResponse.ok, true, "Account catalog unavailable; stop without retry");
const catalog = await catalogResponse.json();
assert.ok(Array.isArray(catalog.models) && catalog.models.some(model => model.visibility === "list" && model.slug === "gpt-6-luna"), "Configured model unavailable; separate model review required");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function connect() {
  assert.ok(bearer.expires > Date.now() + 30_000, "Access expired; stop without reauthentication/retry");
  const url = new URL("/api/sessions/" + values.session, origin);
  url.protocol = "wss:";
  const ws = new WebSocket(url, {
    headers: { Cookie: "CF_Authorization=" + accessJwt,
      "Pi-Proof-Access": bearer.token, "Pi-Proof-Expires": String(bearer.expires) },
    followRedirects: false, handshakeTimeout: 15_000,
  });
  const frames = [];
  let witness;
  ws.on("upgrade", response => { witness = {
    boot: response.headers["pi-proof-boot"], prior: response.headers["pi-proof-prior-token"],
    posts: Number(response.headers["pi-proof-posts"]),
  }; });
  ws.on("message", data => frames.push(JSON.parse(String(data))));
  await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", () => reject(new Error("Owner WebSocket rejected"))); });
  async function wait(predicate) {
    const end = Date.now() + 60_000;
    while (Date.now() < end) {
      const found = frames.find(predicate);
      if (found) return found;
      if (ws.readyState !== WebSocket.OPEN) throw new Error("Connection lost; outcome unknown");
      await delay(50);
    }
    throw new Error("Outcome unknown; do not resend");
  }
  await wait(frame => frame.type === "session.snapshot");
  return {
    witness, frames,
    async command(command) {
      ws.send(JSON.stringify(command));
      const result = await wait(frame => frame.type === "command.result" && frame.requestId === command.requestId);
      assert.equal(result.ok, true);
      return result;
    },
    async turn(conversationId, content) {
      const start = frames.length;
      const result = await this.command({ type: "prompt.submit", requestId: randomUUID(), conversationId, content });
      await wait(frame => frame.type === "conversation.events" &&
        frame.events.some(event => event.type === "run_end" && event.inputs.includes(result.submissionId)));
      const entries = new Map();
      for (const frame of frames.slice(start)) for (const event of frame.events ?? []) {
        if (event.type === "message_end" || event.type === "entry_appended") entries.set(event.entry.id, event.entry);
      }
      return [...entries.values()].flatMap(entry => entry.model ?? []);
    },
    close() {
      return new Promise(resolve => { ws.once("close", resolve); ws.close(1000, "finite proof"); });
    },
  };
}
function assistant(messages) {
  const reply = messages.filter(message => message.role === "assistant" && message.stopReason === "stop").at(-1);
  assert.ok(reply, "No completed new assistant reply");
  return reply.content.filter(part => part.type === "text").map(part => part.text).join("");
}
const first = await connect();
assert.equal(first.witness.posts, 0, "Fresh dedicated proof session required");
assert.equal(first.witness.prior, "false");
const created = await first.command({ type: "conversation.create", requestId: randomUUID() });
const marker = randomBytes(24).toString("hex");
const messages = await first.turn(created.conversationId,
  "Remember marker " + marker + ". Call ask_jev exactly once with state describing this finite memory experiment and one likelihood question. Use its actual assessment, then repeat the marker and assessment.");
const results = messages.filter(message => message.role === "toolResult" && message.toolName === "ask_jev");
assert.equal(results.length, 1);
assert.equal(results[0].isError, false);
const toolCalls = messages.filter(message => message.role === "assistant").flatMap(message => message.content).filter(part => part.type === "toolCall");
assert.equal(toolCalls.length, 1);
assert.equal(toolCalls[0].id, results[0].toolCallId);
const assessment = JSON.parse(results[0].content.filter(part => part.type === "text").map(part => part.text).join(""));
assert.equal(assessment.type, "noul");
assert.equal(typeof assessment.noul, "number");
assert.ok(Number.isFinite(assessment.noul));
const firstAnswer = assistant(messages);
assert.ok(firstAnswer.includes(marker) && firstAnswer.includes(String(assessment.noul)), "Pi did not consume marker and actual assessment");
await first.close();
// Early reconnect probes could themselves keep the object alive.
for (let elapsed = 0; elapsed < idleSeconds; elapsed += 10) await delay(Math.min(10, idleSeconds - elapsed) * 1000);
const reopened = await connect();
assert.ok(reopened.witness.boot !== first.witness.boot && reopened.witness.prior === "false",
  "NOT_PROVEN: independent new DO instance not observed; no second prompt sent");
assert.equal(reopened.witness.posts, 2);
await reopened.command({ type: "conversation.open", requestId: randomUUID(), conversationId: created.conversationId });
const recallMessages = await reopened.turn(created.conversationId,
  "Recall the marker and exact Jev assessment as its original typed object from our earlier exchange. Return only JSON with keys marker and assessment. Do not call tools.");
const recalled = assistant(recallMessages);
const parsed = JSON.parse(recalled);
assert.equal(parsed.marker, marker);
assert.deepEqual(parsed.assessment, assessment);
await reopened.close();
const receipt = await connect();
assert.equal(receipt.witness.posts, 3);
await receipt.close();
const completions = [...messages, ...recallMessages].filter(message => message.role === "assistant").map(message => ({
  responseId: message.responseId ?? null, model: message.model ?? null, stopReason: message.stopReason, rawStopReason: message.rawStopReason,
  sdkUsage: message.usage ? { input: message.usage.input, output: message.usage.output,
    totalTokens: message.usage.totalTokens } : null,
}));
assert.equal(completions.length, 3);
assert.deepEqual(completions.map(item => item.stopReason), ["toolUse", "stop", "stop"]);
assert.ok(completions.every(item => typeof item.responseId === "string" && item.responseId.length > 0 && item.rawStopReason === "completed"));

console.log(JSON.stringify({ completions, scope: "ACTUAL_WORKER_FINITE_PROOF", session: values.session,
  conversationId: created.conversationId, selectedModel: "gpt-6-luna", accountCatalogVerified: true, userTurns: 2, responsesPostAttempts: 3, providerBillingUsage: "NOT_INDEPENDENTLY_VERIFIED",
  successfulJevToolResults: 1, recreated: true, priorTokenAbsent: true,
  markerSha256: createHash("sha256").update(marker).digest("hex"), assessment,
  recallMatched: true, noClientHistoryReinjection: true }));
}
run().catch(() => { console.error(JSON.stringify({ scope: "FINITE_WORKER_PROOF", status: "STOPPED_NOT_PROVEN", noAutomaticResend: true })); process.exit(1); });
