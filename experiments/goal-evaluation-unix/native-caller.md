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
## Explicit finite native/filesystem host bridge

`runFiniteNativeHostBridge({callerOptions, packetDir}, value, testRuntime?)` is an
opt-in ordinary-Node entry. It internally binds the real `bindNativeProductCaller`
and preserves its engine value or original Error. It requires `ownerReturn` with
`transport:'host-mcp'` and explicit `exchangeTimeoutMs` (integer 1..600000).
`statusListLimit` is optional, integer 1..50, default 1. The inherited native
`CODEX_THREAD_ID` must match the owner; live runtime injection is rejected. The
NodeREPL child environment is not assumed to be the genuine owner's environment.
No brand, tool capability, source string or environment identity is copied to a
different process. Engine execution authority/deadline is separate from delivery.

`packetDir` is an existing absolute non-symlink directory. Private parent ACLs
and source/target admission remain caller responsibilities, not isolation from a
hostile same-UID process. A new exclusive `<runId>.bridge` directory owns binding,
at most two command and observation files, and the final receipt. Names are fixed:
`binding.json`, `phase-1.command.json`, `phase-1.observation.json`, corresponding
phase-2 names, and `receipt.json`. Each is compact JSON plus LF. Publishing uses
mode-0600 CreateNew `.pending`, fsync/close, then an exclusive same-filesystem hard
link. The staging inode is retained. No overwrite, rename/copy fallback, cleanup,
reclaim or retry exists. Regular-file/no-symlink, size, canonical bytes and exact
keys are checked on a single bounded read. Command/observation packets are <=16KiB.

The engine owns and verifies `engine.result.json` before issuing a command. The
runner awaits the real operation, takes the ready command without polling, and
arms one filesystem watch before publication and the initial observation check.
Each phase carries a new nonce plus owner/run/source, caller binding, event and
command hashes, module hash and deadline. There is one accepted input per phase.
Unknown, partial, early, wrong identity, duplicate writer, timeout or I/O leaves
original artifacts and HOLD; no later phase is retried. Watches and timers close
when their one wait settles. The aggregate exchange timer is monotonic and is
never reset for phase 2; it does not stop a host tool or guarantee remote effects.

The exchange ceiling does not extend observation freshness. `timeoutMs` stays
1..30000. The native command issue time conservatively precedes a sample taken
during the normal tool request. Both source elapsed checks and a per-command
`commandExpiresAt` retain that bound, including time spent returning a send result.
Phase 2 also clamps that deadline to the receiver's own `statusObservedAt` plus
`timeoutMs`; in finite mode this is its earlier command-take origin. Missing or
invalid receiver evidence yields HOLD rather than an inferred replacement time.
The fixed driver must check this deadline immediately before calling the tool.
An observed 135-second list request therefore yields HOLD, not a fresh idle claim.
Tool start/completion are host-port reports; internal `runtimeSampledAt` remains
null. The API-contract interpretation is not authenticated runtime instrumentation.

### Mechanical normal-functions driver contract

The source side exports `readFiniteNativeHostCommand({packetDir,runId,phase})` and
`submitFiniteNativeHostToolResult({packetDir,runId,phase,toolStartedAt,toolCompletedAt}, response)`.
These are ordinary-Node APIs, not proof that the functions surface can import this
module or stay alive after its parent finishes. A reviewed fixed functions driver
must use its admitted normal native helper surface to invoke those exports; it
must not eval file contents, spoof globals/environment, or recreate the receiver.
The same native runner remains alive and owns the branded state throughout.

The complete finite procedure is: read phase 1 once; validate unexpired command;
record real tool start; call exactly its fixed `codex_app.list_threads` tool and
arguments through the normal MCP approval/caller context; record completion;
submit that exact response once. If phase 2 is issued, repeat once for the fixed
`codex_app.send_message_to_thread` command, checking the command deadline before
the call. No model decision, semantic relay, tool selection, resubmission, manual
fallback, new daemon/session/auth or raw pipe call belongs between these steps.
The driver may not infer that a delay means the parent is idle.

List projection accepts only the observed CallToolResult shape: `content` plus
`isError:false`, one text block containing the exact known eight root keys, and
the `pinnedThreads`/`threads` arrays. It reads only own scalar `id`, `hostId`, and
`status`, requires exactly one exact owner/local match, and caps the two arrays
at 1000 entries and the canonical whole response at 262144 bytes. Missing host,
duplicate match, unknown shape or status yields unknown/HOLD. Title, summary,
body, preferences and the raw response are not persisted; only canonical response
bytes/hash and the narrow status projection enter the observation packet. This
does not bound the tool's transport/all-pinned response allocation.

