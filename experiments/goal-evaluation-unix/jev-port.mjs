import { askJevQuestions } from '../../packages/jev/src/client.mjs';

// Caller composition only: Core owns the native three-label contract. The
// provider owns transport; this adapter reads no credentials or environment.
// mode is caller-declared provenance, not proof of actual model use. A finite
// deadline is passed to the provider; bindJev implements its abort/timeout.
export function bindJevChoicePort({ id, mode, provider, deadlineMs, signal } = {}) {
  if (typeof id !== 'string' || !id.trim() || !['live', 'test-double'].includes(mode)
    || provider?.available !== true || typeof provider.post !== 'function'
    || !Number.isSafeInteger(deadlineMs) || deadlineMs <= 0 || deadlineMs > 2_147_483_647) {
    throw new Error('INVALID_JEV_PORT');
  }
  return Object.freeze({
    id, mode,
    async which({ text, instructions, criteria }) {
      const { model, answers } = await askJevQuestions({
        state: text,
        questions: { answer: { type: 'choice', instructions, criteria } },
        provider, signal, deadlineMs,
      });
      // Confidence/probabilities are not explanations or verified support.
      return { label: answers.answer.choice, model, rationale: null };
    },
  });
}
