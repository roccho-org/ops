# ops-task-runtime

Authority: `roccho-dev/adrs#317`.

The legacy `source.json`, `workflow.yml`, and `ci` task retain the #317 gosh
profile. `candidate requests` is an explicit opt-in proof under the current
2026-10-24 user task (SAME-v5.1); it is not an accepted successor, default change,
or completion of #463 / #675. No global gosh retirement is included.

The candidate CLI accepts an `ops.taskCandidateRequests/1` JSON request batch
with `eventId`, canonical `inputBase64`, `mode` (`success` / `failure`) and
`route` (`direct` / `actrun`). It requires `--repo`, `--request-file`,
`--runtime-manifest`, and a new `--evidence-dir`. The runtime manifest schema is
`ops.taskCandidateRuntime/1`, with exact absolute `path` and `sha256` for
`tools.node`, `python`, `task`, `actrun`, and `shell`. Run it using the bound Node:

```text
node bin/ops-task-runtime.mjs candidate requests --repo REPO \
  --request-file REQUESTS --runtime-manifest RUNTIME --evidence-dir NEW_DIR
node candidate/readback.mjs NEW_DIR
```

One finite invocation admits at most two requests and explicitly refuses excess
requests without queueing. Independent invocations have no global semaphore.
Accepted inputs are bound to a clean Git commit/tree and copied package bytes.
Each attempt owns snapshot, work, tmp, home and output paths. Snapshot/copy hashes
are checked; the threat model excludes a malicious same-UID actor. Taskfile is
the sole DAG. The real static selftest remains a leaf alongside observational
execution fixtures. No elapsed-time speed guarantee is made.

Normalization is fixed before parity observation: preserve source commit/tree,
bound input and runtime identity, task mode, success/error class, semantic value,
and dependent suppression. Exclude route, location, event/run/attempt IDs, PID,
raw timestamps and adapter-specific nonzero numeric exit codes. Every route must
still independently prove its actual exit and complete run-bound artifacts.

Current implementation is an initial review slice. Mandatory proofs still missing:
real CLI success/third refusal/readback, direct/actrun/actual Actions same-input
parity, cancellation and descendant recovery, stale/partial destructive tests,
full licensed runtime Carrier and fresh native offline import with original
store/daemon/cache/network unavailable, and independent R whole-gate readback.
No ACTIVE or proof-complete claim is made. Static validator tests pass separately.
