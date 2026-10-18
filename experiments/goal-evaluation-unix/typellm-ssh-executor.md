# Fixed target TypeLLM executor

`bindTypeLLMSSHExecutor` supplies `executeTyped` to the existing
`bindTypeLLMExecutorPorts`. It starts the existing SSH executable with a strict
alias and a fixed remote command: `ops-typellm --envs-sha <40hex> --ops-sha
<40hex> --response-metadata`. No request, key, arbitrary remote program, shell
expression or caller-selected child argument enters that command. Local
`shell: false` does not remove SSH's remote shell: the remote words are fixed
constants and validated lowercase hexadecimal pins. Existing SSH configuration
and authentication remain in use; they are not replaced by this adapter.

Before a real call, separately verify the alias's actual configuration (including
ProxyCommand/Match exec), existing trusted host key, installed command resolution,
wrapper revision, both source pins, privileges and finite real-case admission.
The adapter records these configuration choices as **DECLARED_ONLY**. A successful
SSH exit or a public response field does not prove that deployment binding.

Use a pre-existing private absolute `ledgerDir`. Its final component must be a
normal directory. Private ownership, ACLs and all parent components must be
admitted by the caller; this is not an ACL-hardening service. One stable ledger
must be shared by all attempts for a run UUID. The persisted binding includes
both pins, alias, executable, deadline and maximum calls. Each sequence from 1 to
`maxCalls` (at most five including a proposal) is atomically claimed across both
kinds and factories. Existing, partial, unknown and crashed claims cannot be
deleted or retried. Changing the ledger location or run UUID is not an automatic
recovery mechanism. Concurrent different sequences are possible; a higher-level
comparison must enforce its prescribed lane order and judgment seals.

Each claim preserves `request.stdin`, `response.stdout`, `response.stderr` and a
flat `receipt.json` using CreateNew writes. The JSON-value request SHA differs
from the actual JSON-plus-LF stdin SHA. Stdout and stderr are piped into bounded
prefix files (1 MiB and 16 KiB); overflow fails, marks capture incomplete, and
retains the original prefix. Observed-byte counters are lower bounds after a
stop. File writes handle short writes. No raw case-bearing file is printed or
published by this module. Its receipts and originals belong in private storage,
outside Git and public artifacts.

The stderr cap includes SSH and launcher/build diagnostics, not just the metadata
frame. A noisy build can therefore fail before a model call. Any target build or
cache preparation needs its own admitted operations and burden accounting; the
adapter does not retry or raise a limit to force the case through. These byte
caps are transport limits, not model-context or input-fit budgets.

Only physical exit 0, completed stdin write, one normalized JSON stdout line,
and one exact flat CLI metadata frame can return a value. Duplicate, malformed,
missing or mismatched frames fail without another SSH call. The CLI frame must
match actual complete stdin bytes/SHA and use the expected SDK observation
schema. The existing outer SDK still validates answer shape, usage and limits.
The inner CLI observation remains in this transport receipt; it is not an
observation on a newly revalidated outer result object. Public model/id strings
are provider reports, including when a test double reports them. Backend identity
stays UNKNOWN. Pin a compatible SDK and launcher; an old CLI or absent frame is
a contract failure, not permission to retry the provider.

Timeout, abort, output overflow and IO failure can kill the local SSH child.
After any spawn attempt, remote work, cancellation and costs remain UNKNOWN.
After a stop it waits at most another 250 ms for physical close. If close is not
observed, it closes its pipe handles, unreferences the child, records UNKNOWN
exit and incomplete capture, and returns failure. A false/throwing kill is
recorded; the local child may still be running. Late events cannot revise the
final receipt. This is a bounded caller wait, not a guarantee that a process or
remote provider stopped. The adapter never retries. It excludes four provider-key environment variables
without reading their values, but does not certify the remaining SSH environment
as secret-free. It does not read target API keys, create an HTTP provider facade,
start a daemon, activate an automation, allocate evaluation ordinals, alter
settings/grants, or return to a different Codex session in place of the exact P.

Source and synthetic process-stream evidence alone do not complete G1/G2, the
original three-lane comparison, actual model-use identity, Jev input-fit gates or
product-triggered idle return to P session/thread
`01a1335f-a200-7d22-9467-22492cdda617`.
