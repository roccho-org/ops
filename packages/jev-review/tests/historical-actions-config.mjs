// Test-only reconstruction of the pre-trial historical settings. Never used by production.
export function historicalActionsConfig(raw) {
  const value = structuredClone(raw);
  value.targets = value.targets.filter(t => !Object.hasOwn(t, 'pullRequest') || t.pullRequest === 511);
  if (!value.targets.some(t => t.pullRequest === 536)) value.targets.push({ repository: 'roccho-org/ops', repositoryId: '1275606595', pullRequest: 536 });
  // The W2 origin Issue 640 (roccho-dev/adrs#635 comment 6316499931) postdates these controls, like PR629 above.
  // The case-2 origin Issue 642 and the cycle-2 origins 647-654 postdate them too.
  value.targets = value.targets.filter(t => t.issue !== 640 && t.issue !== 642 && !(t.issue >= 647 && t.issue <= 654));
  value.runRanges = value.runRanges.filter(r => !Object.hasOwn(r.target ?? {}, 'pullRequest') && r.target?.issue !== 640 && r.target?.issue !== 642 && !(r.target?.issue >= 647 && r.target?.issue <= 654));
  value.runRanges.splice(6, 0, { repository: 'roccho-org/ops', workflowId: 377399991, path: '.github/workflows/jev-issue-comment.yml', first: 104, last: 105, reservedCallsPerRun: 1, target: { pullRequest: 536 } });
  value.providedRequestTargets = [{ repository: 'roccho-org/ops', repositoryId: '1275606595', issue: 573 }];
  return value;
}
