# Managed ATS read-only tool host contract v1

Status: contract freeze
Date: 2026-09-22
Owners: AETHER-CLOUD, Aether-Agent, ATSv2, Agent Browser
Capability scope: foreground, read-only tools only

## 1. Purpose and release boundary

This contract defines the first Cloud-to-local managed-agent tool path. One
admitted model run may invoke one bounded local read-only ATS tool while the
owning user has an attached foreground Agent session. The typed result returns
to the same managed-agent conversation without creating execution authority.

MUST, MUST NOT, SHOULD and MAY are normative.

The following are outside v1:

- paper-order review, approval, submit, cancel or reconciliation;
- live-capital execution;
- broker or provider credentials and account enumeration;
- strategy activation or executable market evidence;
- background or daemon tool hosting;
- browser actions.

Missing, stale, mismatched or unqualified dependencies make the tool
unavailable. They never trigger a fallback transport or broader capability.

## 2. Canonical ownership

### 2.1 AETHER-CLOUD

Cloud owns authenticated account and managed-agent identity, conversation and
run identity, model and UVT admission, host-session lease issuance, model tool
offering, invocation correlation, durable call deduplication, result custody and
DM delivery.

Cloud MUST NOT derive trading authority from a DM, agent profile, host lease,
tool manifest or tool result. V1 exposes no order mutation route.

### 2.2 Aether-Agent

Agent owns the enrolled local foreground host, terminal/session lifecycle,
account-switch teardown, local resource leases, strict envelope validation,
bounded invocation, a non-authoritative replay cache and safe display.

Agent MUST NOT mint a Cloud lease, ATS capability, execution plan, approval,
grant, order receipt or broker state. It MUST NOT infer missing tool arguments
from chat text.

### 2.3 ATSv2

ATSv2 owns authenticated runtime capability truth and read-only ATS status. In
later contracts it remains the sole owner of strategy activation, executable
evidence, risk, provider/account bindings, execution grants, plans, approval
consumption, broker adapters, order idempotency, the execution ledger,
reconciliation and kill-switch state.

Agent and Cloud may transport or project ATSv2 facts, but cannot replace them.

### 2.4 Agent Browser

Agent Browser owns browser session custody and observation receipts. Page text
and pixels are untrusted data. Browser observation is not part of the first v1
canary and cannot be advertised until an owner-bound browser session contract
binds Cloud origin, account, agent, device, local session and run.

## 3. Non-authority invariants

None of the following grants execution authority:

- ATS policy acceptance;
- the Agent plan, skip or danger preference;
- a Cloud DM, admitted model run or UVT allocation;
- a host lease, manifest, capability receipt or successful read tool;
- memory readiness or a writer lease;
- installed, scanned or compiled strategy source;
- configured research data;
- a browser connection, screenshot or page text;
- a prior result or cached receipt.

Every v1 schema containing a boolean named grants_execution_authority MUST set
it to false. No v1 object may carry an order, approval, broker credential, raw
account number or execute_live flag.

## 4. Common wire rules

All v1 objects are closed. Unknown fields fail validation. There is no generic
extensions object on a lease, invocation, cancellation, result or capability.

- Canonical JSON is RFC 8785 JSON Canonicalization Scheme.
- Strings containing lone surrogates, control characters or invalid Unicode
  fail before canonicalization.
- A digest is sha256 followed by a colon and 64 lowercase hexadecimal digits.
- A timestamp is UTC RFC 3339 with exactly millisecond precision and a trailing
  Z.
- IDs are 8 to 128 printable ASCII characters from A-Z, a-z, 0-9, period,
  underscore, colon and hyphen, beginning with an alphanumeric character.
- JSON integers are limited to the interoperable range 0 through 2^53 - 1.
- Floating-point numbers, NaN, Infinity and exponent notation are forbidden in
  contract objects. Decimal values use canonical decimal strings.
- Arrays, strings, object depth, arguments, results and errors have explicit
  schema bounds. Validation happens before logging or dispatch.
- A digest preimage is the ASCII schema identifier, a newline, then the RFC
  8785 bytes of the object with its own digest or signature field omitted.