The send tool has no established ACK payload contract. Explicit `isError:true`
is reported failure; all other send results remain unknown. Non-error does not
mean queueing or consumption. The source cannot prove after-parent-final driver
lifetime, genuine runtime-idle semantics, delivery, or exact-owner consumption.
Those require a separately authorized real product experiment. Source/tests do
not establish automatic return or G1/G2 completion. Missing/partial receipt is
not acceptance evidence; an engine result remains valid independently of return.

### Explicit projection-v2 transport for normal functions

`runFiniteNativeHostBridge({callerOptions,packetDir,observationFormat:'projection-v2'}, value)`
selects a separate binding and observation schema. Omission preserves raw-v1.
Neither helper can submit its format against the other binding. The v2 binding
hash includes the original caller binding and the explicit format. The native
process still owns the real caller, receiver brand and verified engine artifact.

Normal functions has no native filesystem, Buffer or crypto. Passing an entire
list response through a Node `-e` argument would conflict with Windows argument
bounds and would carry unrelated host content. In v2 the fixed functions code
below projects the actual response in its original surface. The ordinary Node
helper receives only bounded scalar observations. It records
`rawToolResultSha256:null` and `rawIdentityStatus:'NOT_OBSERVED_BY_NATIVE'`.
The host-reported canonical wrapper size is a reported measurement, not a native
raw-byte measurement. Only the compact projection plus LF has a native exact
byte count and SHA. There is no pure-JS SHA implementation or claimed raw hash.
The raw tool body is not written to a packet, command, argv, stdin or log.

`projectFiniteHostToolResultForDriver(response,ownerThread,phase)` is ordinary
self-contained JavaScript. It uses own data descriptors, never getters. Its
positive status branch requires the known one-text JSON wrapper, exact owner and
explicit local host, one matching entry, known status, <=1000 entries and a
reported canonical wrapper <=262144 UTF8 bytes. An already allocated response is
not tool-level bounded. Unknown/extra shapes, missing host and duplicate matches
remain unknown. Phase 2 accepts no guessed ACK shape: an explicit error is failed;
all other results remain unknown. Projection does not authenticate the host port.

The existing module itself exposes a closed ordinary-Node frontend:

```text
node native-caller.mjs host-command --packet-dir ABS --run-id UUID --phase 1 --wait-ms 600000
node native-caller.mjs host-observe-projection --packet-dir ABS --run-id UUID --phase 1 --started-at UTC --completed-at UTC --status ENUM --classification ENUM --raw-bytes INTEGER_OR_null --raw-units INTEGER_OR_null --raw-size ENUM
```

Only those two operations and exact scalar flags are accepted, with an aggregate
argv ceiling of 8192 UTF16 units. The CLI `host-command` is v2-only and rejects a
raw-v1 binding before returning a command; exported raw-v1 APIs remain available.
The entire success envelope including LF is checked against 8192 UTF8 bytes before
any stdout write. Overflow emits only the fixed HOLD envelope with exit 2, never
a clipped success or an exposed prefix. Unknown, duplicate, extra and malformed arguments
give the fixed `HOST_HELPER_FAILED` output/exit 2. No arbitrary export, source text,
file wrapper, callback, eval or stdin body is executed. No-argument module behavior
is unchanged. `host-command` arms one directory watch before its first check and
waits for one command or a terminal receipt. It validates binding/module identity;
terminal receipt strings are never echoed. It closes/unrefs on settlement and
does not poll the filesystem. It requires the bridge directory and binding to
exist already; a separately admitted startup handshake must establish this fact.
Absence is HOLD, not an implicit helper retry or worker restart.

The following is a fixed normal-functions driver template. Its seven pinned
scalar constants must be filled and independently reviewed before any live use;
the placeholders intentionally fail admission. The projector literal immediately
below must be included unchanged in the same cell. There is no model decision
between source command, normal tool and source acceptance. Normal MCP approval
and the genuine caller context remain in force. No `_meta`, environment identity,
raw pipe, custom client, new server/session/auth or dynamic tool lookup is used.
The native worker must have published its admitted binding before this cell runs.

