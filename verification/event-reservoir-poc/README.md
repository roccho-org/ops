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
node --test verification/event-reservoir-poc/tests/proof.test.mjs
nix-build verification/event-reservoir-poc/dependencies.nix --no-out-link
```

Tests cover conditional R2 creation, unchanged first bytes, upstream failure,
the independent RFC 8291 and Mozilla Firefox crypto vectors, save-before-ACK,
save/ACK interruption and reconnect, invalid UAID, overlapping receive and backoff.
The standard tool closure uses the repository's existing locked nixpkgs input;
the dedicated workflow also runs the existing CI intent/effect boundary checker
and Wrangler dry-run. Fixture results are not live X notification evidence.

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
These must come from the same existing X-registered subscription. Receiving needs
no X cookies. Initial X registration and notification settings remain a separate
explicit setup action. Do not put secret values in arguments, Git or CI artifacts.

The live proof runs from the deployed Worker, verifies HTTP storage/replay,
then waits for two consecutive real Cron times at the deployed source version.
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