- Python and TypeScript implementations MUST pass the same checked-in golden
  byte and digest vectors.

account_scope_digest is derived exactly as:

sha256("aether.account-scope/1\\n" + JCS({"cloud_origin_id": origin,
"account_subject": subject})).

origin is the normalized lowercase HTTPS origin with no path, query, fragment
or trailing slash. subject is the canonical subject returned by the
authenticated Cloud identity endpoint. The raw subject is used only for this
local derivation, never crosses the portable tool contract and cannot be
supplied by a model.

### 4.1 Cloud and device trust bootstrap

Cloud lease signatures use Ed25519 as specified by RFC 8032. Signatures and
public keys use unpadded base64url. The signed bytes are the ASCII schema ID, a
newline, then RFC 8785 bytes with cloud_signature omitted.

Agent discovers Cloud verification keys only from the configured origin at
/.well-known/aether-managed-tool-host-v1.json over validated HTTPS. That closed
document uses schema aether.managed-tool-trust/1 and contains generated_at,
expires_at and one or more {key_id, algorithm, public_key} rows. algorithm MUST
be Ed25519. Unknown keys, expired key sets, redirect to another origin, TLS
failure or fetch failure makes host creation unavailable. Cached keys may be
used only until expires_at.

Host enrollment uses EnrolledDeviceProofV1, schema
aether.managed-tool-device-proof/1. Required fields are cloud_origin_id,
account_scope_digest, device_id, device_public_key, issued_at, expires_at,
revocation_epoch, signature_key_id and cloud_signature. Cloud signs it with the
same rules. It also carries proof_digest, computed by the common digest rule
with proof_digest and cloud_signature omitted. device_id MUST use the scdev_
namespace. The Agent holds the
matching Ed25519 private key in an owner-private OS-backed key store; absence of
that key makes the host unavailable.

Cloud supplies a 32-byte random base64url challenge with a five-minute maximum
expiry. Agent proves key possession by signing the ASCII string
aether.managed-tool-host-open/1, a newline, then RFC 8785 bytes of
{challenge, device_proof_digest, agent_id, conversation_id, local_session_id,
session_generation, registry_digest}. The challenge is single-use. Cloud
verifies the device proof, scope, revocation epoch, expiry and possession
signature before issuing a host lease.

### 4.2 ATS observer trust bootstrap

ATS capability uses observer channel aether.ats.observer-channel/1. Agent sends
a 32-byte random challenge through ATS-MCP's private authenticated local
channel. ATS returns a closed ObserverChannelReceiptV1 containing channel_id,
runtime_id, runtime_version, runtime_build_digest, challenge, capability_digest,
issued_at, expires_at, authentication exactly ats_mcp_private_credential and
receipt_digest. The private credential remains outside every contract object.

Agent accepts RuntimeCapabilityV1 only when the receipt challenge matches, the
receipt is fresh, capability_digest matches, the configured ATS credential
authenticated the response and runtime_build_digest matches the loaded build.
attestation_kind is exactly ats_observer_channel_v1 and attestation_ref is the
ObserverChannelReceiptV1 receipt_digest.

## 5. RuntimeCapabilityV1

Schema: aether.ats.runtime-capability/1.

This object describes runtime support. It grants no authority.

Required fields:

- runtime_id, runtime_version and runtime_build_digest;
- attestation_kind and attestation_ref from an ATS-authenticated channel;
- supported_read_operations, a closed array of versioned operation IDs;
- effective_execution_mode: observe, paper, approve, auto or unknown;
- supports_paper_execution and supports_live_execution;
- observed_at and expires_at;
- grants_execution_authority, false;
- capability_digest.

supports_* describes implementation support, not permission. In v1,
supports_live_execution MUST be false at the host boundary. A stale or
unverified capability blocks execution-related projections, but MUST NOT hide
bounded diagnostic status that reports degraded or unavailable state.

Agent MUST NOT self-assert ATS runtime identity. Capability is accepted only
from the configured ATS-authenticated observer channel and only for the exact
loaded build digest.

## 6. ToolRegistryManifestV1

Schema: aether.managed-tool-registry/1.

Required top-level fields:

- registry_id, account_scope_digest, agent_id and device_id;
- local_session_id and session_generation;
- created_at and expires_at;
- tools;
- grants_execution_authority, false;
- registry_digest.

Each tool entry requires:

- name and version;
- input_schema_id, input_schema_digest, output_schema_id and
  output_schema_digest;
- effect_class, exactly read_only in v1;
- dependencies from the closed set foreground_session, verified_account,
  ats_profile, memory_writer, ats_runtime and browser_observer;
- max_argument_bytes, max_result_bytes and max_duration_ms;
- data_classes from the closed set local_status, ats_status and
  untrusted_browser_observation;
- grants_execution_authority, false.

max_argument_bytes is an integer from 2 through 65,536,
max_result_bytes is an integer from 256 through 65,536, and max_duration_ms is
an integer from 1 through 30,000. A tool may declare a lower bound. These are
hard envelope limits, not hints.

Cloud and Agent select one exact name, version and schema-digest tuple. Unknown
versions, digest drift and duck typing fail closed.

A tool is listed only while all of its declared dependencies are live. Resource
requirements are per tool; registry presence does not make one resource a proxy
for another.

## 7. HostSessionLeaseV1

Schema: aether.managed-tool-host-lease/1.

The lease authorizes only short-lived routing to one foreground local host. It
is not a trading credential.

Required fields:

- lease_id and host_session_id;
- cloud_origin_id and account_scope_digest;
- agent_id and enrolled device_id;
- local_session_id, session_generation and revocation_epoch;
- conversation_id for routing;
- registry_digest;
- issued_at, expires_at and max_calls;
- capabilities, exactly local_read_tools;
- grants_execution_authority, false;
- signature_key_id and cloud_signature.

Conversation identity is routing metadata, not authority. The account, agent,
device, local session, generation, registry and expiry jointly define the
lease scope.

The local_ browser-owner fallback is not an enrolled device and MUST NOT open a
tool host. V1 requires a same-origin scdev_ identity with a valid
EnrolledDeviceProofV1 and proof of possession of its enrolled private key.

Cloud signs the canonical lease. Agent validates the signature, key ID, origin,
scope, generation and expiry before accepting an invocation. Closing or
revoking a lease increments its fencing generation or revocation epoch; an old
lease can never be adopted by a restarted session.

## 8. ToolInvocationV1

Schema: aether.managed-tool-invocation/1.

Required fields:

- request_id and cloud_tool_call_id;
- lease_id, host_session_id, session_generation and revocation_epoch;
- cloud_origin_id, account_scope_digest, agent_id and device_id;
- local_session_id, conversation_id and run_id;
- sequence;
- tool_name and tool_version;
- input_schema_id and input_schema_digest;
- arguments and arguments_digest;
- issued_at, deadline_at and nonce;
- invocation_digest.

arguments MUST satisfy the exact registered schema and size bound. The model
cannot select a local path, runtime, browser session, provider or account;
resource identifiers are injected by the bound host after validation.

deadline_at is absolute and includes queue time. An AbortSignal is never placed
on the wire.

Forbidden fields and values include prompts, reasoning, credentials, cookies,
raw account subjects or numbers, arbitrary provider tool names, source code,
local paths and unfiltered page/provider payloads.

## 9. ToolCancellationV1

Schema: aether.managed-tool-cancellation/1.

Required fields:

- cancellation_id, cloud_tool_call_id and invocation_digest;
- lease_id, host_session_id, session_generation and revocation_epoch;
- reason: user_cancelled, run_cancelled, session_closed, lease_revoked or
  deadline_exceeded;
- issued_at;
- cancellation_digest.

Cancellation is authenticated, idempotent and fenced by the lease generation.
Agent derives its local AbortSignal from chat shutdown, host shutdown, the
named cancellation and remaining absolute deadline.

Cancellation for one call cannot cancel a different call. Agent records a
terminal result with an atomic first-terminal-record-wins compare-and-swap. A
success durably recorded before cancellation remains the stored success and is
redelivered. Cancellation or deadline durably recorded first wins; any later
tool completion is discarded and MUST NOT replace it with success.

## 10. ToolResultV1

Schema: aether.managed-tool-result/1.

Required fields:

- result_id, request_id and cloud_tool_call_id;
- lease_id, host_session_id, local_session_id, session_generation,
  revocation_epoch and run_id;
- tool_name, tool_version, input_schema_id and input_schema_digest;
- invocation_digest and arguments_digest;
- state: succeeded, refused, cancelled, deadline_exceeded or unavailable;
- payload, output_schema_id and output_schema_digest, nullable unless
  succeeded;
- error, nullable unless state is not succeeded;
- evidence_refs, a bounded array of opaque safe references;
- replay_status: fresh, stored_redelivery or interrupted_before_result;
- retry_class: none, redeliver_stored_result or new_call_after_recovery;
- started_at and completed_at;
- bounded_bytes and redaction_profile;
- grants_execution_authority, false;
- result_digest.

error is a closed object containing code and a bounded safe display message. It
contains no exception body, path, token, page content or provider response.

code MUST be one of the stable failure codes in section 14. The safe display
message is 1 to 256 characters. evidence_refs contains at most 16 opaque IDs.
bounded_bytes is the canonical serialized result size as an integer from 0
through the registered max_result_bytes. redaction_profile is exactly
aether.safe-display/1.

When state is succeeded, payload, output_schema_id and output_schema_digest are
non-null and error is null. For every other state, those three output fields
are null and error is non-null. retry_class is redeliver_stored_result only for
a stored completed result; new_call_after_recovery never permits replay of the
same cloud_tool_call_id.

A succeeded payload MUST validate against the exact output_schema_id and
output_schema_digest registered for the selected tool version. Missing or
mismatched output identity makes the result unavailable, never succeeded.

V1 read-only calls have no financial uncertain state. If Agent restarts after a
call was claimed but before its result was durably stored, the same call becomes
unavailable with replay_status interrupted_before_result and is never invoked a
second time.

## 11. Initial tool: ats_workspace_status

The first canary registry contains only ats_workspace_status version 1. Its
input schema ID is aether.ats.workspace-status-input/1 and accepts exactly an
empty object with no properties.

Its manifest dependencies are foreground_session, verified_account and
ats_profile. It does not declare memory_writer, ats_runtime or browser_observer,
so it remains available to report those resources as degraded or unavailable.

Its output schema ID is aether.ats.workspace-status/1. The object is closed and
contains exactly:

- schema, exactly aether.ats.workspace-status/1;
- observed_at;
- binding_digest;
- local, containing only memory and strategies;
- data;
- browser;
- runtime;
- execution_authority, exactly none;
- orders_enabled, false;
- grants_execution_authority, false;
- diagnostics;
- status_digest.

local.memory is closed with state ready, degraded or unavailable;
configured_gib as null or an integer from 1 through 16,384; and writer_lease as
held, lost, not_held or unavailable. It contains no path.

local.strategies is closed with state scanned or unavailable; count as an
integer from 0 through 10,000; compiler as native_ats or unavailable; and
execution_enabled, always false. It contains no path, filename, source or
diagnostic body.

data is closed with research_configuration as configured, not_configured or
unavailable; last_probe as fresh, stale, failed, never or unavailable; and
executable_evidence, exactly unavailable.

browser is closed with state available, unavailable or cleanup_required. It
contains no URL, page text, screenshot, browser owner or session ID.

runtime is closed with state ready, degraded, unavailable or unknown and
effective_execution_mode as observe, paper, approve, auto or unknown. The mode
is supplied only by ATS; Agent UI preferences cannot populate it.

diagnostics is an array of at most 16 closed objects. Each contains code, a
1-to-64-character uppercase ID; severity as info, warning or error; and a safe
display summary of 1 to 256 characters. No arbitrary detail field exists.

binding_digest is derived as:

sha256("aether.ats.workspace-status-binding/1\\n" + JCS({
"account_scope_digest": account_scope_digest, "agent_id": agent_id,
"device_id": device_id, "local_session_id": local_session_id,
"session_generation": session_generation})).

status_digest follows the common digest rule with status_digest omitted.

The host injects the account/agent-scoped settings and strategy directory. A
model cannot provide either. Strategy scan is compile/preparation status only;
it does not activate a strategy.