```javascript
const pin = Object.freeze({
  node: 'REVIEWED_ABSOLUTE_NODE', source: 'REVIEWED_ABSOLUTE_NATIVE_CALLER_MJS',
  packetDir: 'REVIEWED_ABSOLUTE_PACKET_DIR', runId: 'REVIEWED_UUID',
  owner: 'REVIEWED_OWNER_UUID', sourceSha: 'REVIEWED_40HEX_SOURCE',
  observationFormat: 'projection-v2'
});
const must = value => { if (!value) throw new Error('FIXED_HOST_DRIVER_HOLD'); };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
must(uuid.test(pin.runId) && uuid.test(pin.owner) && /^[a-f0-9]{40}$/.test(pin.sourceSha));
must([pin.node,pin.source,pin.packetDir].every(x => /^[A-Za-z]:[\\/]/.test(x) && !/[\0\r\n]/.test(x)));
const quote = value => "'" + String(value).replaceAll("'", "''") + "'";
const utf8 = text => {
  let n=0;
  for (const character of text) {
    const c=character.codePointAt(0);
    n += c<128 ? 1 : c<2048 ? 2 : c<65536 ? 3 : 4;
  }
  return n;
};
const end = Date.now() + 600000;
async function helper(args) {
  must(Date.now() < end);
  const cmd = '& ' + [pin.node,pin.source,...args].map(quote).join(' ') + '; exit $LASTEXITCODE';
  must(cmd.length < 16384);
  let r = await tools.exec_command({cmd,shell:'powershell.exe',login:false,max_output_tokens:12000,yield_time_ms:10000});
  let reportedToolBytes=utf8(JSON.stringify(r));
  must(reportedToolBytes<=12000 && typeof r.output==='string');
  // These bounded reads await the SAME helper process; they never re-execute a
  // helper or poll host status. The native one-shot watch owns readiness.
  let decoded = r.output;
  for (let n=0;r.session_id && n<12 && Date.now()<end;n++) {
    r = await tools.write_stdin({session_id:r.session_id,chars:'',max_output_tokens:12000,yield_time_ms:50000});
    reportedToolBytes += utf8(JSON.stringify(r));
    must(reportedToolBytes<=12000 && typeof r.output==='string');
    decoded += r.output;
    must(decoded.length <= 8192);
  }
  must(!r.session_id && r.exit_code === 0 && decoded.length <= 8192 && utf8(decoded)<=8192);
  const result = JSON.parse(decoded);
  must(JSON.stringify(result)+'\n' === decoded.replaceAll('\r\n','\n'));
  must(result.schema === 'ops.native-host-cli.v1' && result.status === 'OK');
  return result.output;
}
for (const phase of [1,2]) {
  const common = ['--packet-dir',pin.packetDir,'--run-id',pin.runId,'--phase',String(phase)];
  const ready = await helper(['host-command',...common,'--wait-ms',String(Math.max(1,end-Date.now()))]);
  if (ready.kind === 'TERMINAL') break;
  const p = ready.packet;
  must(ready.kind === 'COMMAND' && p.phase === phase && p.ownerThread === pin.owner
    && p.runId === pin.runId && p.sourceSha === pin.sourceSha);
  must(Date.now() < Date.parse(p.commandExpiresAt) && Date.now() < Date.parse(p.expiresAt));
  let response, startedAt;
  if (phase === 1) {
    must(p.command.tool === 'codex_app.list_threads' && p.command.kind === 'OBSERVE_OWNER_STATUS'
      && Object.keys(p.command.arguments).join(',') === 'limit'
      && Number.isInteger(p.command.arguments.limit) && p.command.arguments.limit>=1 && p.command.arguments.limit<=50);
    const at=Date.now();
    must(at<end && at<Date.parse(p.commandExpiresAt) && at<Date.parse(p.expiresAt));
    startedAt=new Date(at).toISOString();
    response = await tools.mcp__codex_app__list_threads({limit:p.command.arguments.limit});
  } else {
    must(p.command.tool === 'codex_app.send_message_to_thread' && p.command.kind === 'SEND_OWNER_NOTICE'
      && Object.keys(p.command.arguments).sort().join(',') === 'hostId,prompt,threadId'
      && p.command.arguments.threadId === pin.owner && p.command.arguments.hostId === 'local'
      && typeof p.command.arguments.prompt === 'string' && p.command.arguments.prompt.length<=2048);
    const at=Date.now();
    must(at<end && at<Date.parse(p.commandExpiresAt) && at<Date.parse(p.expiresAt));
    startedAt=new Date(at).toISOString();
    response = await tools.mcp__codex_app__send_message_to_thread({
      threadId:pin.owner,hostId:'local',prompt:p.command.arguments.prompt
    });
  }
  const completedAt = new Date().toISOString();
  const projection = projectFiniteHostToolResultForDriver(response,pin.owner,phase);
  response = undefined;
  await helper(['host-observe-projection',...common,'--started-at',startedAt,'--completed-at',completedAt,
    '--status',projection.status,'--classification',projection.classification,
    '--raw-bytes',String(projection.reportedRawJsonBytes),'--raw-units',String(projection.reportedRawJsonUnits),
    '--raw-size',projection.rawSizeStatus]);
}
```

