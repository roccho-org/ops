# Event reservoir PoC

One dedicated Cloudflare Worker, Cron and private R2 bucket. No D1, UI,
candidate generation, sending, common semantic kernel or existing Mail changes.
This is an operational observation proof, not an adopted domain event schema.
Design input: [ADRS #650](https://github.com/roccho-dev/adrs/pull/650).
Small and beautiful is a design goal; UX measurement and additional UI are not
completion requirements for this connectivity and operational-feasibility PoC.

Two independent adapters use the same immutable first-observation storage:

- HTTP retrieves the existing public X post `20` from FxTwitter. There is one
  provider and one fixed post, no search or fallback chain. HTTP errors and invalid
  provider bodies fail; they never become a successful empty result.
  Its required descriptive User-Agent is `event-reservoir-poc/1`; the API rejects
  missing identification. Errors retain the numeric upstream HTTP status only.
- Mozilla AutoPush reconnects an existing subscription, decrypts `aes128gcm` or
  legacy `aesgcm`, saves and reads back each notification, then sends its ACK.
  An expired UAID fails visibly; the Worker never registers with X or logs in.

`observations/http/` and `observations/webpush/` contain immutable JSON objects.
Keys identify a provider/post or a subscription/channel/message version.
Conditional create prevents overwrites, including concurrent attempts.
A post body and its push notification are different observations. A post URL in
known notification URL fields permits association; it does not make them equal.
The first observed body is retained; post edits, deletion history and complete
timeline capture are outside this PoC.

`state/` contains subscription continuation state and an expiring R2 CAS lease
preventing overlapping connections to the same UAID. Keys stay in Worker Secrets.
Mozilla close 4774 persists a 30-minute not-before time. Other failures can be
retried by the next scheduled run. There is no infinite retry loop.
`runs/` contains only sanitized operational receipts. Cron runs every two minutes.

## Checks

```text
node --test verification/event-reservoir-poc/tests/proof.test.mjs verification/event-reservoir-poc/tests/setup.test.mjs
nix-build verification/event-reservoir-poc/dependencies.nix --no-out-link
```

Tests cover conditional R2 creation, unchanged first bytes, upstream failure,
the independent RFC 8291 and Mozilla Firefox crypto vectors, save-before-ACK,
save/ACK interruption and reconnect, invalid UAID, overlapping receive and backoff.
The standard tool closure uses the repository's existing locked nixpkgs input;
the dedicated workflow also runs the existing CI intent/effect boundary checker
and Wrangler dry-run. Fixture results are not live X notification evidence.
The same pinned Wrangler also starts a loopback-only local workerd fixture:
both actual adapters construct real workerd Requests, Mozilla's local WebSocket
handshake completes, and HTTP replay uses local R2. Upstream responses are fixtures.
Worker fetches use `redirect: manual` and reject unexpected response statuses;
workerd deliberately does not implement Node's `redirect: error` mode.

## Live CI

The workflow `Event reservoir PoC` runs credential-free checks on push/PR.
Only explicit `workflow_dispatch` with `deploy=true` can deploy:

```text
Worker: stg-event-reservoir-poc
R2:     stg-event-reservoir-poc
Environment: cloudflare-production
Existing secret:   CLOUDFLARE_API_TOKEN
Existing variable: CLOUDFLARE_ACCOUNT_ID
Optional secret:   EVENT_RESERVOIR_WEBPUSH_SUBSCRIPTION
```

The deployment checks that the dedicated bucket has no enabled public endpoint.
It generates a separate operation token as Worker secret `PROOF_TOKEN`; the
Cloudflare API token is never used to authenticate the Worker endpoint.
`/health` only reports the source version. `/proof`, `/collect` and `/evidence`
require the operation token. Request bodies cannot select providers or targets.
No raw payload, subscription endpoint, UAID, channel ID or key is returned.

The optional subscription secret is JSON with `uaid`, `channel_id` and `keys`.
`keys` has `private_key` (32 bytes), `public_key` (65-byte uncompressed P-256)
and `auth_secret` (16 bytes), encoded as base64url strings or byte arrays.
These must come from the same X-registered subscription. Receiving needs no X
cookies. The one-time local setup below creates that subscription; CI never logs
into X. Do not put secret values in arguments, Git or CI artifacts.

## First registration on Windows

Use your ordinary PowerShell terminal with Node 22+ and the already authenticated
GitHub CLI. From this checkout, run:

```powershell
pwsh -NoProfile -File verification/event-reservoir-poc/scripts/setup-webpush.ps1
```

In your own logged-in `https://x.com` browser session, open Developer Tools →
Application → Cookies → `https://x.com` (Firefox: Storage → Cookies). Find the
values named `auth_token` and `ct0`. Paste only each value into its matching hidden
terminal prompt. Do not paste them into chat or a command. Both prompts are masked;
the wrapper passes JSON through the child's stdin, without arguments, environment
variables, logs or a cookie file. It does not read your browser profile.

The script first checks that the named GitHub environment secret does not exist,
then creates a private `%LOCALAPPDATA%\EventReservoirPoC` directory with access for
the current Windows user only. An empty directory is reusable only with that same
verified ACL. Existing files or a weaker ACL stop setup. It then creates a new
Mozilla UAID/channel and receiver keys, sends one X device-registration request,
and writes receiver JSON through stdin to:

```text
github.com/roccho-org/ops
Settings → Environments → cloudflare-production → Environment secrets
EVENT_RESERVOIR_WEBPUSH_SUBSCRIPTION
```

No manual JSON conversion or Rust installation is needed. Only `uaid`,
`channel_id`, and receiver `keys` enter the GitHub secret. The local one-time
`subscription-handoff.jsonl` retains receiver information, the opaque endpoint,
the unique PoC device ID, and non-secret stages for recovery. It contains no X
cookies. Receiver information is flushed before the X request; the file is
exclusive-create and never overwritten. Keep this file private, including on
failure. Setup does not deploy or start a CI run.

`X_REQUEST_ACCEPTED_AND_SECRET_CONFIGURED` means X returned a successful HTTP
response with JSON and no business errors, and GitHub confirmed the secret name.
It does not prove notification delivery. Follow the desired account and enable
its post notifications in X. A subsequent explicit live CI run must receive a
real notification and complete decrypt/save/reconnect/ACK evidence before the
Mozilla result or `fullPoc` can pass.

The X forms and public application/VAPID constants follow Angelic-Angel's pinned
[X registration source](https://github.com/sh1ma/Angelic-Angel/blob/169a098e2025cc6e41a50fc8d521c483e21d9b6d/src/twitter.rs)
and [Mozilla registration source](https://github.com/sh1ma/Angelic-Angel/blob/169a098e2025cc6e41a50fc8d521c483e21d9b6d/src/autopush.rs).
The receiver accepts only Mozilla's documented
[production endpoints](https://mozilla-services.github.io/autopush-rs/#autopush-endpoints).
This is a local PoC bootstrap using X's web-client interface, not an official X API
credential flow. X can reject it or change the interface; rejection is reported.

Setup never retries registration or overwrites an existing secret/subscription.
On `STOP` or an unknown result, retain the handoff and report only the status/code;
do not delete it and rerun. Recovery requires an explicit operator decision.
GitHub absence is checked again immediately before writing and the name is read
back afterward. GitHub secret creation has no create-only CAS, so use one operator
and no concurrent setup. Secret values are never read back or printed. Tests use
mock Mozilla/X/GitHub services; they do not create subscriptions or send requests.
The Windows ACL fixture also runs in an ordinary user process; Linux and
restricted AppContainer processes skip that host-specific fixture.

The live proof runs from the deployed Worker, verifies HTTP storage/replay,
then waits for two consecutive real Cron times at the deployed source version.
Before any proof POST, it waits for the same source version to accept the
operation token and read R2 through authenticated GET. Failed stages record only
HTTP status and enumerated safe codes; POST requests with unknown results are
not retried. Public health alone does not establish secret propagation.
The Mozilla proof deliberately saves the first received notification without an
ACK, disconnects, reconnects the same subscription and verifies redelivery before
saving/ACKing. All other received notifications are saved before ACKing as well.

`event-reservoir-proof-<source SHA>` contains sanitized evidence with separate
`http`, `cron`, `mozilla` and `fullPoc` results. Without an actual X notification,
the result is `PARTIAL`; `require_webpush=true` (the default) makes acceptance
fail. An HTTP-only infrastructure check may explicitly set it false, but this
never changes `fullPoc` to true. Cron can legitimately receive zero notifications.
Two successful connections alone do not prove actual notification delivery.

Disconnected delivery depends on the sender's actual TTL and Topic replacement.
There is no all-posts/no-loss guarantee. The receive window and recent receipt
listing are bounded (`/evidence?since=<epoch milliseconds>`, default past hour);
older receipts do not block a new proof. This PoC is not a permanent monitoring
or archival service. The live resources remain for inspection; cleanup, rotation
and enabling public bucket access are not automatic workflow actions.

References: [x-lookup](https://github.com/mynameistito/x-lookup),
[Angelic-Angel](https://github.com/sh1ma/Angelic-Angel),
[current Mozilla protocol architecture](https://mozilla-services.github.io/autopush-rs/architecture.html),
[RFC 8291](https://www.rfc-editor.org/rfc/rfc8291.html),
[Mozilla interoperability vector](https://github.com/mozilla/gecko-dev/blob/master/dom/push/test/xpcshell/test_crypto.js).
