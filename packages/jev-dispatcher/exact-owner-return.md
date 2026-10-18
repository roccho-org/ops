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
