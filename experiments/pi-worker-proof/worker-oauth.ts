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
