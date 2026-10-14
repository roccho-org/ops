# M0 — one native Cloudflare Email Routing alias

Ref: [approved process](https://github.com/roccho-org/ops/pull/509) · [implementation GO](https://github.com/roccho-org/ops/pull/509#issuecomment-6057484444) · [envs boundary](https://github.com/roccho-org/envs/pull/58).

The goal is **one specified literal alias** on an already owned Cloudflare zone forwarded to an **Owner-verified personal Gmail**. Cloudflare Email Routing (not a Worker) handles ordinary mail. The initial M0 does **not** use Gmail API/OAuth, R2 Hot, draft UI or a sending service. This root is not live configuration until Owner-specific authority and evidence have been confirmed. Source/CI Green is not mail arrival.

## Selected After — speculative plan, automatic-plan apply

The Owner adopted [no persistent Mail plan](https://github.com/roccho-dev/adrs/issues/578#issuecomment-6143250867).
CI previews the fixed declaration with `tofu plan -input=false -lock=true
-detailed-exitcode`, without `-out`. A separately admitted future stage invokes
`tofu apply -input=false -lock=true -auto-approve` once. OpenTofu re-plans at
execution time: approval concerns convergence to the fixed commit and private
target/stage, not equality with the earlier speculative diff.

This replaces the previous requirement to retain an encrypted original plan,
transfer it through R2, inspect its ETag and approve those exact plan bytes.
No plan bucket/key, saved-plan `show`, cross-run plan transfer or new store is
required. Native output may contain private inputs and remains within the
approved private process; public CI returns only a non-secret summary.

### Structure and ownership

```text
ops/providers/mail-routing/
  main.tf                    unchanged native resources and safety guards
  .terraform.lock.hcl        unchanged provider pin
  safety.tftest.hcl          unchanged offline native checks
  README.md                  this operating contract
envs/
  adapters/mail_routing_root.py    private preview/apply helper, no activation
  checks/test_mail_routing_root.py synthetic/native proof, no real provider
  .github/workflows/operate-dev-mail-routing.yml  whole job if:false
private native process
  fixed source + protected config/credentials + one state/backend/lock
  private captures; no saved plan or plan-transfer path
```

The current envs baseline is [PR #78](https://github.com/roccho-org/envs/pull/78),
canonical `aa839299f4461382fb22abe993bed917e5bd9c7f`. The Source revision for
this contract is reviewed at its actual PR commit/tree and CI. The existing
After job remains literal `if:false` before its protected Environment, and
the public CLI unconditionally reports `INACTIVE / NOT_RUN`, exit 78.
Neither a successful Source check nor this Owner design adoption enables it.

### State, credentials and review

One Mail state owner, distinct Mail state/lock, actual backend credential
identity/scope, encryption and restore remain prerequisites. The GitHub-ref
state direction is tracked in [adrs #531](https://github.com/roccho-dev/adrs/issues/531)
and [PR #588](https://github.com/roccho-dev/adrs/pull/588); this change performs
no Mail state migration and does not remove an existing R2/S3 backend.
The existing After credential slots remain separate from private `MAIL_CONFIG`.
Its 13 fields omit plan bucket/key. No key generation, credential duplication,
new service or provider permission grant is introduced. The selected existing
envs decryption key stays upstream of setup; ordinary mail does not decrypt.

Owner approval names the fixed source, private target, managed flags and
permitted stage. Independent R reviews that declaration/context and later
reads the actual provider/state outcome. A preview is advisory and does not
authorize an apply, imply an unchanged final diff, or trigger another stage.
Private state/provider/Gmail access must be qualified before real effects.

### Equations and completion

`U` denotes missing or unapproved target/observation inputs. Do not interpret
unknown values as zero delta.

`ApplyAllowed = AdmittedActorAndSource AND OwnerFixedDeclarationStageGO AND
U=empty AND ExistingMailSafety AND SingleStateOwner AND BackendLockKeyRecovery
AND IndependentReadRoute`.

`M0_COMPLETE = ConfigAndProviderConverged AND NativeNoOpExit0 AND VerifiedGmail
AND ReadyZone AND OneEnabledLiteralRule AND DistinctSenderMailArrived
AND ForwardedAndGmailHeadersJoined AND IndependentR`.

Source/CI acceptance, actual runtime admission and live completion are separate.
Native preview exit 0 means no delta in its initialized context, 2 means a
remaining delta, and 1 is error. Apply success requires subsequent readback
and convergence; failure, timeout and unknown effect require same-resource
read-only reconciliation before a further explicitly permitted attempt.
There is no automatic retry, import, unlock, deletion or next-stage dispatch.

## Native toolchain (source-only, no credential or provider effect)

Use the published ops flake package: `nix build --no-link --print-out-paths .#packages.x86_64-linux.mail-routing-tofu`. Use its `bin/tofu`, not an ambient Terraform or downloaded binary. `nix build --no-link .#checks.x86_64-linux.mail-routing-native` tests `fmt`, `init -backend=false -lockfile=readonly`, `validate`, and a native `tofu test` with a mocked Cloudflare provider. The pinned v5.21.1 provider comes from the exact existing envs Nixpkgs revision, with Nix plugin `h1:HiX8Q7db7YrAYCuOBOMsvcmyX1RmvFqALtgJDvtYRhc=` computed from actual pinned provider bytes in [CI run 37765167569](https://github.com/roccho-org/ops/actions/runs/37765167569), in addition to official upstream ZIP hashes; neither proves real Cloudflare use. None of these commands touches a real domain.

## Inputs: type, custody, and purpose

| Name | Type / role | Custody |
|---|---|---|
| `account_id` | real Cloudflare account ID (destination is account-shared) | Owner/private `TF_VAR_account_id` |
| `zone_id`, `zone_name` | exact existing zone and name | Owner/private `TF_VAR_*` |
| `alias_address` | single literal recipient in that zone | private; no catch-all |
| `destination_address` | Owner's personal Gmail | private; sensitive value also appears in plan/state |
| `verified_destination_id` | actual **already verified** account address ID from Addresses GET; required for rule stage | Owner/private, never fabricated |
| `rule_priority` | integer after reading ALL rules/priority/source/catch-all | Owner-selected, no guessed default |
| `manage_dns`, `manage_destination`, `manage_rule` | opt-in booleans, all default false | based on observed delta and separate approval |
| `preflight_approved` | boolean, defaults false | plan guard only; **not** User effect GO |
| `CLOUDFLARE_API_TOKEN` | Cloudflare API bearer credential | envs/Owner native effect boundary; required operation×account/zone, never public/app/CI |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | R2/S3 state backend credential (not mail Hot) | private state Owner/environment |
| `AWS_ENDPOINT_URL_S3` | account-specific R2 endpoint | private backend operation environment |
| `TF_ENCRYPTION` | native state/plan encryption configuration | Owner private key custody; never logs/PR |
| backend `bucket`, `key`, `endpoints` | one identity-controlled state and lockfile | private S3 backend config, one state Owner |

The existing `dev-projection` / envs-dev Mail **Read8 binding** was admitted and completed successfully ([actual run #38121983968](https://github.com/roccho-org/envs/actions/runs/38121983968)); **all 8 steps, including `zone`, were `OBSERVED`**. This proves bounded GET only; it **does not** authorize the future After `dev-rent-tunnel` runner's distinct Account Addresses / Zone Settings / Rules **Write binding**. Nor do rent/Jev handoffs confer that authority. Do not create a per-consumer Secret; any future Write permission requires separate Owner evidence for the exact operation and target. A successful GET does not prove Write; 403 may have multiple causes. Existing IAM/owner and one exact state owner must be proven before plan.

## Required read-only preflight / branch selection

1. Owner privately supplies account/zone/domain/alias and destination. Inspect Cloudflare authoritative NS and **all** MX/SPF/DKIM/DMARC and existing mail providers; conflict means STOP, no automatic enable.
2. List account destination IDs, `verified`, cross-zone consumers; reuse an existing verified Gmail read-only. Inspect **all rules** including order, matcher, action, `source=wrangler`, catch-all. Do not import or overwrite a shared/Worker-managed rule.
3. Find the **sole existing state owner**: A existing OpenTofu root, B explicit new isolated ops root only if no owner, C Owner Dashboard-first under explicit authorization followed by **separately authorized** API read/import into A/B. GUI success does not establish state/source convergence.
4. Fix protected private state backend, lock, source/head/provider identity and `TF_ENCRYPTION`; fixed R must have an independently usable **private read-only path to Cloudflare/Gmail/state evidence before effects**. Missing target, scope, state owner, R access or GO means STOP/UNKNOWN.
5. Derive `Q_effect(C,O)` from known differences only. Existing complete configuration requires zero Write, destination verified requires zero Addresses Write, and a missing rule alone may require only zone Rules Write. **Never take unknown as an empty delta**.

## Owner-only native invocation after separate GO

**Conditional Owner-local reference, not the selected After runner.** The private-shell commands below are still valuable examples after their **separate** Owner GO, but the selected GitHub path is presently hard-inactive and has no admitted executor or qualified private input/readback path. Do not place these commands into Actions or assume Owner-local credentials exist.

The exact source root must be copied to an approved **private directory** (`$PRIVATE_MAIL_ROOT`, not a Git working tree); provide inputs through controlled private `TF_VAR_*`/var-file values and state information through a private backend config. No actual mailbox/token/backend secret in tracked source, PR, command-line arguments, publicly uploaded plan, output, or CI.

    TOOL="$(nix build --no-link --print-out-paths .#packages.x86_64-linux.mail-routing-tofu)/bin/tofu"
    "$TOOL" -chdir="$PRIVATE_MAIL_ROOT" fmt -check
    "$TOOL" -chdir="$PRIVATE_MAIL_ROOT" init -input=false -lockfile=readonly -backend-config="$PRIVATE_BACKEND_FILE"
    "$TOOL" -chdir="$PRIVATE_MAIL_ROOT" validate
    "$TOOL" -chdir="$PRIVATE_MAIL_ROOT" plan -input=false -lock=true -detailed-exitcode

After the Owner authorizes the exact fixed declaration, target and stage,
use the same pinned tool. The following invocation creates a fresh execution
plan internally and applies it; it does not consume the prior preview:

    "$TOOL" -chdir="$PRIVATE_MAIL_ROOT" apply -input=false -lock=true -auto-approve

Read back the exact affected Cloudflare Account/Zone resources and the selected state. When all required stages (including Gmail verification) are complete, confirm no further changes. `-detailed-exitcode` returns 0 only for a no-op, 2 for a remaining delta and 1 for error; do not turn either 1 or 2 into success:

    "$TOOL" -chdir="$PRIVATE_MAIL_ROOT" plan -input=false -lock=true -detailed-exitcode

If an earlier stage newly created a destination/DNS managed by this state, retain its `manage_destination`/`manage_dns` flag while planning later stages. For a changed stage, fix its declaration/context and obtain the applicable Owner GO. After a partial/UNKNOWN effect, reconcile actual provider/state read-only before another attempt.

These are **operator examples, not commands to execute without authorization**. Even `tofu plan` can access/lock private state and contact Cloudflare; separate state owner and provider access approval must precede it. Do not print a private plan/state. A change in source/target/GO after preflight requires readback and re-approval of the affected scope. Reconciliation of UNKNOWN/partial effect is **read-only first**, never blind replay.

If adopting an **existing API-owned object** into the single approved state, first independently identify the exact resource and get an explicit Owner import/lock GO. The count resources have index `[0]`:

    "$TOOL" -chdir="$PRIVATE_MAIL_ROOT" import 'cloudflare_email_routing_dns.zone[0]' '<zone_id>'
    "$TOOL" -chdir="$PRIVATE_MAIL_ROOT" import 'cloudflare_email_routing_address.gmail[0]' '<account_id>/<address_id>'
    "$TOOL" -chdir="$PRIVATE_MAIL_ROOT" import 'cloudflare_email_routing_rule.literal[0]' '<zone_id>/<rule_id>'

Each import uses the same authenticated native executable, private backend/encryption and reviewed source. Shared account Gmail address is normally **referenced** via `data.cloudflare_email_routing_address.checked`, not imported/owned or deleted.

## Mandatory stages (3 flags cannot bypass verification)

This M0 manages the zone apex. The DNS enable request uses `zone_id` and
omits optional `name`, which selects a subdomain. Passing the apex as that
payload has a reported HTTP422/code2007 failure; the failure of our earlier
live attempt was not captured and is not asserted to have that code.
See [Cloudflare's payload-free apex example](https://developers.cloudflare.com/api/resources/email_routing/subresources/dns/methods/create/)
and [provider issue5890](https://github.com/cloudflare/terraform-provider-cloudflare/issues/5890).
The mocked native plan checks that DNS `name` remains null and unrelated
resources remain absent. No provider version or ownership flag changes.

| Stage | Managed flags / state | Next-stage requirement |
|---|---|---|
| 0 read-only | all false for a new state; existing owned flags remain true | review DNS/zone MX, rules, account destinations, state identity, auth/Owner GO |
| 1 destination | set `manage_destination=true` **only for an approved NEW account address** | Cloudflare creates it → Gmail Owner explicitly clicks verification email → fresh GET yields exact ID/email and non-null `verified` |
| 2 DNS | `manage_dns=true` only for an approved missing zone-routing DNS | MX/SPF/DKIM/DMARC safe and Owner Settings Write GO → fresh GET shows Email Routing `enabled=true,status=ready` |
| 3 rule | `manage_rule=true` only after stages 1/2 are satisfied; set real `verified_destination_id` | rule's **native data sources** read verified account destination and ready zone; source preconditions fail closed otherwise |
| 4 proof | preserve all managed flags | re-plan expected no-op, zone/rule readback, one distinct sender mail + Cloudflare routing Activity Log + Gmail headers, fixed R independent private readback |

**Crucial `count` invariant:** once a new destination or zone DNS resource is owned by this state (`manage_destination=true`, `manage_dns=true`), **retain its flag=true** in later stages. Setting a previously managed count to zero plans destruction; `prevent_destroy` blocks it. Existing shared destinations remain unowned (`manage_destination=false`) throughout. A simultaneous three-flag initial apply with an unverified destination/disabled zone is **not valid**: the independent live datasource preconditions on the rule refuse creation. `depends_on` alone cannot replace asynchronous Gmail human verification.

The rule guard only proves selected destination/zone readiness. It does not prove external routing precedence, existing MX safety, GO, mail delivery or the absence of a different Owner; all those are checked independently. NEVER retry a timed-out DNS/Rule API call without a fresh same-resource readback. Unknown/failed/invalid cases remain STOP/UNKNOWN, with residual and stage-specific resume recorded in existing evidence references—no new ledger.

## Verification boundary

**Source** (credential-independent): native `fmt`, `init -backend=false -lockfile=readonly`, `validate`, mocked `tofu test`; no fake PASS without actual CI. Negative cases: default manages none; unverified Gmail; all three flags true at initial unverified/unready state; DNS unready; mismatched Gmail; preflight false. Positive: verified existing Gmail and ready DNS permit exactly one rule without recreating shared address or zone DNS.

**Live**: M0 stays **NOT_RUN/NOT_PROVEN** until the real zone-specific origin mail is sent from a different account exactly once, Cloudflare `Forwarded` Activity Log is joined with the matching Gmail headers/recipient and state/zone safe no-op readback, and fixed R independently reads actual state/provider/Gmail evidence. No Gmail API, R2 mail Hot, custom Worker or second test service.
