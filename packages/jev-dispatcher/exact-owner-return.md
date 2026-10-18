# Exact owner return from a product terminal event

`exact-owner-return.mjs` is an opt-in host capability for the product caller. It
does not change `dispatcher.run`, Core, model ports, default model behavior, or
the periodic automation. Bind it before a finite product invocation and use
`withProductOwnerReturn(runProduct, describeTerminal, receiver)`. The wrapper
automatically attempts delivery after that invocation settles. It returns the
same value or throws the same original error even when delivery fails.

`describeTerminal` is a trusted synchronous caller function. It must bind the
actual source/run/owner and hashes of the actual result and transport receipt,
including observed physical transport close. A late manual replay of a stored
receipt, a synthetic test event, or a placeholder notice is not product return
evidence. A failed product result may return as FAILED; this cannot make G1 pass.

The live receiver requires the exact inherited `CODEX_THREAD_ID`, an absolute
installed official CLI path, and an explicit `unix://` absolute path for the
existing owning server. Its only child argv is:

```
codex queue --remote <existing-endpoint> --thread <exact-owner> --message <notice>
```

There is no implicit endpoint, embedded-server fallback, server start, raw RPC,
caller metadata fabrication, authentication override, or approval override. The
CLI and host's normal authentication and execution controls still apply. The
caller must separately establish installed-source and endpoint compatibility;
declared path/run hashes alone do not establish it. The implementation follows
the explicit remote branch in the matching official CLI tag
`rust-v0.162.0-alpha.17.2` (`session_archive_commands.rs`, `session_queue_commands.rs`).

The notice contains only fixed text and validated scalar enums/UUIDs/hashes. It
contains no case, Plan, questions, Gold, provider answer, or credential. An atomic
per-run directory prevents a second dispatch even across factories/processes.
The claim, bounded original stdout/stderr and receipt are created with exclusive
writes and retained after failure. A local child timeout/output limit does not
prove a remote enqueue did not happen. Failed/unknown calls are never retried.
After close grace expires, surviving local child and pipe handles are detached;
their observed detachment and absent physical close remain explicit. Late events
cannot mutate a finalized receipt. Stream hashes identify the actual bounded
retained files; an I/O failure never becomes a complete-stream claim.

Exit zero and the matching CLI ACK are recorded as `QUEUED_NOT_CONSUMED`.
`consumptionStatus` remains `NOT_OBSERVED`: an unloaded or interrupted target may
accept a queue item without starting a turn. Completion additionally requires
the same current P to become idle and actually consume the queued item in a
later turn, with the source/run/result/transport/nonce receipt matched. Manual
resumption, a new agent/session, queue acceptance, tests, CI and source
publication are not that proof. G1, G2 and runtime identity remain separate.
The notice, claim and receipt carry the delivery expiry. The consuming P must
recheck current source/refs, expiry and still-valid authorization before acting;
a queued notice grants no scope and never permits replay of consumed calls.

Unit tests use explicit `test-double` mode and synthetic scalar events. Live mode
rejects injected runtimes. These tests make no model/SSH/queue/network calls and
do not claim operational automatic return.


## Explicit host-tool protocol (opt-in)

`bindExactOwnerHostReturn({mode, ownerThread, hostId: "local", runId, sourceSha, ledgerDir, expiresAt, timeoutMs})` is a separate same-module branded receiver. The explicit CLI receiver and all its defaults remain unchanged. A live factory rejects a test runtime and checks the actual inherited `CODEX_THREAD_ID`; setting that variable to impersonate an owner is not an accepted transport. Node, functions and MCP caller contexts are separate execution surfaces.

After the product has persisted its real result and terminal artifacts, `deliver(event)` claims the same per-run ledger namespace used by the CLI receiver. It prepares data only. `takeHostCommand()` yields at most one `OBSERVE_OWNER_STATUS` command for the approved `codex_app.list_threads({limit:1})` capability. A genuine thin host driver must mechanically execute only the source command through the normal approved tool surface, extract only the exact owner/local runtime-status scalars, and call `acceptHostObservation(commandId, observation)`. No model decision, arbitrary code evaluation, forged MCP caller metadata, raw pipe, endpoint substitution or new server belongs between these transitions.

