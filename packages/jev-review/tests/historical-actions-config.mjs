// Test-only reconstruction of the pre-trial historical settings. Never used by production.
export function historicalActionsConfig(raw) {
  const value = structuredClone(raw);
  value.targets = value.targets.filter(t => t.pullRequest !== 609);
  if (!value.targets.some(t => t.pullRequest === 536)) value.targets.push({ repository: 'roccho-org/ops', repositoryId: '1275606595', pullRequest: 536 });
  value.runRanges = value.runRanges.filter(r => r.target?.pullRequest !== 609 && r.target?.pullRequest !== 536);
  value.runRanges.splice(6, 0, { repository: 'roccho-org/ops', workflowId: 377399991, path: '.github/workflows/jev-issue-comment.yml', first: 104, last: 105, reservedCallsPerRun: 1, target: { pullRequest: 536 } });
  value.providedRequestTargets = [{ repository: 'roccho-org/ops', repositoryId: '1275606595', issue: 573 }];
  return value;
}
