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


Candidate restore review contract (R 10752 follow-up): the offline driver must be
at the same clean commit as every accepted input. It fixes a native Git package
archive oracle (commit, tree, archive SHA and file inventory) before transport;
the oracle SHA is an external restore input. Restore uses only retained archive
and oracle bytes, never a live original repository or a source download. This
restores the exact package source identity, not a complete Git object/history DB.
The source.json pins are read from that verified archive. Native import must
recompute the serialized closure digest against the external expected digest,
verify actual NAR identities and root reference requisites, then hash all eight
tool binaries inside the isolated target. The receipt enumerates shared bootstrap
paths; prepared Nix bootstrap bytes are not claimed physically absent.

The declared PATH equivalence is the ordered bins of bound task, shell, Git and
coreutils. Task is materialized as `/retained/bin/task`, byte-identical to its
binding. Only attempt/asset locator prefixes change; bin order, binary bytes,
`BASH_ENV=''` and `ENV=''` remain fixed. No output-based environment equivalence.
`tests/restore-contract.py` contains bounded false-PASS negatives; it does not
replace final fresh offline import/execution.

`candidate/license-metadata.nix` evaluates existing immutable Nixpkgs sources;
`candidate/license-bindings.py` binds all 151 exact output paths/NARs to evaluated
license declarations, definition hashes and available native notice bytes in
`candidate/dependency-licenses.json`. This records upstream declarations and
provenance, not a legal adjudication or a new distribution scope. Root upstream
notices are separately byte-bound in `native-profile.json`. The failed actrun
license binding at Actions run 40097748418 remains historical evidence: the old
local copy had an added LF; the corrected binding uses untouched pinned upstream
bytes, with no whitespace normalization.


License bytes checkpoint after ce33: `candidate/license-bytes/` retains exact,
content-addressed source notices and definitions. The existing license generator
has an opt-in retained-acquisition mode (`--plan`, `--expected-plan-sha256`,
`--acquired`, `--base-packet`, `--assets`, `--embedded`). It requires the completed
229-object acquisition receipt, independently rehashes the retained sources,
extracts legal files/inline grants from tar, ZIP and native source trees, and maps
all 151 output NARs through source and patch identities. The plan itself and raw
Nix definition bytes are retained. Node/Python aggregate notices match exact
upstream source LICENSE bytes. Source selection is an extraction aid; independent
technical coverage review is still required, and no legal verdict is implied.

`license_contract.py` now refuses metadata-only completion, absent/changed blob
bytes, incomplete component/source/patch coverage and unresolved embedded bytes.
The packet now verifies all124 actual task Go modules against their binary h1
anchors. Complete file-hash manifests bind each retained notice to that h1 file
set. Official Go1.26.5 archive bytes supply runtime/stdlib notices; compiler-only
src/cmd is excluded. This acquisition is complete, not an external blocker.

For actrun, all26 selected registry modules, pinned registry commit
39743040d5e9fc28e90fad0ea280a4d30040543c, overlay commit
4ffc0aab45588a519342178cca9231be94c9bab0, core matching cd28f524e and actual NOTICE /
LICENSE bytes are retained. R's data-specific old/new resolver readback supports
normal publisher/registry origin; the moving clone is not proven linked and is
not a remaining source-graph blocker. No historical build attestation or
bit-identical rebuild is required. Publisher native C mirror source/Apache and
musl attribution bytes are retained, while the actual compiler's exact runtime C
revision stays an explicit limited Unknown; no source byte equivalence is claimed.

The six publisher references now retain exact canonical bodies from SPDX commit
31ba1a50e5397e00a304dbadc76531740e89ee48, matched publisher source references,
and all selected existing headers/notices. Registry manifests remain authoritative;
Git source metadata differences are explicitly preserved. Canonical template
placeholders are unmodified; they are not invented project copyright statements.
All20 SFNT fixture fonts (TTF and OTF) have exact raw/decoded name records and source font hashes retained separately with the OFL-1.1 body. Type-aware extraction excludes complete fixture-font payloads from notice assets; obsolete tracked font blobs are removed. This says nothing about fonts potentially inside opaque runtime binaries.
The font files and complete source archives are acquisition evidence, not shipped
runtime assets; the packet ships notice/header bytes and source identities.

`candidate/license-reference-bindings.py --inputs RETAINED_INPUT_DIRECTORY`
re-reads native notice members from the completed verified acquisition and Go
runtime members from the exact official archive. It also checks matched publisher
code/package bytes against registry archives. The resulting member inventory has
an independent digest in native-profile.json, separate from the packet digest.
Consumer validation binds source identity, member name and actual notice blob to
that inventory. All26 Moon notice variants/classifications are independently
anchored to actual registry members. Six required publisher references are selected
from that anchor, never skipped through packet-supplied notice kind/full flags.
The complete notice asset directory must equal the registered file set, and
complete SFNT payloads are refused even if added to the registry. A newly generated inventory requires independent source review;
changing packet and its digest alone cannot adopt different notice membership.

`tests/license-bytes.py` includes native/Go runtime wrong-body and member/source
transplant negatives, plus publisher/component/SPDX/body/header substitution and
font notice removal. The technical byte gate has no remaining missing entries;
independent coverage review and final-source full execution proofs remain pending.
This is technical provenance evidence, not legal adjudication. The limited native
C revision Unknown remains informational, not a new reproducible-build gate.