A status packet has exactly `{schema:"jev.host-owner-status.v1",ownerThread,hostId,status,observedAt,statusMeaning}`. Accepted status enums are `idle`, `active`, `notLoaded`, `systemError`, `unknown`; statusMeaning is `RUNTIME_TURN_STATUS` or `UNKNOWN`. Only a fresh exact-owner `idle` observation with established runtime-turn meaning permits the single `SEND_OWNER_NOTICE` command. Its arguments contain only threadId, hostId and the fixed bounded scalar notice; no model/thinking overrides or result body/path are sent. Wrong owner, absent/unknown/active state, ordering violation, clock rewind, expiry, duplicate take or stale observation permanently holds that delivery. There is no retry or reclaim.

The send report has exactly `{schema:"jev.host-owner-send-observation.v1",ownerThread,hostId,status,observedAt}`, with status `acknowledged`, `failed` or `unknown`. It describes a host-port report, not an authenticated fact established by this Node library. A reported acknowledgement ends at `HOST_ACK_REPORTED_NOT_CONSUMED`: enqueueStatus remains UNKNOWN and consumptionStatus NOT_OBSERVED. Issued command counts are not actual host tool invocation counts. The notice binds result/transport/event hashes and a nonce; actual exact-P consumption must be independently recorded after idle. Engine-operation terminal does not mean Goal, G1 or G2 completion.

The host driver must preserve standard user approval and genuine tool caller identity. The source cannot establish that list_threads supplies the required runtime status, that exact P is present in its result (all pinned rows may be returned), that a pending functions cell survives parent final, that send wakes this same idle P, or that its report mapping is correct. None is certified by the synthetic tests. Missing or excessive output must stay UNKNOWN with no send; delay alone is not idle evidence. A direct caller-supplied packet is only reported evidence, as recorded in each receipt.

The factory and its pending transitions are in-memory and must remain in the same genuine owner-native process. Separate functions/Node processes do not share the object or WeakMap brand. An actual finite approved native-to-host command/observation transport and post-final lifetime admission remain required before a live experiment; this module does not create one or authorize a probe. Commands and observations are exclusive private ledger artifacts; final receipt is written once. expiresAt limits delivery, not the separately authorized engine execution.
## Opt-in finite host exchange options

`bindExactOwnerHostReturn` additionally accepts optional `statusListLimit` (integer
1..50) and `exchangeTimeoutMs` (integer 1..600000). Omission keeps the previous
binding JSON/hash, command wire with `limit:1`, and <=30000ms timeout unchanged.
The explicit host options are captured at bind time. They never alter the CLI
receiver, its timeout or its official endpoint requirements.

An explicit exchange deadline is aggregate from terminal delivery and never
resets between status and send. It is separate from `timeoutMs`, which remains
the <=30000ms observation freshness bound. In explicit finite mode the source's
status-command take time, rather than the driver's tool-completion timestamp,
is the conservative lower bound used for subsequent freshness checks. A normal
tool request can report status without exposing an internal sample timestamp;
the request-interval interpretation is host-port evidence, not authenticated
internal instrumentation. A long response can expire freshness even when it
remains inside the aggregate exchange deadline. This is HOLD, never send retry.

Explicit finite bindings also expose `holdHostReturn` for three fixed terminal
codes (`HOST_EXCHANGE_TIMEOUT`, `HOST_PACKET_INVALID`, `HOST_PACKET_IO`). It can
only finalize HOLD and cannot manufacture idle, ACK or consumption. The native
product runner uses it after a failed finite packet exchange. The existing
non-finite API remains unchanged. Runtime reachability, after-parent-final
lifetime and actual owner consumption remain separate, unproved obligations.
