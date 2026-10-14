builtins.fromJSON ''
{
  "kind": "ops.packageImplementationMetadata.v1",
  "package": "ops-package-contract-bridge",
  "repoId": "ops",
  "mission": "Bind accepted compiler packets, repository claims, observations, combined source relations, and receipts to provenance-preserving evidence without owning semantic current or admission.",
  "primaryTarget": "packages/ops-package-contract-bridge",
  "requiredOutputs": "packages.<system>.ops-package-contract-bridge",
  "requiredChecks": "checks.<system>.ops-package-contract-bridge and checks.<system>.ops-package-contract-bridge-phase1; exact Phase 1 and Phase 2 v5 bundle jobs in .github/workflows/contract-632-phase1.yml",
  "responsibility": "Validate Phase 1 compiler bundles and Phase 2 direct-package coverage only from combined relation-valid assertions while reusing accepted Governance and existing Ops cores.",
  "forbiddenResponsibility": "Does not choose semantic winners, supersession, organization applicability, required status, admission, Gate outcome, provider effect, Gov Release, merge, or operational adoption."
}
''