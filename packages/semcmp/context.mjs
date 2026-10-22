import { createHash } from 'node:crypto';
import { semcmp } from './semcmp.mjs';

// Caller supplies an authorized current snapshot and its exact Input/State/Focus.
// No IO, reducer, second ranker, key, retry, selection or effect belongs here.
export async function compareContext(queryJson, currentJsonl, { ask } = {}) {
  if (typeof queryJson !== 'string' || typeof currentJsonl !== 'string'
      || Buffer.byteLength(queryJson) > 28000 || Buffer.byteLength(currentJsonl) > 524288)
    throw new Error('INVALID_CONTEXT_INPUT');
  const query = JSON.parse(queryJson);
  const rows = currentJsonl.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line));
  if (rows.length > 64 || rows.some(row => !row || typeof row !== 'object' || Array.isArray(row)
      || !['id', 'meaning', 'representation'].every(key => Object.hasOwn(row, key))
      || Object.keys(row).some(key => !['id', 'meaning', 'representation', 'detail'].includes(key))))
    throw new Error('INVALID_CURRENT_ROWS');
  // Bind both query and supplied catalog, not the transient list index.
  const requestId = createHash('sha256').update(JSON.stringify([queryJson, currentJsonl])).digest('hex');
  const details = new Map(rows.map(row => [row.id, row.detail ?? null]));
  const result = await semcmp(query, {
    propose: async () => rows.map(({ id, meaning, representation }) => ({ id, meaning, representation })),
    ask,
  });
  return {
    requestId, ...result,
    proposals: result.proposals.map(proposal => ({ ...proposal, detail: details.get(proposal.id) })),
  };
}
