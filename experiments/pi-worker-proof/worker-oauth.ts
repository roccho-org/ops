import {
  createModels,
  type AuthOperationOptions,
  type Credential,
  type CredentialStore,
} from "@earendil-works/pi-ai";
import type { Provider } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openaiChatGPTOAuth } from "pi-proof-openai-oauth";
import { KeyedSerialQueue } from "./serial.ts";

const PREFIX = "pi.oauth.v1:";
const BOOTSTRAP_RECEIPT = "pi.oauth.bootstrap.v1";

/** Called inside the Session's existing blockConcurrencyWhile, before Harness.open.
 * The optional binding is an operator-provided secret, never a browser command.
 * Its one-time receipt prevents an old binding resurrecting a deleted credential.
 */
export async function bootstrapWorkerCredential(
  ctx: DurableObjectState,
  env: Pick<Env, "SESSIONS"> & { PI_CHATGPT_BOOTSTRAP?: string },
): Promise<void> {
  const raw = env.PI_CHATGPT_BOOTSTRAP;
  if (!raw || await ctx.storage.get(BOOTSTRAP_RECEIPT)) return;
  const invalid = () => new Error("Invalid Pi subscription bootstrap");
  let input: unknown;
  try { input = JSON.parse(raw); } catch { throw invalid(); }
  if (typeof input !== "object" || input === null || !("session" in input) ||
      typeof input.session !== "string" || input.session.length === 0) throw invalid();
  // One rotating grant has exactly one owner DO, even with many conversations.
  if (env.SESSIONS.idFromName(input.session).toString() !== ctx.id.toString()) return;
  if (!("credential" in input) || typeof input.credential !== "object" || input.credential === null) throw invalid();
  const credential = input.credential as Record<string, unknown>;
  if (credential.type !== "oauth" ||
      ![credential.access, credential.refresh, credential.clientId].every((value) => typeof value === "string" && value.length > 0) ||
      typeof credential.expires !== "number" || !Number.isFinite(credential.expires) || credential.expires < 0 ||
      !Array.isArray(credential.scopes) || !credential.scopes.includes("chatgpt.tokens.use.direct")) throw invalid();
  const key = PREFIX + "openai";
  const current = await ctx.storage.get<Credential>(key);
  // A single storage put atomically records both the credential and consumption.
  await ctx.storage.put({ [key]: current ?? credential, [BOOTSTRAP_RECEIPT]: true });
}

/** One grant owner per Session DO. Never copy one rotating grant into several DOs. */
export class WorkerCredentialStore implements CredentialStore {
  readonly #storage: DurableObjectStorage;
  readonly #writes = new KeyedSerialQueue<string>();

  constructor(storage: DurableObjectStorage) {
    this.#storage = storage;
  }

  async read(providerId: string, options?: AuthOperationOptions) {
    options?.signal?.throwIfAborted();
    return this.#storage.get<Credential>(PREFIX + providerId);
  }

  async list(options?: AuthOperationOptions) {
    options?.signal?.throwIfAborted();
    const entries = await this.#storage.list<Credential>({ prefix: PREFIX });
    return [...entries].map(([key, credential]) => ({
      providerId: key.slice(PREFIX.length),
      type: credential.type,
    }));
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    return this.#writes.run(providerId, async () => {
      const current = await this.read(providerId, options);
      const next = await fn(current);
      // Persist a rotated grant before releasing it to a model request. Do not
      // discard an already-issued rotation merely because cancellation arrived.
      if (next !== undefined) await this.#storage.put(PREFIX + providerId, next);
      return next ?? current;
    });
  }

  async delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    await this.#writes.run(providerId, async () => {
      options?.signal?.throwIfAborted();
      await this.#storage.delete(PREFIX + providerId);
    });
  }
}

/** Runtime composition, not an OAuth implementation or a credential HTTP endpoint. */
export function createWorkerModels(storage: DurableObjectStorage) {
  const models = createModels({
    credentials: new WorkerCredentialStore(storage),
    authContext: {
      env: async () => undefined,
      fileExists: async () => false,
    },
  });
  const provider = openaiProvider();
  // An absent/revoked subscription must not silently become billed API usage.
  models.setProvider({ ...provider, auth: { oauth: openaiChatGPTOAuth } });
  return models;
}

export type ProofEnvironment = {
  PI_JEV_PROOF_SESSION?: string;
  PI_JEV_PROOF_API_KEY?: string;
  PI_PROOF_TRANSIENT?: string;
  PI_ACCESS_ISSUER?: string;
  PI_ACCESS_AUDIENCE?: string;
  PI_ACCESS_OWNER_HASH?: string;
};

type AttemptTrace = { attempt: number | null; httpStatus: number | null; outcome: "NOT_SENT" | "HTTP" | "TRANSPORT" };

/** Finite owner proof only. Credentials live in this instance, never storage. */
export class TransientWorkerProof {
  readonly bootId = crypto.randomUUID();
  #access?: { token: string; expires: number };
  readonly #terminalTraces = new WeakMap<object, AttemptTrace>();
  readonly storage: DurableObjectStorage;
  constructor(storage: DurableObjectStorage) { this.storage = storage; }

