builtins.fromJSON ''
{
  "kind": "ops.packageImplementationMetadata.v1",
  "package": "ops-task-runtime",
  "repoId": "ops",
  "mission": "Materialize the portable task runtime accepted by roccho-dev/adrs#317.",
  "primaryTarget": "packages/ops-task-runtime",
  "requiredOutputs": "packages.<system>.ops-task-runtime",
  "requiredChecks": "checks.<system>.ops-task-runtime",
  "responsibility": "Preserve the legacy adrs#317 profile and carry an explicit opt-in local-event candidate proof under the current user task; candidate receipts do not admit a successor or change the default. Bind exact runtime identities and verify isolated Taskfile execution.",
  "forbiddenResponsibility": "Does not own task DAG meaning, add a scheduler, compile JSONL to YAML, or claim GitHub provider effects from local execution."
}
''
