import {
  createModels,
  type AuthOperationOptions,
  type Credential,
  type CredentialStore,
} from "@earendil-works/pi-ai";
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
