export interface JevProvider {
  readonly available: boolean;
  post(body: unknown, options?: { signal?: AbortSignal; deadlineMs?: number }): Promise<unknown>;
}
export function bindJev(options?: { apiKey?: string; fetch?: typeof globalThis.fetch }): JevProvider;
export function askJevQuestions(options: {
  state: string;
  questions: Record<string, { type: "noul"; instructions: string }>;
  provider: JevProvider;
  signal?: AbortSignal;
  deadlineMs?: number;
}): Promise<{ model: string; answers: Record<string, { type: "noul"; noul: number }> }>;
