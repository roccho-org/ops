# M0 — one native Cloudflare Email Routing alias

Ref: [approved process](https://github.com/roccho-org/ops/pull/509) · [implementation GO](https://github.com/roccho-org/ops/pull/509#issuecomment-6057484444) · [envs boundary](https://github.com/roccho-org/envs/pull/58).

The goal is **one specified literal alias** on an already owned Cloudflare zone forwarded to an **Owner-verified personal Gmail**. Cloudflare Email Routing (not a Worker) handles ordinary mail. The initial M0 does **not** use Gmail API/OAuth, R2 Hot, draft UI or a sending service. This root is not live configuration until Owner-specific authority and evidence have been confirmed. Source/CI Green is not mail arrival.

## Selected After candidate — SOURCE only, **hard inactive**

The Owner selected **After** for a *future manual GitHub Mail operation*. This is an operating-contract change, **not a working runner**. Authority: [P's bounded Source GO](https://github.com/roccho-org/ops/pull/517#issuecomment-6118788844) and [accepted envs storage/runner report r2+r3](https://github.com/roccho-org/envs/pull/68). The already adopted [envs S1 source](https://github.com/roccho-org/envs/pull/73) was merged into `proposals@7b63bd5af0a6c91fed3cef1c80ac64f6af7d63f7` (tree `62d930995cf8a3d1abfc332cbf12b29da99c3565`). Its manual job has literal **`if: false` before its protected Environment**, and its native `mail-routing-root` entry unconditionally returns `INACTIVE` / exit **78**, before reading any secret or starting a child. A dispatch, an allowed branch or a matching GitHub actor is **not** Owner plan review or Effect admission. The existing `dev-rent-tunnel` Environment has **required reviewers OFF** (P-observed; not an independent fixed-R/W private readback).

### Completed / conditional dirtree

~~~text
roccho-org/ops @ proposals:2a05f23c9aa9a26c48a373f76b2fa662f8d4b4ad
└─ providers/mail-routing/
   ├─ README.md                [THIS PR] After candidate / custody / gates
   ├─ main.tf                  [EXISTING, UNCHANGED] opt-in native routing
   ├─ .terraform.lock.hcl      [EXISTING, UNCHANGED] pinned provider
   └─ safety.tftest.hcl        [EXISTING, UNCHANGED] offline source tests

roccho-org/envs @ proposals:7b63bd5af0a6c91fed3cef1c80ac64f6af7d63f7
├─ .github/workflows/operate-dev-mail-routing.yml
│                              [EXISTING S1] manual, job if:false
├─ adapters/mail_routing_root.py
│                              [EXISTING S1] unconditional exit 78
└─ contracts/environments.jsonl [EXISTING] rent slots; NOT Mail admission

CONDITIONAL — NOT CREATED / NOT PROVEN:
  future Mail-specific admitted job and source integration (S2–S4)
  separate Mail state object + native .tflock (possibly same physical R2 bucket)
  approved state principal and private Mail encryption-key custody
  original encrypted saved plan / Owner + fixed R independent private access
  separate exact-plan apply admission and Cloudflare/Gmail evidence
~~~

This README-only slice changes **no** native resource, provider, lock, workflow, credentials, runtime adapter, state backend or toolchain. S2–S4 are future **Source proposals requiring their own P GO, head/tree/checks and fixed-R acceptance**. Do not treat S1 `if:false` / exit 78 as an activation toggle this PR can lift.

### Storage and protected boundaries: suitability ≠ adoption

| Boundary | Known evidence / selected candidate | Missing activation condition |
|---|---|---|
| Physical R2 bucket | Owner/P observed an existing private rent-IaC bucket and one historical state object. **Conditional reuse of that physical bucket is preferred**, not approved. [Owner read-only checkpoint](https://github.com/roccho-org/envs/pull/68#issuecomment-6106836383) | One approved Mail state owner, **different state object key and native `.tflock`**, no modification to rent state, recovery and exclusive writer evidence. Separate object ≠ separate access authority |
| Backend credential | Existing `dev-rent-tunnel/AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` slots could be read **inside a future individually admitted named job**, never exported/copied. Two same-named active R2 tokens were observed as metadata, not uniquely matched to the Mail principal; earlier expiry metadata is not current usability proof | Owner establishes credential **identity, scope, expiration, other-workload exposure, lock rights and restore** from private non-secret evidence; no new key, token or Secret copy. Never assume automatic prefix isolation |
| Cloudflare provider authority | **Existing `dev-projection` / envs-dev Mail Read8 binding was admitted and succeeded**: [actual run #38121983968](https://github.com/roccho-org/envs/actions/runs/38121983968), [P checkpoint #6106754638](https://github.com/roccho-org/envs/pull/68#issuecomment-6106754638), [fixed-R review #5482401306](https://github.com/roccho-org/envs/pull/68#pullrequestreview-5482401306). **All 8 surfaces including the selected zone were `OBSERVED`**. `token_active=true`, `routing_enabled=false`, `routing_ready=false`, destinations 0/verified 0, rules 1/enabled 0. Write authority and mail arrival remained `NOT_PROVEN`. That admitted GET binding **is not** the proposed `dev-rent-tunnel` After runner's provider binding or Write authority. Rent's Cloudflare slot is separate. | Exact future After named actor, source/target/provider binding, Account Addresses + Zone Settings/Rules **operation-specific Write** rights and independent readback; no automatic promotion, scope expansion or Secret copy |
| Encryption key | `main.tf` enforces state/plan encryption; a rent passphrase file was observed by P through metadata only. Its bytes, recovery and Mail use were not proven | Mail `TF_ENCRYPTION` key **identity/custody/restore NOT_SELECTED / NOT_PROVEN**; never default to `RENT_STATE_PASSPHRASE`, `RENT_STATE_KEY`, SOPS age or rent state object |
| Original private plan and R access | No approved private saved-plan original store or fixed-R independent private read route has been selected | **Before any state/provider/plan effect:** independently usable Owner-approved fixed-R read-only route and original-plan custody/ACL must be established; no saved original exists yet. **After separately authorized plan, before exact-plan apply:** Owner and fixed R inspect the **same saved encrypted original** against source/target/state. **After apply:** R independently reads actual receipts. Public CI/artifacts/PR are not plan/state storage |

The storage assessment is **`REPORT_ACCEPTED / R2_ADOPTION_NOT_PROVEN`**, not a decision to initiate an S3/R2 backend. [Accepted fixed-R r2](https://github.com/roccho-org/envs/pull/68#pullrequestreview-5482483435) · [fixed-R r3](https://github.com/roccho-org/envs/pull/68#pullrequestreview-5483076980). Existing slots belong to rent: their presence is **not** proof of current credential identity, Mail access rights, independent Mail key, protection or recovery. The Environment's branch restriction, same-human P/R/W GitHub principal and reviewers-OFF setting do **not** constitute human authorization. No second IaC state owner, credential exporter, broker or shadow ledger.

### Responsibility and admission equations

Let `D` = manual dispatch, `I` = pinned canonical source/actor/ref/first attempt, `H=false` = current whole-job hard-off, `A=false` = current native refusal, `C` = Owner-approved target, `O` = provider readback, and `U` = missing observations.

- `CurrentJobAdmission = D ∧ I ∧ H = false`; `CurrentEntryAdmission = A = false`. **SOURCE/CI Green does not activate these.**
- `SafePlan = (U=∅) ∧ ExistingMailSafety ∧ SingleStateOwner ∧ SeparateMailStateAndLock ∧ BackendCredentialIdentityAndScope ∧ MailKeyCustodyAndRecovery ∧ FixedRPrivateReadRoute`.
- `FuturePlanAdmission = AcceptedFutureRunnerSource ∧ NamedMailActorAdmitted ∧ SafePlan ∧ SeparateOwnerPlanAndLockGO`. Even `init` / `plan` may access private state and lock; this needs future **effect-specific authority**.
- `FutureExactApplyAdmission = FuturePlanAdmission ∧ EncryptedSavedOriginalPlan ∧ OwnerReviewedOriginal ∧ FixedRReviewedOriginal ∧ SourceTargetStateProviderIdentityReadback ∧ SeparateOwnerGOForThisExactPlan`. The owner reviews **the same saved original** that is applied; a CI success or hand-copied plan-hash flag is not an activation receipt.
- `M0_COMPLETE = DesiredAndObservedConfigMatch(C,O) ∧ VerifiedGmailDestination ∧ OneDistinctSenderMailArrived ∧ CloudflareForwardedAndGmailHeadersJoined ∧ FixedRIndependentReadback`. No source or plan-only result satisfies this.

**Actor / custody and strict ordering:** P/Owner selects the future named Mail job, source, state owner, credential authority, Mail key and original-plan custody. **(1) Before any state/provider/plan effect**, Owner establishes an independently usable private read-only route for fixed R to inspect the eventual original and its state/target context; this does **not** pretend the plan exists yet. **(2) After a separately authorized plan effect**, Owner and fixed R inspect the **actual same encrypted saved original** before **(3) a distinct Owner GO for this exact-plan apply**. **(4) After any permitted effect**, fixed R independently reads provider/state/Mail receipts. **W** owns only scoped source correction. The shared GitHub login does not distinguish chat P/R/W roles. A fail/timeout/UNKNOWN requires same-resource **read-only reconciliation** before any subsequent action, never implicit retry or token substitution.

### Named source composition — `MAIL_AFTER_SOURCE_COMPOSE` (SOURCE only)

The composed SOURCE boundary is a **pair of reviewed immutable Git states**, not an invocation or a manually copied hash gate. For the candidate README change, the `ops` exact head/tree are resolved from **this PR #531 at review time** and repeated in its PR body **after** the commit exists (never precompute a self-referential README commit SHA).

| Input to named gate | Exact immutable source / required evidence |
|---|---|
| `OPS_README` | [ops PR #531](https://github.com/roccho-org/ops/pull/531) on `codex/mail-m0-after-runbook-20261012`; selected candidate HEAD/tree from its **current PR body**; bootstrap `proposals@2a05f23c9aa9a26c48a373f76b2fa662f8d4b4ad` / tree `3f383abe68a00467ec8f8af8467f5a7c971663d6`; only `providers/mail-routing/README.md` may differ |
| `OPS_NATIVE_UNCHANGED` | `main.tf` blob `bf7d90ddd1c2a2b63e47ece40b5409e24ca9b125`; `.terraform.lock.hcl` blob `4994a1a2967771935c94bcca83752ffebe78e2ff`; `safety.tftest.hcl` blob `04db81a38059da98bb07a397727cf0fb291e5b29`; ops `flake.nix` blob `da3bfbf5255e3570900eaf36f93ec986638822b1`, all equal the ops bootstrap |
| `ENVS_S1` | canonical `proposals@7b63bd5af0a6c91fed3cef1c80ac64f6af7d63f7` / tree `62d930995cf8a3d1abfc332cbf12b29da99c3565`; [canonical check #38210958426](https://github.com/roccho-org/envs/actions/runs/38210958426) terminal success, [canonical P proof #6118812019](https://github.com/roccho-org/envs/pull/73#issuecomment-6118812019), actual Mail job `if:false` **before** protected Environment and CLI unconditional exit 78 |
| `OPS_ACCEPTANCE` | current **same-head ops required CI**, independent fixed-R review, P review and W same-version adoption of this precise one-file operating contract; no other source/authority change |

`MAIL_AFTER_SOURCE_COMPOSE = ExactOpsREADME ∧ NativeBlobsUnchanged ∧ CanonicalEnvsS1Accepted ∧ OpsSameHeadCI ∧ FixedR/P/WSourceAcceptance ∧ BothHardOffPreserved`.

**Refuse SOURCE composition** when any named head/tree/base or native blob differs, the envs canonical CI/proof is absent or red, an S1 hard-off guard/exit 78 is relaxed, ops same-head required CI/reviews are missing or failing, more than the README changes, private provider/state data is published, or an Effect/plan admission is silently inferred from SOURCE. The refusal identifies **which input failed**, without adding a ledger, broker, manual plan hash, or any operation. A CI/test pass alone does **not** establish R/P/W adoption.

**Distinct real-world gates:** `MAIL_AFTER_SOURCE_COMPOSE` may become `SOURCE_ACCEPTED` while `CurrentJobAdmission=CurrentEntryAdmission=false`, `A5=NOT_ADMITTED`, and all private-plan prerequisites remain unproved. `FuturePlanAdmission` requires a later accepted admitted runner, Owner's private R read route **before plan**, and separate plan/state/lock GO; `FutureExactApplyAdmission` requires Owner/fixed R inspection of the **actual post-plan encrypted original before exact apply**, separate GO, then later independent readback. No Source→activation circularity or delegated effect authority.

### Completion verification (SOURCE / admission / LIVE are separate)

| Gate | Exact evidence required | Current status |
|---|---|---|
| `S0 README SOURCE` | Only this README changed; actual branch/head/tree, same-head required CI, fixed R/P/W review of this operating contract | **Current PR: CI/R/P adoption pending** |
| `S1 native hard-off` | envs S1 canonical merge, job `if:false`, independent native exit 78 and same-source checks | **SOURCE accepted; Job/EntryAdmission=false** |
| `S2 target and provider` | Private Owner account/zone/alias + safe MX/rule/destination facts, selected Cloudflare actor and minimal operation permissions | **NOT_SELECTED/NOT_PROVEN** |
| `S3 state/storage` | Single Mail state owner; unique object/`.tflock`, selected credential scope/expiry/recovery; rent isolation | **R2 ADOPTION_NOT_PROVEN** |
| `S4 encryption/plan/R` | Owner selects Mail key/restore, private original-plan custody and independently usable fixed-R read route **before plan**. The **actual original plan** exists only after separately authorized plan, then Owner/R review it **before exact apply** | **NOT_SELECTED/NOT_PROVEN** |
| `S5 future runner SOURCE` | Separate P Source GO; meaningful future runner implementation with exact commit/tree, CI and fixed R/P/W Source acceptance. This source may be accepted **while its job and CLI remain hard-off** | **NOT_IMPLEMENTED / current S1 hard inactive** |
| `A5 future runtime admission` | Separate Owner authority verifies effective named-job/actor admission, protected inputs, chosen key/state principal, and exact state/provider plan/lock permissions **after** source acceptance. This is a separate actual readiness/effect gate, **not S5 Source success** | **NOT_ADMITTED / NOT_PROVEN** |
| `S6 Effect and mail` | Separate original-plan apply GO, native no-op/readback, verified Gmail, single forwarded test mail/headers and fixed-R B5 | **NOT_RUN / M0_NOT_PROVEN** |

The existing `$TOOL` examples below are **conditional Owner-local reference procedures only**. Under the selected After path they are *not* GitHub commands, a private plan artifact design, or an automatically admitted runner. The future job's actual Source, private original-plan custodian and separate admission must be reviewed **before** adapting these commands.

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
4. Fix protected private plan/state backend, lock, source/head/provider identity and `TF_ENCRYPTION`; fixed R must have an independently usable **private read-only path to Cloudflare/Gmail/state evidence before effects**. Missing target, scope, state owner, R access or GO means STOP/UNKNOWN.
5. Derive `Q_effect(C,O)` from known differences only. Existing complete configuration requires zero Write, destination verified requires zero Addresses Write, and a missing rule alone may require only zone Rules Write. **Never take unknown as an empty delta**.

## Owner-only native invocation after separate GO

**Conditional Owner-local reference, not the selected After runner.** The private-shell commands below are still valuable examples after their **separate** Owner GO, but the selected GitHub path is presently hard-inactive and has no admitted executor, private plan custodian or human review path. Do not place these commands into Actions or assume Owner-local credentials exist.

The exact source root must be copied to an approved **private directory** (`$PRIVATE_MAIL_ROOT`, not a Git working tree); provide inputs through controlled private `TF_VAR_*`/var-file values and state information through a private backend config. No actual mailbox/token/backend secret in tracked source, PR, command-line arguments, publicly uploaded plan, output, or CI.

    TOOL="$(nix build --no-link --print-out-paths .#packages.x86_64-linux.mail-routing-tofu)/bin/tofu"
    "$TOOL" -chdir="$PRIVATE_MAIL_ROOT" fmt -check
    "$TOOL" -chdir="$PRIVATE_MAIL_ROOT" init -input=false -lockfile=readonly -backend-config="$PRIVATE_BACKEND_FILE"
    "$TOOL" -chdir="$PRIVATE_MAIL_ROOT" validate
    "$TOOL" -chdir="$PRIVATE_MAIL_ROOT" plan -input=false -lock=true -out="$PRIVATE_ENCRYPTED_PLAN"

After the Owner independently reviews the saved encrypted plan, confirms the exact source/state/credential scope has not changed, and grants the **stage-specific APPLY GO**, execute the **reviewed saved plan** using the same pinned tool. This is a human-operated effect, not a CI command or automatic next step:

    "$TOOL" -chdir="$PRIVATE_MAIL_ROOT" apply -input=false -lock=true "$PRIVATE_ENCRYPTED_PLAN"

Read back the exact affected Cloudflare Account/Zone resources and the selected state. When all required stages (including Gmail verification) are complete, confirm no further changes. `-detailed-exitcode` returns 0 only for a no-op, 2 for a remaining delta and 1 for error; do not turn either 1 or 2 into success:

    "$TOOL" -chdir="$PRIVATE_MAIL_ROOT" plan -input=false -lock=true -detailed-exitcode

If an earlier stage newly created a destination/DNS managed by this state, retain its `manage_destination`/`manage_dns` flag while planning later stages. For a changed stage, regenerate a new reviewed saved plan and get the applicable Owner GO; never replay a prior saved plan after a partial/UNKNOWN effect.

These are **operator examples, not commands to execute without authorization**. Even `tofu plan` can access/lock private state and contact Cloudflare; separate state owner and provider access approval must precede it. Do not print a private plan/state. A change in source/target/GO after preflight requires readback and re-approval of the affected scope. Reconciliation of UNKNOWN/partial effect is **read-only first**, never blind replay.

If adopting an **existing API-owned object** into the single approved state, first independently identify the exact resource and get an explicit Owner import/lock GO. The count resources have index `[0]`:

    "$TOOL" -chdir="$PRIVATE_MAIL_ROOT" import 'cloudflare_email_routing_dns.zone[0]' '<zone_id>'
    "$TOOL" -chdir="$PRIVATE_MAIL_ROOT" import 'cloudflare_email_routing_address.gmail[0]' '<account_id>/<address_id>'
    "$TOOL" -chdir="$PRIVATE_MAIL_ROOT" import 'cloudflare_email_routing_rule.literal[0]' '<zone_id>/<rule_id>'

Each import uses the same authenticated native executable, private backend/encryption and reviewed source. Shared account Gmail address is normally **referenced** via `data.cloudflare_email_routing_address.checked`, not imported/owned or deleted.

## Mandatory stages (3 flags cannot bypass verification)

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

**Live**: M0 stays **NOT_RUN/NOT_PROVEN** until the real zone-specific origin mail is sent from a different account exactly once, Cloudflare `Forwarded` Activity Log is joined with the matching Gmail headers/recipient and state/zone safe no-op readback, and fixed R can read independently obtained private originals. No Gmail API, R2 mail Hot, custom Worker or second test service.