The caller/product binding and receiver command binding have distinct hash roles.
The packet validates the command binding and event digests as 64-hex metadata,
not as equal hashes. Source-owned command hash/nonce echo in the live worker and
private filesystem admission remain the integrity boundary; this does not rebuild
the receiver binding or authenticate a hostile same-UID writer.

The driver admits at most 12000 reported UTF8 bytes across returned exec/read
metadata for one helper, with an 8192-byte decoded success envelope. This is a
post-response completeness guard, not a tool transport/allocation hard cap.
`max_output_tokens` is not a byte measurement. Truncation, missing output or any
noncanonical response yields HOLD; no truncated prefix is accepted as FULL.
The driver stops on helper/tool/parse error, stale deadline, missing command or
unknown state. There is no host retry, extra list, send fallback or calibration
message. Tool/exec timeouts do not prove a remote effect stopped. Expired native
acceptance remains HOLD even if a late tool result is retained. A helper terminal
only stops the driver; it is never a consumption ACK. The 600-second exchange
ceiling and unchanged 30-second freshness are separate: observed long list calls
can be unusable. Tool start/completion and sizes are host-port reports. A future
experiment must separately establish after-parent-final cell/worker lifetime,
a post-final request and actual idle, one source-owned real terminal delivery,
and exact-owner consumption. This source template, its native children and its
synthetic tests do not establish any of those facts.

The literal projector used by that template follows. The neutral source test
checks byte-for-byte agreement with the exported function.


```javascript
function projectFiniteHostToolResultForDriver(response, ownerThread, phase) {
  const own = (value, key) => {
    if (!value || typeof value !== 'object') return undefined;
    const d = Object.getOwnPropertyDescriptor(value, key);
    return d && Object.hasOwn(d, 'value') ? d.value : undefined;
  };
  const exactKeys = (value, names) => value && typeof value === 'object' && !Array.isArray(value)
    && Reflect.ownKeys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
  const output = { schema: 'ops.host-tool-projection.v1', status: 'unknown',
    classification: 'STATUS_SHAPE_OR_IDENTITY_UNKNOWN', reportedRawJsonBytes: null,
    reportedRawJsonUnits: null, rawSizeStatus: 'NOT_MEASURED' };
  if (phase === 2) {
    output.classification = own(response, 'isError') === true ? 'HOST_TOOL_ERROR_REPORTED' : 'SEND_ACK_CONTRACT_UNKNOWN';
    if (own(response, 'isError') === true) output.status = 'failed';
    return output;
  }
  if (phase !== 1 || !exactKeys(response, ['content', 'isError']) || own(response, 'isError') !== false) return output;
  const content = own(response, 'content'), block = own(content, '0');
  if (!Array.isArray(content) || own(content, 'length') !== 1
      || !exactKeys(block, ['type', 'text']) || own(block, 'type') !== 'text') return output;
  const text = own(block, 'text');
  if (typeof text !== 'string') return output;
  if (text.length > 262144) { output.rawSizeStatus = 'OVER_REPORTED_BOUND'; return output; }
  const json = JSON.stringify({ content: [{ type: 'text', text }], isError: false });
  output.reportedRawJsonUnits = json.length;
  let bytes = 0;
  for (let i = 0; i < json.length; i++) {
    const c = json.charCodeAt(i);
    if (c < 128) bytes++;
    else if (c < 2048) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < json.length
        && json.charCodeAt(i + 1) >= 0xdc00 && json.charCodeAt(i + 1) <= 0xdfff) { bytes += 4; i++; }
    else bytes += 3;
    if (bytes > 262144) { output.rawSizeStatus = 'OVER_REPORTED_BOUND'; return output; }
  }
  output.reportedRawJsonBytes = bytes; output.rawSizeStatus = 'WITHIN_REPORTED_BOUND';
  let root;
  try { root = JSON.parse(text); } catch { return output; }
  if (!exactKeys(root, ['schemaVersion', 'sidebarPreferences', 'untrustedDataNotice',
    'pinnedThreads', 'threads', 'sections', 'unavailableHosts', 'unavailableSources'])) return output;
  const pinned = own(root, 'pinnedThreads'), threads = own(root, 'threads');
  if (!Array.isArray(pinned) || !Array.isArray(threads) || pinned.length + threads.length > 1000) return output;
  const matches = pinned.concat(threads).filter(row => own(row, 'id') === ownerThread && own(row, 'hostId') === 'local');
  if (matches.length !== 1 || !['idle', 'active', 'notLoaded', 'systemError'].includes(own(matches[0], 'status'))) return output;
  output.status = own(matches[0], 'status');
  output.classification = 'HOST_PORT_REPORTED_STATUS_REQUEST_INTERVAL';
  return output;
}
```

