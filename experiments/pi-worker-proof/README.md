# Worker Pi / Jev finite correction proof

Inference stays on the existing Cloudflare Worker. SQLite conversation history is durable; ChatGPT access is volatile. The native owner runs explicit commands with protected local credentials, no daemon/keepalive, Tunnel, new auth API, local inference or replacement session.

[PR619](https://github.com/roccho-org/ops/pull/619) records canonical source/runtime/privacy evidence and the two retained failed model admissions. [Source decision6305587796](https://github.com/roccho-org/ops/pull/619#issuecomment-6305587796) authorizes this correction, keyless tests and new PR only. Actual User continuation/budget authority is recorded separately; source acceptance alone never sends a prompt or deploys.

## Actual transport gap

[Cloudflare Request](https://developers.cloudflare.com/workers/runtime-apis/request/) supports only `follow` and `manual`: `error` throws TypeError during Request construction, including inside fetch. The old Responses and Jev proof wrappers used unsupported `redirect: "error"`. Replacement fetch fixtures had ignored those options, hiding the platform gap. Actual attempt2 was recorded TRANSPORT/httpnull; source diagnosis does not invent its historical provider status, completion or billing.

Both existing wrappers now use native `manual` and reject every3xx without reading Location/body/cookies or following. Responses records its actual HTTP status BEFORE that guard; the guard is outside the native-fetch catch, so HTTP307/308 cannot become TRANSPORT. Canonical Jev client and the existing terminal redaction callback remain unchanged. A per-stream trace associates the same terminal message through frozen lazyStream/Harness; absent association is UNKNOWN, never provider-text inference.

Tests separate actual workerd Request/error rejection + native manual401 via the existing no-egress backstop from synthetic307/308 wrapper behavior. The latter stubs must construct native Request(input,init), check manual and one call/no follow. Frozen plugin has no legacy fetchMock; no MSW/dependency/config is added and native307 is not claimed.

## Protected credentials and finite continuation

Custody remains `/home/dev/.config/pi-worker-owner/registration.json`, directory0700/file0600, native owner1001 under the same OS flock. Root/same-UID readers are trusted. Every initial/returning exchange and permitted refresh uses durable SAME-record IN_DOUBT before token POST, then fsync/private temporary/rename/directory-fsync atomic replacement. Unknown results survive restart without rotating-token replay. No code/PKCE/auth URL is stored.

The frozen MIT Pi OAuth derivation retains validated subject/issued-client/host and actual expiry/earliest metadata, reuses the issued client, validates optional refreshed identity without an old nonce, rejects native token redirects and redacts diagnostics. Workspace association is registered-client semantics, not an invented subject/email workspace claim. Existing Worker Access verification is unchanged. No DevKit implementation is imported/copied. Independently authored numeric-seconds/ISO timing uses [pinned provider schema evidence](https://github.com/openai/sign-in-with-chatgpt-devkit/blob/0a36fefeb913055c8c7a1a29b63d82b96b2e841a/packages/local/src/index.ts#L100), waits for BOTH actual expiry and earliest permitted bound, and rejects unknown/malformed timing.

Existing login/reauth/refresh stages and prior seed/reconcile/forensic/history evidence remain. A WS/open can resume paid engine work BEFORE a prompt; it is never called read-only. No UNKNOWN prompt is automatically resent.

The correction candidate permits **5 TOTAL model admissions**: two retained historical failures plus three prospective Responses for seed2 and recall1. Jev remains1 per SAME conversation. This is four overall user inputs including the two old failures, not an original clean two-input execution. Counter/allowance is never reset/refunded, and no operational/unattended product budget is claimed.

`seed --continue --recover-transport-once` consumes a DISTINCT protected mark; it never rearms old `--recover-seed-once`. SAME lock requires the retained original UNKNOWN/reconciliation/forensic/history and consumed seedRecovery UNKNOWN with its already saved actual conversation ID. Effective access >30s is checked BEFORE durable admission. Marker presence even null/false refuses. The whole old proof remains nested in the new mark; local failure/crash/restart consumes it.

Actual authorized upgrade must report canonical boot/prior-token=false/posts2. Only the same saved ID in a unique eligible existing inventory can be opened once. Its current two-user/two-error/no-completed/no-Jev/no-pending/activity snapshot is revalidated before a fresh high-entropy prompt. Entries must map exactly pi.user/pi.system/pi.assistant to single message roles: user/system/error,user/[clock-only system]/error. Frozen clock rendering may add that second minute delta; static/tool patches, edits/head/reset or other entries refuse. The latest assistant must contain the trusted own attempt2/TRANSPORT/httpnull envelope, never provider prose.

Healthy new seed requires two distinct completed responses, one correlated typed actual Jev result and Pi consumption; offset2 is saved. A subsequent actually permitted local refresh/native restart and real DO recreation must witness new boot/priorfalse/posts4, reopen that SAME ID and neutrally recall exact marker AND typed assessment without values/history reinjection, ending posts5 with three distinct successful response IDs. Any error/UNKNOWN stops; no create/fork/new session or retry.

```mermaid
flowchart TB
  Owner["👤 Native owner protected credentials"] --> WS["🔐 Existing WS; transient bearer; explicit continuation"]
  WS --> Pi["☁️ SAME Worker/session; TOTAL5 admissions"]
  Pi --> Jev["🔧 One actual Jev; Pi consumes typed result"]
  Jev --> Store["💾 SAME conversation SQLite commits"]
  Store --> Rotate["🔄 Permitted native refresh; durable save; process restart"]
  Rotate --> Recall["🧠 Real new DO; neutral exact marker+assessment recall"]
  Recall --> Done["✅ Finite correction proof; two old failures retained"]
```

```mermaid
flowchart TB
  Old["🧾 Actual failures1+2; all UNKNOWN marks retained"] --> Fix["🛠️ Both wrappers manual/reject3xx; DISTINCT transport once"]
  Fix --> Tests["🧪 Actual platform option/native401 + synthetic redirects + keyless lifecycle"]
  Tests --> Review["🔍 Exact CI/artifacts/native; independent Root/R"]
  Review -->|finding| Fix
  Review --> Canonical["📦 Reviewed Ops/envs → separately activated merges/canonical distributions"]
  Canonical --> Deploy["☁️ Standard same-runtime deployment; fresh current/privacy acceptance"]
  Deploy --> Seed["🌱 Explicit correction once; saved ID; posts2→4; actual Jev"]
  Seed --> Refresh["🔄 Later permitted refresh; native exit/real idle"]
  Refresh --> Recall["🧠 New DO/same ID; neutral exact recall; posts4→5"]
  Recall --> Done["✅ Actual finite proof only"]
  Seed -->|error / UNKNOWN| Stop["🛑 Preserve admissions/audits; no automatic resend"]
  Refresh -->|error / UNKNOWN| Stop
  Recall -->|error / UNKNOWN| Stop
```

Keyless independent-process/crash/loopback and real Session workerd fixtures do not prove actual credential rotation, Jev or live durable memory. Source/CI acceptance grants no effects; actual current receipts remain separate. CI uses the existing normal/selected/privacy suites and exact source/checksum manifests; no native workerd PASS is inferred from Ubuntu CI. Only the new branch is added to the existing workflow watcher and its strict ci.intent declaration.

Policy adrs@6e4abcd22dbee397105625b6041ce1a0d4720182. No ops523/Jev-quality/full-product completion claim. Primary basis: [SIWC Terms](https://openai.com/policies/sign-in-with-chatgpt-terms/), [registration/identity](https://developers.openai.com/siwc/token-sharing-open-source/sign-in), [profiles/serialized rotation](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions), [token reference](https://developers.openai.com/siwc/token-sharing-open-source/token-reference), [VM guidance](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms). Managed-DO credential custody remains unestablished; selected native custody/transient same-user/app access is an interpretation, not endorsement or blanket remote-storage conclusion.

## OpenCode Go API-key route — new source candidate

The completed OAuth proof remains COMPLETE on its original session/cap5. This candidate adds one explicit server mode, provider `opencode-go`, model `gpt-6-luna`, new fixed session `owner-jev-opencode-proof-20261021` and a monotonic three-model/one-Jev proof. Key presence never selects or falls back to this mode. Existing frozen provider/model/decoder is reused with the current fixed base `https://opencode.ai/inference/go/openai/v1`; the provider adds `/responses`. No SIWC body transform runs in API mode.

The existing owner-verified WS remains. Both model and Jev pre-send paths require the same live accepted-owner socket lease; constructor/alarm/recovered work starts unadmitted and last socket close/error revokes. Already in-flight effects can remain UNKNOWN and are never refunded/replayed. Keys remain standard Worker bindings, never DO state, WS tokens, browser payloads or logs. API prior-owner witness does not claim the bound API key disappeared.

`owner.mjs --stage opencode --continue --url https://pi.roccho.workers.dev/ --session owner-jev-opencode-proof-20261021 --cloudflared <existing-path>` branches before native profile/home/custody/OAuth loading. It performs a real small JavaScript review and Jev code-risk assessment, closes the WS and waits180s without probes/keepalive, then requires actual new boot/prior-owner=false/posts2 and opens the same conversation. Recall contains only a neutral request about the prior review, with no code/case ID/expected values/history reinjected. Exact findings/case ID/typed assessment, distinct completed response IDs and final measured posts3 are required. The native process keeps nonsecret expectations only in memory; this API-key test does not claim a process-restart credential proof.

Existing SQLite ProviderDoc supplies the durable provider session. Each actual native fetch checks the effective nonempty `x-opencode-session` and actual Pi UA; the existing per-stream terminal association overwrites any lookalike with a noncredential header digest. The client checks equality across the three actual completed responses but prints only booleans, never header/digest/key. No second identity ledger or paid status probe is added.

`package-runtime.py OUT --opencode` produces a separate `pi-opencode-runtime-SHA` artifact. Existing OAuth/screen artifacts retain their contracts. API source metadata declares explicit mode/provider/model/session, current base and limit3; runtime requires both OPENCODE_API_KEY and existing Jev binding and rejects OAuth bootstrap/transient selection.

Key delivery and actual account/model/tool entitlement remain UNRESOLVED/NOT RUN. Existing envs dev-authoring key metadata is not a Worker binding. Root's companion reuses reviewed author→public SOPS→project machinery for a narrow new Worker destination; no old OCI recipient eligibility, host key copy or permission widening is assumed. Source/CI can proceed without keys. Later exact accepted canonical composition, separately activated standard registration/deployment and actual proof are required; no paid hello/catalog200 substitutes.

```mermaid
flowchart TB
  Owner["👤 Existing owner Access"] --> Pi["☁️ Existing Worker · explicit OpenCode Go mode"]
  Key["🗝️ Standard Worker secret · delivery unresolved"] --> Pi
  Pi <--> Model["🧠 Existing provider · GPT 6 Luna · current fixed base"]
  Pi <--> Jev["⚡ Actual typed code-risk assessment"]
  Pi <--> Store["💾 Same conversation + SQLite provider identity"]
  Store --> NewDO["♻️ Real new DO · same ID and wire identity"]
  NewDO --> Recall["🧠 Neutral exact code-review recall"]
```

```mermaid
flowchart TB
  Design["📚 Resource audit + three-party counters"] --> Source["🛠️ Meaningful minimal source PR"]
  Source --> Tests["🧪 Real Session wire/tools/recreation/privacy and no-owner refusal"]
  Tests --> Review["🔍 Independent exact head/artifact/native review"]
  Review -->|finding| Source
  Review --> Canonical["📦 Accepted canonical Ops/envs distributions"]
  Canonical --> Key["🔐 Separately admitted standard key projection"]
  Key --> Deploy["☁️ Standard deploy + current/privacy readback"]
  Deploy --> Seed["🌱 Actual code review + Jev consumption · posts0→2"]
  Seed --> Idle["🌙 Disconnect/no probes · actual new DO"]
  Idle --> Recall["🧠 Same conversation · neutral exact recall · posts2→3"]
  Recall --> Done["✅ Separate finite API proof · old COMPLETE retained"]
  Key -->|unresolved| Hold["🛑 Preserve current runtime"]
  Seed -->|error/UNKNOWN| Stop["🛑 No automatic resend/fallback/reset"]
  Recall -->|error/UNKNOWN| Stop
```

Primary current references: [Go contract/endpoints](https://opencode.ai/v2/docs/console/go/), [native Pi provider](https://opencode.ai/v2/docs/console/harnesses/pi/), [inference API](https://opencode.ai/v2/docs/console/api/inference/). Genuine coding-agent traffic, own UA and stable conversation headers are required; a generic memory challenge is not relabeled. Keyless native/workerd tests do not establish live entitlement or quality. No browser-chat UX or unattended operational budget claim is added.

## Explicit PAYG correction after the retained Go refusal

The selected workspace has existing positive standard credits and an active key; Go entitlement was never established. Actual Go admission1 returned403; its precise provider cause remains UNKNOWN. Official Pi distinguishes `opencode` PAYG from `opencode-go` subscription workspaces, both using the same existing key. The frozen SDK already provides `opencode/gpt-6-luna` Responses/tools. This explicit correction uses current standard base `https://opencode.ai/inference/openai/v1`; it does not retry another endpoint automatically.

`--stage opencode-credit-recover --continue` stays before all local credential operations. It requires posts1/prior-owner=false, reads automatic root/inventory, opens only the unique actual existing conversation and verifies the settled one-user/one-system/one-error history with the own attempt1/HTTP403 envelope, no completed response, Jev, pending work, edits or unrelated activity. No create/fork/reset occurs. The existing prompt command updates only the stored agent model through public configure before submitting new input; transcript and ProviderDoc remain. All owner/physical-fetch/privacy gates remain.

The distinct `--opencode-credit` package produces `pi-opencode-credit-runtime-SHA`, scope KEY_BOUND_SELECTED_OWNER_OPENCODE_CREDIT_RUNTIME, provider opencode, limit4, recovery_start_offset1 and the SAME proof session. Historical admission1 remains consumed; new successful seed2/3 and recreated neutral recall4 require three fresh distinct response IDs, actual typed Jev consumption and equal outbound routing identity. Old Go3/cold strict0 and completed OAuth5 routes remain separate. The immutable key delivery receipt's historical opencode-go.pi-worker name is not an entitlement claim; no key move/reauthoring is needed.

This is one explicitly reserved manual invocation with no competing operator, not durable crash-safe retry orchestration. Any crash/failure is UNKNOWN, with no automatic resend, rearm, refund or new session. Source/CI mocks do not prove actual entitlement or completed inference.
