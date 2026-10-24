# ops-task-runtime

Authority: `roccho-dev/adrs#317`.

The legacy `source.json`, `workflow.yml`, and `ci` task retain the #317 gosh
profile. `candidate requests` is an explicit opt-in proof under the current
2026-10-24 user task (SAME-v5.1); it is not an accepted successor, default change,
or completion of #463 / #675. No global gosh retirement is included.

The candidate CLI accepts an `ops.taskCandidateRequests/1` JSON request batch
with `eventId`, canonical `inputBase64`, `mode` (`success` / `failure` / `cancel`) and
`route` (`direct` / `actrun`). It requires `--repo`, `--request-file`,
`--runtime-manifest`, and a new `--evidence-dir`. The runtime manifest schema is
`ops.taskCandidateRuntime/1`, with exact absolute `path` and `sha256` for
`tools.node`, `python`, `task`, `actrun`, `shell`, `loader`, `git` and `coreutils`, plus the native Nix closure path/NAR identities. Official actrun bytes are executed through the bound glibc loader without patching the binary. The generated manifest explicitly records candidate-only status. Run it using the bound Node:

```text
node bin/ops-task-runtime.mjs candidate requests --repo REPO \
  --request-file REQUESTS --runtime-manifest RUNTIME --evidence-dir NEW_DIR
node candidate/readback.mjs NEW_DIR --expect EXPECTED_JSON
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

Full local conformance uses the actual OS CLI and exact runtime:

```text
OPS_TASK_RUNTIME_CANDIDATE_MANIFEST=RUNTIME \
OPS_TASK_RUNTIME_CANDIDATE_EVIDENCE=NEW_EVIDENCE_DIR node tests/e2e.mjs
```

It compares both declared input byte strings for direct/actrun success, expected
failure and cancellation, checks third refusal and disjoint attempts, rejects
stale/partial/missing results and invalid runtime/dirty source, and kills an
actual caller to exercise live HOLD, stopped-incomplete retry with the same x,
and completed-result collection without replay. External request/source/runtime expectations are saved separately and checked for PASS; readback without them reports only SELF_CONSISTENT_EXPECTATION_MISSING. `candidate recover --attempt DIR`
only reads state; `--retry-runtime RUNTIME` explicitly permits a new attempt
only after the prior process tree is proven stopped. These are finite proof
operations, with no persistent automatic retry owner.

`tests/offline-restore.py` queries/exports the whole native closure, uses existing
portable-pack and Carrier owners, and calls `candidate/restore-check.py` to
import/run inside a new user/mount/net/PID namespace and chroot. The original
store and daemon are absent. The retained Nix bootstrap is the prepared-target
native authority; candidate Node/Python must be absent before import. No host
root permission, service or global install changes are involved.

The existing release workflow has an explicit `workflow_dispatch` candidate
job selecting an exact source commit and the checked candidate native profile.
It uses the repository's existing pinned Nix setup owner and native signed copy
from cache.nixos.org, verifies NAR contents and binary hashes, downloads the pinned
official task/actrun archives, then runs the same actual CLI conformance. This
online setup is separate from the no-cache offline restore proof. Upload and provider permissions
are outside semantic parity. An unexecuted job is not Actions proof.

Evidence remains outside source, keyed by exact commit/input/closure and attempt.
Source changes invalidate affected proof. Mandatory final gates still include
actual Actions, full fresh restore/readback, dependency-license audit and
independent R whole-gate Green. No proof-complete or final ACTIVE admission is
claimed merely by implementing these checks. Legacy static validation remains
independent and unchanged in meaning.

The finite execution fixtures do not deliberately escape process groups or PID namespaces. Recovery in a different boot/PID observation context is HOLD; unknown descendants are not treated as stopped. Group/lineage discovery checks live start identities before expanding, and shutdown rescans for new descendants.