Maximum serialized result size is 64 KiB. The result MUST NOT contain prompts,
strategy source, full paths, raw account identifiers, credentials, environment
values or provider payloads.

## 12. Protocol lifecycle

1. Agent verifies the account and typed ATS profile, acquires required local
   resources and resolves the canonical managed-agent conversation.
2. Agent opens an outbound authenticated host connection. V1 opens no inbound
   listener and no browser/VNC route.
3. Cloud verifies origin, account, agent and enrolled device, then accepts the
   exact registry manifest and issues a short-lived lease.
4. Cloud offers only manifest tools to a compatible admitted model run while
   the lease and dependencies remain live. An unadmitted or text-incompatible
   run sees no local tool.
5. Cloud persists the invocation key and body before delivery.
6. Agent validates signature, scope, generation, sequence, registry, schema,
   size, deadline and digest before claiming the call.
7. Agent durably claims the call before reaching the backing read-only tool.
8. Agent invokes at most once, persists ToolResultV1 before delivery, then sends
   the exact stored result with cloud_tool_call_id as the idempotency key.
9. Cloud stores the result before completing model/DM delivery. Delivery retry
   reuses the stored result and never creates another local invocation.
10. Teardown stops admission first, closes the Cloud host lease, aborts active
    calls, waits a bounded interval, closes browser resources, releases the
    memory writer lease, and only then aborts the outer chat lifecycle signal.

Account switch, logout, host-lease identity loss, device-proof revocation,
expiry or conversation close begins step 10 immediately.

Loss of an individual resource such as the writer helper, ATS runtime or
browser observer removes only tools that declare that dependency. Agent
publishes a new manifest with an incremented session generation; Cloud revokes
the old lease before issuing one bound to the new registry digest. A diagnostic
tool that does not require the lost resource remains available to report the
degraded state. If a core dependency of every registered tool is lost, the host
closes.

An offline or expired foreground host returns unavailable. Cloud MUST NOT queue
an invocation for a later process, device or session generation.

## 13. Idempotency, replay and custody

Cloud's canonical invocation key is the tuple:

account_scope_digest, agent_id, device_id, host_session_id, local_session_id,
session_generation, revocation_epoch, run_id, cloud_tool_call_id, tool_name,
arguments_digest.

Cloud persists invocation and result records. Agent keeps a bounded,
account/agent-scoped, symlink-safe local claim/result cache so replay cannot
reinvoke after reconnect or process restart.

- Same key and invocation digest with a completed result returns the stored
  result.
- Same key with different bytes is a protocol conflict and closes/refuses the
  call.
- A claimed call with no durable result after restart is
  interrupted_before_result and cannot run again.
- Result delivery may retry only with the byte-identical stored body and key.
- A DM delivery failure never reaches the backing tool.
- Sequence replay is ignored only when its exact digest is already known.
- A sequence gap, rollback or conflicting replay fails closed and tears down
  the host.

ATSv2 owns a separate order idempotency namespace in later execution contracts.
Tool-call IDs never authorize or identify an order.

## 14. Transport and failure semantics

The host connection is Agent-originated over authenticated TLS. It has a
versioned handshake, bounded heartbeat, sequence cursor, lease renewal and
explicit close. It cannot downgrade to legacy DM polling or coding dev-session
routes on 403, 404, protocol mismatch or capability absence.

Stable failure codes:

- TOOL_CONTRACT_INVALID;
- TOOL_SCOPE_MISMATCH;
- TOOL_LEASE_EXPIRED;
- TOOL_LEASE_REVOKED;
- TOOL_REGISTRY_MISMATCH;
- TOOL_SEQUENCE_INVALID;
- TOOL_IDEMPOTENCY_CONFLICT;
- TOOL_UNKNOWN;
- TOOL_ARGUMENT_INVALID;
- TOOL_DEADLINE_EXCEEDED;
- TOOL_CANCELLED;
- TOOL_DEPENDENCY_UNAVAILABLE;
- TOOL_RESULT_TOO_LARGE;
- TOOL_DELIVERY_UNAVAILABLE.

Unknown codes fail operationally. Errors never become success. Retry metadata
cannot authorize another invocation of the same call.

