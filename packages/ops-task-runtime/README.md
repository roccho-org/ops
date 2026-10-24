# ops-task-runtime

Authority: `roccho-dev/adrs#317`.

## Opt-in ghalet candidate (GHALET-v2.1)

This is a narrow candidate for explicit local CLI/Agent requests, through existing
`gh workflow run`, GitHub's queue, Songmu/ghalet and two official runners on one
Linux amd64 host. GitHub remains the control plane. It checks the existing legacy
native E2E suite (one positive and two negative child checks); it does not execute
actrun, replace the DAG, retire gosh,
adopt a successor to #317, or complete #675. PR663/EE3 is preserved history.

The separate `ghalet/sources.json` pins official whole archives and observed
binaries. Retain the upstream LICENSE/NOTICE files with acquired distributions.
Use the existing portable-runtime-pack owner and Carrier transport unchanged;
commit no archives, generated sources, closure trees or credentials here.
Upstream ghalet owns runner acquisition/hash checking, JIT, state and cleanup.

### Prepared host and explicit invocation

Evaluate `ghalet/host.nix { pkgs = ...; }` with pkgs imported from
`flake.lock.nodes[flake.lock.nodes.root.inputs.nixpkgs].locked` (currently
`nixpkgs_2`), not another lock node. The small FHS adapter supplies native
Node/Git/gh and OS prerequisites. Run the actual ghalet daemon, management commands
and runner descendants inside this SAME profile with the SAME absolute config.
Do not use the host Listener version failure on NixOS, or its successful FHS
version probe, as evidence of a working ScaleSet.

Example within the prepared FHS shell, after separately authorized live setup:

```sh
export STATE_DIRECTORY=/absolute/task-owned/state
export CACHE_DIRECTORY=/absolute/task-owned/cache
/absolute/verified/ghalet config validate -config /absolute/candidate.yaml
/absolute/verified/ghalet run -config /absolute/candidate.yaml
# In a second shell in the identical profile/config:
/absolute/verified/ghalet status -config /absolute/candidate.yaml -fail-on-error
```

Use dedicated task-owned state/cache/log paths; never reuse another daemon's
domain. The example has domain max2 and target min0/max2. This is not a host-wide
semaphore. Runner environment does not inherit controller environment; explicit
PATH selects the FHS tools. Job steps allocate individual HOME/TMP/output paths.
Same-UID processes remain trusted, not isolated adversaries.

Existing `credential.type: gh` requires usable management authorization in the
actual daemon user's gh context. Do not extract/copy credentials, force a new App,
or infer this authority from Windows gh or a job GITHUB_TOKEN. Authentication,
ScaleSet creation and service/permission changes are not granted by source GO.

The existing release workflow adds an explicit `ghalet_candidate=true` dispatch,
`event_id` and exact `source_commit`. Candidate dispatch suppresses legacy build;
publish still requires a proposals push. Normal PR/push/default dispatch behavior
is preserved. Input values enter environment variables, never shell source.
Check that GitHub can dispatch the branch's existing workflow before live proof;
a missing run after an ambiguous dispatch is UNKNOWN, not permission to resend.

### Evidence contract and current missing proof

`OPS_TASK_CI_TIMING` optionally writes an absent-only `ops.taskRuntimeE2ETiming/1`
file around the existing E2E suite body: immediately before its first positive
child through its two negative checks and finally cleanup. Child startup, copies,
mutations and cleanup are real suite work. Outer Node startup, producer metadata
reads/hash, stdout/evidence writes, rendezvous and holds are excluded. The bin is
byte-identical to base83; default suite stdout/behavior and expected negative child
exits remain unchanged. Every child must finish normally: positive exit0, each
negative exit1. Spawn errors, signals, null/missing status and other exit codes
are suite failures, not negative-check success. Exceptions including cleanup
failures make the suite fail.
A full artifact must include exit/result, timing and provider/source/
runtime/runner binding, independently compared with external expectations.

`node tests/ghalet-proof.mjs --selftest` tests the finite evidence validator and
the actual suite producer using test-local child_process patches/dynamic imports.
It checks a controlled normal 0/1/1 trace and26 injected child faults, observes
failure timing, and restores builtin exports/stdout/env in finally. This is local
fault-injection proof, not execution of real runner jobs or real child processes.
`node tests/ghalet-proof.mjs EXPECTED OBSERVED` checks two externally bound success
intervals on one host boot. Its scoped PASS is NOT the composed live gate.
The version3 expectation/observation schemas distinguish artifact `jobKey`
(`GITHUB_JOB`, always `ghalet-native-check`) from provider numeric `jobId`.
Expected jobs contain event/source/tree/ref/workflowRef/runtime/run/jobKey/jobId/
attempt/runner/runnerId/root/nodePath strings. Observations retain those artifact
fields and add exitCode, the entire fixed E2E receipt
(`ops.taskRuntimeE2E/1`, PASS, positive1, negative2), timing, per-job
hostBootId, pre/post clean checkout records, providerRuns and providerJob.
Provider numeric IDs must come from independent GETs, never overwrite the
artifact's logical key, and join run/attempt/jobKey/runner. Independent dispatches
require distinct run IDs. Source/tree/ref/workflowRef and the actual check Node
bytes must match external expectations, not just mutually consistent artifacts.

The timing producer itself records PID/startTicks, Node path/SHA256, root and host boot ID
before starting the suite interval. Existing children use the same process.execPath;
their individual overlap is not measured or claimed. Post-check binding uses that producer's
identity, not the hash of a later Node process. Pre/post checkout checks require
the exact clean source/tree. This is observation within the trusted same-UID
boundary, not protection from adversarial mutation.

Candidate runs have provider-visible `run-name: ghalet:<event_id>` before artifact
creation. Legacy runs retain execution routing; their display metadata uses
commit message/PR title or the workflow-name fallback. The pure `identifyRun`
helper joins marker/source/branch/workflow-path/attempt, returning HOLD for zero
or multiple candidates, never retry permission. Retain raw provider GETs:
providerRuns uses id/run_attempt/display_title/head_sha/head_branch/path/status/
conclusion; providerJob uses id/run_id/run_attempt/name/runner_name/runner_id/
status/conclusion. This fixed job has no matrix/name override.
Actual runner/runtime bytes must still be independently verified for the composed
gate; local artifacts alone cannot authenticate their claims.

Required live closure remains: actual CLI dispatch and collection; two real check
suite intervals overlapping (no observation means Missing); third demand after two
managed executions occupy capacity, max2 and eventual collection without FIFO
assumptions; failure, queue/rendezvous cancellation and running fixture cancellation
as distinct phases; source/runtime/event/run/job/attempt/runner bindings; complete
artifact and independent provider readback. Holds/sleeps are fixture phases, never
suite overlap or suite cancellation. UNKNOWN absence cannot replay. Old static
receipt/timing evidence is rejected and cannot be relabeled as this new metric.

No live proof exists in this initial slice. Final technical acceptance requires
independent R's exact-head composed gate. User permission, R verdict and User
acceptance are separate. No merge, deploy, Issue close or default cutover is implied.
