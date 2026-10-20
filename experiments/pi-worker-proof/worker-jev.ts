import { Type } from "@earendil-works/pi-ai";
import { defineDoc, type ToolRegistration } from "@earendil-works/pi-durable";
import { askJevQuestions, bindJev, type JevProvider } from "./jev-client/client.mjs";

// Experiment only: one admission per conversation, persisted by the Harness.
export const JevProofAttempt = defineDoc<{ consumed: boolean }>({
  kind: "pi.proof.jev.attempt",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({ consumed: false }),
});

export function createJevProofTool(provider: JevProvider) {
  return {
    name: "ask_jev",
    description: "Ask Jev for one typed likelihood assessment of supplied state. This proof permits one attempt per conversation.",
    parameters: Type.Object({
      state: Type.String({ minLength: 1, maxLength: 4096 }),
      question: Type.String({ minLength: 1, maxLength: 512 }),
    }, { additionalProperties: false }),
    replay: "unsafe",
    execute: async ({ state, question }: { state: string; question: string }, api, context) => {
      // Check public binding metadata before consuming the experimental allowance.
      if (!provider.available) return stopped("JEV_AUTH_MISSING");
      const admitted = await api.commit(async (tx) => {
        const attempt = await tx.doc(JevProofAttempt, api.conversationId);
        if (attempt.consumed) return false;
        attempt.consumed = true;
        return true;
      }, context);
      if (!admitted) return stopped("JEV_PROOF_ATTEMPT_CONSUMED");
      try {
        const result = await askJevQuestions({
          state, questions: { assessment: { type: "noul", instructions: question } },
          provider, signal: context.abortSignal, deadlineMs: 10_000,
        });
        // Emit only the canonical decoder's fixed-shape numeric assessment.
        const answer = result.answers.assessment;
        // output, unlike structuredOutput alone, is committed to the transcript.
        return { output: [{ type: "text" as const, text: JSON.stringify(answer) }] };
      } catch {
        // Provider acceptance/charging may already have happened. Never expose raw
        // provider errors, restore the allowance, or automatically retry.
        return stopped("JEV_OUTCOME_UNKNOWN: proof stopped; do not retry.");
      }
    },
  } satisfies ToolRegistration;
}

function stopped(code: string) {
  return {
    output: [{ type: "text" as const, text: code }],
    isError: true,
    control: { terminate: true as const },
  };
}

// Server binding only: no model argument can set a key, provider, URL or model.
export function bindJevProof(apiKey?: string) {
  return apiKey ? createJevProofTool(bindJev({ apiKey })) : undefined;
}