## 15. Browser observation follow-up

aether_browser_observe is not in the first canary manifest.

Before it can be added, BrowserSessionBindingV1 must bind Cloud origin,
account_scope_digest, agent, enrolled device, local session, session generation,
run, browser owner and expiry. The host injects the bound browser identity; the
model never supplies a session UUID.

The tool remains observation-only, freshness-bounded and size-bounded. Its
result is untrusted_browser_observation and cannot provide price, account, fill,
strategy, approval or execution authority.

## 16. Required tests

### Common contract fixtures

- identical Python and TypeScript canonical bytes and digests;
- closed-schema and unknown-version refusal;
- Unicode, decimal, timestamp, ID, depth and size boundaries;
- signature, expiry, generation and revocation fencing;
- arguments and result digest conflicts.

### AETHER-CLOUD

- account/agent/device ownership and foreground lease expiry;
- tools offered only after compatible run admission and a live exact manifest;
- text-only, unadmitted, expired and absent-host runs see no local tools;
- invocation persisted before delivery;
- same-call dedupe, conflicting replay refusal and result custody;
- DM delivery retry does not create another invocation;
- cancellation, host close and no delayed replay into a new generation;
- no order, approval, credential or execution mutation route.

### Aether-Agent

- contract parsing, closed fields, bounds and safe errors;
- conversation-known hook order and exact account/agent/device binding;
- durable claim, completed-result redelivery and interrupted-call refusal;
- sequence replay/gap, deadline and targeted cancellation;
- account switch, logout, chat close, lease loss and writer-helper death;
- tool host closes before browser/memory resources and outer abort;
- ordinary agents never load or advertise ATS tools;
- ats_workspace_status exact empty input and 64 KiB safe projection;
- no paths, source, prompt, page/provider payload, secrets or execution
  authority in outputs.

### ATSv2

- authenticated capability names the exact runtime build;
- read-only status operations are bounded and secret-redacted;
- degraded status remains readable while execution-related facts fail closed;
- no delegated review/submit tool appears in the E1 registry.

### Cross-repository canary

One admitted compatible model turn invokes ats_workspace_status exactly once
and receives its stored typed result in the same managed-agent DM. Tests cover
result delivery loss, reconnect, cancellation, account switch, lease expiry,
process restart before and after result persistence, and duplicate Cloud
delivery. The measured duplicate local invocation count must be zero.

## 17. Sequential landing order

1. Merge the common encoding, capability, manifest, lease, invocation,
   cancellation, result schemas and golden fixtures.
2. Cloud implements enrolled foreground host leases, model tool-offer gating,
   durable call dedupe, cancellation, result custody and DM redelivery. The
   feature remains disabled.
3. ATSv2 exposes authenticated bounded read-only capability/status adapters.
   No activation, review or submit tool enters E1.
4. Agent implements the outbound foreground host, durable local replay cache,
   post-conversation hook, ordered teardown and ats_workspace_status.
5. Run the exact-commit cross-repository canary and failure battery, then enable
   only the workspace-status tool for qualified accounts.
6. Define and qualify BrowserSessionBindingV1 before adding browser observation.
7. Begin E2 data-probe and strategy-activation contracts only after E1 is green.
8. Begin delegated paper review/approval integration only after E1 and E2 are
   green, reusing ATSv2's controller, grants, durable approval/lifecycle stores
   and paper fill evidence. Agent remains a host and operator UX, never a second
   broker, risk engine, ledger or kill switch.

A later dependency MUST NOT merge ahead of a failed earlier gate. Work inside a
numbered step may fan out only after the shared schemas and golden fixtures for
that step are frozen.

## 18. Definition of done

V1 is done only when the same admitted managed-agent run can discover exactly
one live, owner-bound read-only workspace-status tool, invoke it once, receive a
bounded typed result in the same DM, survive replay/delivery/restart drills with
zero duplicate local invocations, and close immediately on account, session,
device or lease-identity transitions. Loss of an individual optional resource
must remove its dependent tools through a newly fenced manifest while leaving
independent diagnostic tools available to report degradation.

Passing v1 proves no broker connectivity, paper execution or live trading.