  get tokenPresent() { return this.#access !== undefined && this.#access.expires > Date.now(); }

  async attach(request: Request, env: ProofEnvironment) {
    const { verifyAccessOwner } = await import("pi-proof-auth");
    await verifyAccessOwner(request.headers.get("Cf-Access-Jwt-Assertion") ?? "", {
      issuer: env.PI_ACCESS_ISSUER ?? "", audience: env.PI_ACCESS_AUDIENCE ?? "",
      subjectHash: env.PI_ACCESS_OWNER_HASH ?? "",
    });
    const priorToken = this.tokenPresent;
    const token = request.headers.get("Pi-Proof-Access");
    const expires = Number(request.headers.get("Pi-Proof-Expires"));
    if (!token || token.startsWith("sk-") || !Number.isFinite(expires) ||
        expires <= Date.now() + 30_000 || expires > Date.now() + 3_600_000) {
      throw new Error("Fresh ChatGPT access required");
    }
    this.#access = { token, expires };
    return { "Pi-Proof-Boot": this.bootId, "Pi-Proof-Prior-Token": String(priorToken), "Pi-Proof-Posts": String(await this.counts()) };
  }

  async counts() { return await this.storage.get<number>("pi.proof.responses.posts") ?? 0; }

  #bearer() {
    if (!this.tokenPresent) { this.#access = undefined; throw new Error("Fresh ChatGPT access required"); }
    return this.#access!.token;
  }

  // The per-stream closure is never a shared "latest outcome".
  async #request(input: RequestInfo | URL, init?: RequestInit, trace?: AttemptTrace) {
    this.#bearer();
    const request = new Request(input, init);
    if (request.url !== "https://api.openai.com/v1/responses" || request.method !== "POST") {
      throw new Error("Proof transport rejected");
    }
    const attempt = await this.storage.transaction(async tx => {
      const count = await tx.get<number>("pi.proof.responses.posts") ?? 0;
      if (count >= 4) throw new Error("Proof physical request budget consumed");
      await tx.put("pi.proof.responses.posts", count + 1);
      return count + 1;
    });
    if (trace) trace.attempt = attempt;
    // Count before send: an UNKNOWN result is never refunded.
    try {
      const response = await globalThis.fetch(request, { redirect: "error" });
      if (trace) { trace.httpStatus = response.status; trace.outcome = "HTTP"; }
      return response;
    } catch {
      if (trace) trace.outcome = "TRANSPORT";
      throw new Error("Proof transport failed");
    }
  }

  readonly fetch: typeof fetch = (input, init) => this.#request(input, init);

  failureMetadata(message: object): string {
    const trace = this.#terminalTraces.get(message);
    return JSON.stringify({ scope: "PI_PROOF_PROVIDER_FAILURE", version: 1,
      attempt: trace?.attempt ?? null, httpStatus: trace?.httpStatus ?? null,
      outcome: trace?.outcome ?? "UNKNOWN" });
  }

  models() {
    const models = createModels({ authContext: { env: async () => undefined, fileExists: async () => false } });
    const base: Provider = openaiProvider();
    const options = <T,>(input: T, trace: AttemptTrace) => ({
      ...input, maxRetries: 0, timeoutMs: 20_000, transport: "sse" as const,
      fetch: (input: RequestInfo | URL, init?: RequestInit) => this.#request(input, init, trace),
      onProviderStreamEvent: (raw: unknown) => {
        const event = raw as { type?: string; response?: { status?: string; id?: string } };
        if (event.type === "response.incomplete" || (event.type === "response.completed" &&
            (event.response?.status !== "completed" || typeof event.response.id !== "string" || event.response.id.length === 0))) {
          throw new Error("Proof requires an actual completed provider response");
        }
      },

      onPayload: (raw: unknown) => {
        const payload = raw as Record<string, unknown>;
        if (payload.store !== false || payload.stream !== true || payload.previous_response_id !== undefined ||
            !Array.isArray(payload.input)) throw new Error("Unsupported proof wire shape");
        for (const message of payload.input as Record<string, unknown>[]) {
          if (message.role === "system") message.role = "developer";
        }
        if (payload.tools !== undefined) {
          payload.input.unshift({ type: "additional_tools", role: "developer", tools: payload.tools });
          delete payload.tools;
        }
        return payload;
      },
    });
    const associate = <T extends { result(): Promise<object> }>(stream: T, trace: AttemptTrace): T => {
      // Register before returning to Models.lazyStream/Harness. Their terminal object
      // is forwarded by identity. No detached rejection may expose SDK diagnostics.
      void stream.result().then(message => {
        if (message !== null && typeof message === "object") this.#terminalTraces.set(message, { ...trace });
      }).catch(() => { /* association absent => UNKNOWN */ });
      return stream;
    };
    models.setProvider({
      ...base,
      auth: { apiKey: { name: "Transient validated ChatGPT OAuth access", resolve: async () =>
        ({ auth: { apiKey: this.#bearer() }, source: "owner-transient-oauth" }) } },
      stream: (model, context, config) => {
        const trace: AttemptTrace = { attempt: null, httpStatus: null, outcome: "NOT_SENT" };
        return associate(base.stream(model, context, options(config, trace)), trace);
      },
      streamSimple: (model, context, config) => {
        const trace: AttemptTrace = { attempt: null, httpStatus: null, outcome: "NOT_SENT" };
        return associate(base.streamSimple(model, context, options(config, trace)), trace);
      },
    });
    return models;
  }
}