## Explicit fixed JEV owner evaluation

`bindNativeProductCaller` additionally accepts `operation:'evaluate'`. Existing
plan/judge defaults, TypeLLM ports, Core and receiver event v2 stay unchanged.
This branch accepts `ownerLimits` using the five existing `ENTRY_LIMITS` keys;
they can only reduce 24 cases/24 provider callbacks/1048576 input bytes/15000ms
per call/60000ms entry deadline. Core/TypeLLM options (`maxCalls`, `maxBytes`,
`maxQuestions`, `maxClauses`, `cores`, `proposalFormat`, `requestTimeoutSeconds`)
are rejected here rather than reinterpreted. The SSH deadline is separately
1..95000ms. Raw transport bytes are not a provider token-fit claim.

The source operation runs existing `preparePlan`, requires explicit v16 cases,
sends complete `prepared.plan` once to the fixed remote owner entry, and validates
actual output with `validateOwnerResult(prepared,output,'owner-v16')`. No generic
product callback, engine, executable selector or credential is injected.
An all-missing admitted plan still invokes the actual remote owner once; zero
provider work is accepted only from its validated source report. Structural
preflight synthetic answers are never execution results.

`bindSemlintOwnerSSHExecutor` requires absolute `sshPath`, strict `host`, exact
lowercase `envsSha`, `opsSha` and `resourcesSha`, UUID `runId`, existing absolute
non-symlink `ledgerDir`, and the closed immutable launcher path
`/nix/store/<32-lower-alnum>-ops-semlint-owner/bin/ops-semlint-owner`.
The only remote arguments are `--envs-sha` and `--ops-sha`; resources SHA stays
declared binding metadata, not another flag. Exports are `executePlan(plan,
{callId:runId+'/evaluate/1',signal?})`, `receipts()` and `bindingSha256`.
One SSH attempt is durably claimed per run; crash/duplicate/rebind is not replayed.
Shell execution is disabled; four provider API environment values are excluded
without reading them. Path grammar alone does not prove actual SSH config,
host-key, target, launcher, ciphertext or source identity.

Exact JSON snapshot plus LF must be <=1048576 bytes. Separate CreateNew private
stdin/stdout/stderr/receipt files retain bytes and SHA. Stdout is capped at
1048576 bytes and stderr at 16384; overflow preserves a prefix, incomplete status
and failure, never clipped success. Stdout must be one canonical UTF8 JSON line
of `ops.semlint.real-result.v3`. No TypeLLM frame, API key or fake HTTP bridge is
used. Public build diagnostics may occupy stderr. Timeout/cancel attempts local
SSH termination. After 250ms without close, handles are released and close remains
unproved; neither kill nor local receipt proves remote stop or zero cost.

The validator extracts all prior returned-plan identity, projection, record,
cause and accounting predicates. Copied/unadmitted prepared values are refused.
Default `github-legacy` keeps v1/v14; the composer still requires its requests
WeakSet and unchanged 32768-byte comment cap. Only explicit owner-v16 admits
v16 and requires actual v3 per-case owner reports; `provider:null` synthetic
results are refused there. Existing GitHub admission and comment wire stay fixed.

The caller verifies its actual result artifact before terminal/return commands.
INCOMPLETE remains HOLD; execution/evidence errors remain failed. Settled output
is not semantic usefulness or Goal coverage. Local caller source SHA, declared
remote Ops pin, resources pin and launcher output are separate fields. A pinned
historical remote entry need not contain the new local validator export;
logical schema compatibility and actual source/store identity need separate
admission. Local SSH counts are distinct from remote source-reported provider
HTTP/callback counts. Backend identity and cost remain unknown. Local stdin SHA
is not remote raw-byte observation; returned planDigest binds canonical identity.

Real execution requires the genuine owner-native environment; a NodeREPL child
is not assumed to inherit exact P identity. Environment identity rewriting is
forbidden. Normal host approval and the admitted thin driver remain required.
Sender ACK is not consumption; no consumed API is added. G1/G2, idle return and
utility require separate real evidence. These tests use neutral synthetic source
and child pipes only, never case/Gold, actual SSH or a provider.
