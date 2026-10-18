# Native product operation and exact-owner return

`bindNativeProductCaller` is exported by `prepare.mjs` and implemented in `native-caller.mjs`. It composes the existing native Core, typed executor ports, SSH executor and official exact-owner receiver. Its `run(input)` executes one plan or judge operation and invokes `withProductOwnerReturn` from the product terminal path. A human sending an already saved receipt is not this path.

The binding takes `id, mode, operation, runId, sourceSha, ledgerDir, ssh, ownerReturn, deadlineMs`. `ssh` contains the existing fixed executable/host/source pins/ledger and optional closed store launcher path. `ownerReturn` contains `codexPath, endpoint, ownerThread, ledgerDir, expiresAt, timeoutMs`. Neither arbitrary completion descriptors nor sender callbacks are accepted. Live runtime overrides are rejected. Test-double mode requires an explicit synthetic receiver runtime; offline tests mock the existing child-process boundary and run no SSH, model or real queue.

`operation` is `plan` or `judge`. Plan permits one proposal; judge permits at most four which calls. Optional `maxBytes` retains the Core default 28000 and may explicitly select at most 65536. `maxQuestions/maxClauses` are at most 4/16. Optional cores, proposal format and explicit 60-second request timeout reuse the existing ports without changing defaults. These caller-local bounds do not raise provided-route 28000/31000/60000 limits, SDK 131072-byte requests, 8192-unit instructions, array/field/answer limits or provider capacities. No fit, fidelity or full Goal coverage is certified.

The current inherited owner must match before binding and execution. A factory is one-use. An atomic `runId.engine` directory protects an execution across factories as well. Existing SSH per-call claims remain independent. Consumed or unknown runs are not reset or retried. Caller-supplied source/host/path pins remain `DECLARED_ONLY`; actual source, launcher, host key and runtime admission are external preconditions. Private ledger parents and ACLs remain caller admission responsibilities.

The product wraps its own actual `executeTyped` capability, counting each invocation before awaiting it. A first rejected which operation latches further port dispatches. Core logical call counts and EXECUTION_ERROR results are preserved; later logical failures do not cause extra SSH calls. Valid unknown answers and needs-only INCOMPLETE results do not trigger this failure latch. Existing Core error/result objects are returned through the owner-return wrapper rather than replaced by delivery failure.

The original v1 receiver event and notice remain unchanged. Explicit v2 adds `executorInvocations` and `transportLifecycle`:

- NO_EXECUTOR_INVOCATION requires the owned counter and actual receipt count both zero, pending zero and physicalCloseObserved false.
- LOCAL_SSH_CLOSED requires a positive invocation count, exactly one corresponding unique callId receipt per owned invocation, pending zero and every actual SSH receipt physically closed.
- Missing, duplicate, pending or unclosed receipts produce UNPROVED locally and no queue event. An invocation refused before spawn is still an invocation, not NO_EXECUTOR_INVOCATION; this version leaves that case HOLD.

The receiver validates structural consistency. It cannot witness arbitrary caller assertions. This source constructs the descriptor internally from the actual engine terminal and owned immutable transport receipts. The owned `runId.engine/engine.result.json` stores the compact actual engine result (or an explicitly safe error envelope) plus LF with CreateNew/0600 before delivery. Regular-file identity and exact binary readback are mandatory; write/read/identity mismatch preserves partial files and suppresses queue while retaining the original engine value/error. `resultSha256` still hashes compact JSON without LF. Terminal fields separately name the fixed basename, actual LF-inclusive file bytes/SHA256 and VERIFIED_READBACK status. Private transport snapshot and terminal files are also written before delivery. Safe error envelopes contain fixed error codes only and are not the original Error object. A final caller receipt write failure remains visible in the in-memory receipt and never replaces the engine value/error.

`COMPLETED` describes one mechanically settled engine operation. It does not mean Goal satisfaction, provider validity, utility, G1/G2, three-lane comparison or project completion. Missing/unknown judge results remain HOLD. FAILED includes actual port/transport failure even when Core returns an ordinary judgments object. Queue ACK means QUEUED_NOT_CONSUMED; exact P idle consumption still needs its own actual receipt.

This caller explicitly requests the v2 endpoint preflight. It checks only the declared path, consumes one return claim and records HOLD_ENDPOINT_UNAVAILABLE/NOT_ATTEMPTED with queue zero when absent, a symlink or a directory. Presence of a regular/socket path is not proof of a compatible running server or permission. The official CLI still uses fixed explicit `queue --remote unix://... --thread ... --message ...` and no embedded fallback. Legacy receiver bindings have no new hidden preflight.

No default product invocation, daemon, scheduler, model call, current host availability or deployment is enabled by importing this module. A finite admitted caller must still adopt the exported operation with real source/run/owner/endpoint bindings. The known missing desktop control endpoint, genuine product-origin idle delivery and exact P consumption remain unproven. web.chat and periodic automation remain paused.

`expiresAt` is only the return-delivery deadline. Engine execution authority and its finite deadline belong to separate caller admission; this option is not an engine-start lease. An expired delivery preserves the actual engine value/error and saved result artifact, queues nothing and remains undelivered.

The explicitly selected preflight flag is captured at receiver bind time. Later mutation/deletion/addition on the caller options cannot change the bound event gate or endpoint check.


## Opt-in host-tool return

The existing `bindNativeProductCaller` accepts an explicit ownerReturn alternative:

```js
ownerReturn: {
  transport: "host-mcp", hostId: "local", ownerThread,
  ledgerDir, expiresAt, timeoutMs
}
```

This alternative uses `bindExactOwnerHostReturn` from the existing receiver module. Omitted transport retains the existing CLI binding, returned API shape, endpoint-presence preflight and defaults. This branch has no CLI/SSH/MCP send callback injected into live mode. Live execution still verifies the actual inherited owner environment and uses real fixed SSH ports for any engine work. An all-needs INCOMPLETE result is a valid engine result with zero executor invocation; it is not a transport failure.

The actual engine value, or a fixed safe envelope for its original error, is persisted as engine.result.json and binary-readback verified before terminal/transport artifacts and before any command can be taken. Failure to save that artifact yields no host command and preserves the original engine value/error. The host branch adds only `takeHostCommand()`, `acceptHostObservation(commandId, scalarPacket)` and `acceptHostSendResult(commandId, scalarPacket)` to the public caller. The same-module receiver controls the fixed owner/run/source/hash command state machine; a user model may not select, rewrite or resend commands after seeing the result.

The engine receipt captures delivery state when run() settles. Later host handshake state is available from returnReceipts(); it does not retroactively mutate the engine receipt or imply queueing/consumption. A host acknowledgement is only HOST_ACK_REPORTED_NOT_CONSUMED. Artifact-before-command, one status command, one send command, ordered fresh owner observation and no retry are source properties. Real status availability, normal MCP approval/caller context, native process lifetime after parent final, the approved thin data transport and exact-P idle consumption remain unproven runtime conditions.

The returned caller is process-local. A functions cell cannot receive this native factory by passing a callback, evaluating source text or copying a WeakMap-branded receiver. A genuine owner-native runner must keep the state alive and an approved thin driver must only carry its typed command/observation data. NodeREPL children need not inherit the owner ID; environment rewriting to bypass this guard is prohibited. These tests are synthetic and do not establish a live host bridge, delivery, model utility or G1/G2 completion.
