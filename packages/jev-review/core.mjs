export const JEV_MODEL = 'jev-1.14.0';
export const JEV_PROVIDER_TOKEN_BUDGET_POLICY = 'provider-token-admission-v1';
export const JEV_PROVIDER_REQUEST_MAX_BYTES = 65536;

export function validateJevBudget(state, questions, policy) {
  if (policy !== undefined && policy !== JEV_PROVIDER_TOKEN_BUDGET_POLICY) throw new Error('INVALID_JEV_BUDGET_POLICY');
  const stateBytes = Buffer.byteLength(JSON.stringify(state), 'utf8');
  const questionValues = Object.values(questions ?? {});
  const questionBytes = questionValues.map((question) => Buffer.byteLength(JSON.stringify(question), 'utf8'));
  const longestQuestionBytes = questionBytes.length === 0 ? 0 : Math.max(...questionBytes);
  const allQuestionsBytes = questionBytes.reduce((sum, value) => sum + value, 0);
  if (policy === JEV_PROVIDER_TOKEN_BUDGET_POLICY) {
    const requestBytes = Buffer.byteLength(JSON.stringify({ model: JEV_MODEL, state, questions }), 'utf8');
    if (requestBytes > JEV_PROVIDER_REQUEST_MAX_BYTES) throw new Error('JEV_REQUEST_BYTE_LIMIT');
    return { stateBytes, longestQuestionBytes, allQuestionsBytes, requestBytes,
      tokenAdmission: 'UNKNOWN_LOCALLY_PROVIDER_ENFORCED' };
  }
  if (stateBytes > 28000) throw new Error(`Jev state budget exceeded: ${stateBytes} bytes`);
  if (stateBytes + longestQuestionBytes > 31000) throw new Error(`Jev state+question budget exceeded: ${stateBytes + longestQuestionBytes} bytes`);
  if (stateBytes + allQuestionsBytes > 60000) throw new Error(`Jev request budget exceeded: ${stateBytes + allQuestionsBytes} bytes`);
  return { stateBytes, longestQuestionBytes, allQuestionsBytes };
}
