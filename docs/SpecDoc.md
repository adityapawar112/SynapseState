# Product Specification Document: SynapseState

**Document Version:** 3.0.0-GA-SPEC  
**Engineering Classification:** Incident-Safety, Governance & Lifecycle Platform for OpenFeature  
**Primary Language Ecosystem:** Pure TypeScript / Node.js Monorepo  
**Licensing Baseline:** 100% Permissive Open Source (Apache 2.0)  

---

## 1. Document Control, Revision History & Scope

### 1.1 Revision History

* **v1.0.0-DRAFT:** Initial design sketch covering shared-memory sidecars and dual-plane GitOps.
* **v2.0.0-GA-SPEC:** Monorepo architecture featuring a Go control plane, Kubernetes mutating webhook, native sidecar daemon (`synapse-agent`), local Unix domain sockets, and custom in-process evaluation engines in Go and TypeScript.
* **v3.0.0-GA-SPEC (Current Architecture):** Post-pivot governance-layer architecture:
  * **Evaluation Delegation:** Replaced custom evaluation engines and targeting languages with direct delegation to standard OpenFeature providers (such as flagd in-process, JSON file provider, or Unleash). SynapseState acts as an `OverrideProvider` wrapper.
  * **Elimination of Sidecars & IPC:** Removed in-pod sidecar daemons (`synapse-agent`), mutating admission webhooks, and local Unix domain socket IPC. Workload SDKs communicate directly with the Control API over ETag long-polling (`wait=30s`).
  * **Unified TypeScript Ecosystem:** Unified entire platform onto TypeScript/Node.js across SDK, CLI, Control API, Purger, and Next.js Dashboard.
  * **Pinned Keyset Trust Root:** Overrides are signed by operator Ed25519 keys and validated against a locally pinned, Git-audited keyset file, ensuring compromise of the Control API cannot lead to forged overrides.
  * **Dual-Clock Expiry Enforcement:** Combined monotonic elapsed time with wall-clock bounds to ensure zero leases survive past their intended lifespan.
  * **Read-Only Codebase Scanner:** Focused `synapse-purger` on telemetry qualification and read-only AST scanning, exporting structured candidate reports for external refactoring tools with zero untrusted code execution.
  * **Incident Attribution ("What Changed?"):** Added pull-based `synapse log` CLI investigation and `GET /v1/changes` change feed with shared pure ranker to provide type-aware mitigation commands.

### 1.2 Target System Boundaries

SynapseState delivers a self-hosted incident-safety and lifecycle governance layer for Kubernetes microservices utilizing OpenFeature.

The v3.0 release targets server-side microservices running Node.js / TypeScript. Additional runtimes (Go, Python, Java) will adopt the language-neutral lease format in future minor versions.

### 1.3 Explicit Non-Goals (Out of Scope)

* **Custom Flag Evaluation:** SynapseState does not evaluate targeting rules, user contexts, or percentage rollouts. Evaluation is completely delegated to an underlying OpenFeature provider.
* **Client-Side / Mobile SDKs:** Internal rulesets and keysets never egress to untrusted browsers or mobile devices.
* **Web-Based Flag Authoring:** Baseline flag definitions remain strictly authored in Git.
* **Autonomous Code Merges:** All code cleanup actions generate Draft Pull Requests. Automated direct merges to master branches are prohibited.
* **Per-Evaluation Network Syscalls:** Evaluated entirely in-process from memory.

---

## 2. Competitive Positioning Matrix

| Dimension | flagd / OpenFeature Operator | Unleash (Self-Hosted OSS) | Uber Piranha | LaunchDarkly Enterprise | SynapseState v3.1 Specification |
|---|---|---|---|---|---|
| **Primary Classification** | Evaluation engine & sync daemon | Full feature-management platform | Batch AST refactoring tool | Commercial SaaS platform | **Incident safety & lifecycle governance layer** |
| **Evaluation Strategy** | In-process or socket RPC | In-process SDK cache | N/A (Build-time tool) | In-process SDK cache | **Delegates to existing OpenFeature provider** |
| **Emergency Overrides** | Re-deploy or CRD edit | Dashboard toggle (bypasses Git) | N/A | Dashboard toggle (bypasses Git) | **Ed25519-signed leases with dual-clock auto-expiry & air-gapped fallback** |
| **GitOps Drift Defense** | K8s CRD authoritative | Database authoritative | N/A | SaaS DB authoritative | **Git authoritative; PR promotion acts as 2nd approval** |
| **Stale Detection** | None | Manual UI review | None (Requires flag as input) | UI stale markers | **Telemetry-driven; per-flag evaluated consumer coverage (35-45d)** |
| **Code Cleanup Support** | None | None | Multi-language refactoring | Manual PR required | **Read-only AST scanner generating candidate reports for Piranha/GritQL** |
| **Transport Model** | gRPC sync stream | HTTP polling (15s default) | N/A | Streaming connection | **ETag long-polling (`wait=30s`) with in-memory caching** |
| **Trust Model** | Unauthenticated sync in baseline | Service token authentication | N/A | API key authentication | **Git-pinned keyset with 10s hash polling & signed key revocations** |

---

## 3. Cryptographic Lease Protocol Specification

### 3.1 Envelope & Canonicalization (RFC 8785)
All emergency leases are represented as JSON objects. Before signing, the payload is serialized according to RFC 8785 (JSON Canonicalization Scheme).

#### Lease Payload Schema
```json
{
  "v": 1,
  "lease_id": "01J9X57YTRPQ8A7F4E12345678",
  "env": "prod",
  "flag_key": "checkout-v2",
  "value": false,
  "reason": "INC-142: Database connection pool exhaustion",
  "issued_at": "2026-10-06T02:14:00.000Z",
  "ttl_seconds": 1800,
  "kid": "sre-alice-2026-01",
  "nonce": "NzkxZDJiODRhYTgzYTAyMzg4Y2M5"
}
```

#### Envelope Schema
```json
{
  "payload": { ... },
  "sig": "MEQCID7w...base64url-encoded-ed25519-signature..."
}
```

#### Domain Separation
Signatures are calculated over:
$$\text{SignatureBytes} = \text{Ed25519\_Sign}(\text{PrivateKey}, \text{"synapsestate/lease/v1\textbackslash{}n"} \parallel \text{RFC8785}(\text{payload}))$$

Revocations use domain prefix `"synapsestate/revocation/v1\n"` over canonical revocation payload:
```json
{
  "v": 1,
  "lease_id": "01J9X57YTRPQ8A7F4E12345678",
  "revoked_at": "2026-10-06T02:25:00.000Z",
  "kid": "sre-alice-2026-01",
  "reason": "Incident resolved early"
}
```

Signed key revocations use domain prefix `"synapsestate/keyrevocation/v1\n"` over canonical key revocation payload:
```json
{
  "v": 1,
  "kid": "compromised-key-id",
  "revoked_at": "2026-10-06T02:25:00.000Z",
  "revoked_by_kid": "security-lead",
  "reason": "Laptop reported lost"
}
```

### 3.2 Dual-Clock Verification Algorithm
Workload SDKs enforce strict monotonic and wall-clock expiry bounds:

1. **Version & Keyset Lookup:** Verify `v == 1`. Reject if `kid` is present in local `key_revocations`. Lookup `kid` in locally pinned keyset. Reject if key is missing or revoked.
2. **Signature Verification:** Verify Ed25519 signature over domain-separated canonical payload.
3. **TTL Validation:** Verify $0 < \text{ttl\_seconds} \le \min(\text{SDK\_MAX\_TTL}, \text{key.max\_ttl\_seconds})$.
4. **Anti-Future Skew Check:** Reject if $\text{issued\_at} > \text{now\_wall} + \text{SKEW\_TOLERANCE}$ (default 30 seconds).
5. **Wall-Clock Expiration (Global Ceiling):**
   $$\text{wall\_expiry} = \text{issued\_at} + \text{ttl\_seconds} + \text{SKEW\_TOLERANCE}$$
   If $\text{now\_wall} \ge \text{wall\_expiry}$, mark lease expired.
6. **Monotonic Expiration (Per Process Incarnation):** On first successful verification of `lease_id` within the current process:
   $$\text{mono\_expiry} = \text{now\_mono} + \text{ttl\_seconds}$$
7. **Effective Expiration:**
   $$\text{effective\_expiry} = \min(\text{wall\_expiry}, \text{mono\_expiry})$$
8. **Evaluation Activation:** An override is applied if and only if $\text{now\_mono} < \text{mono\_expiry}$ and $\text{now\_wall} < \text{wall\_expiry}$ and `lease_id` is not present in local revocations. Conflict resolution between active leases selects `MAX(issued_at)` then `MAX(ULID)`.

---

## 4. In-Process SDK Architecture (`@synapsestate/sdk`)

### 4.1 Provider Wrapper (`OverrideProvider`)
`OverrideProvider` wraps any OpenFeature `Provider`:

```typescript
export class OverrideProvider implements Provider {
  readonly metadata = { name: 'synapsestate-override-provider' };

  constructor(
    private readonly delegate: Provider,
    private readonly leaseStore: LeaseStore,
    private readonly options: SdkOptions
  ) {}

  async resolveBooleanEvaluation(
    flagKey: string,
    defaultValue: boolean,
    context: EvaluationContext
  ): Promise<ResolutionDetails<boolean>> {
    try {
      const activeLease = this.leaseStore.getActiveLease(flagKey);
      if (activeLease && typeof activeLease.value === 'boolean') {
        return {
          value: activeLease.value,
          variant: String(activeLease.value),
          reason: 'OVERRIDE',
          flagMetadata: {
            'synapse.override': true,
            'synapse.lease_id': activeLease.leaseId,
            'synapse.issued_by': activeLease.kid,
            'synapse.effective_expiry': activeLease.effectiveExpiry.toISOString(),
          },
        };
      }
    } catch (err) {
      this.metrics.incrementInternalErrors();
    }
    // Fallback directly to delegate provider
    return this.delegate.resolveBooleanEvaluation(flagKey, defaultValue, context);
  }
  // Analogous wrappers for string, number, and object evaluations...
}
```

### 4.2 Zero-Context Telemetry Hook (`TelemetryHook`)
```typescript
export class TelemetryHook implements Hook {
  constructor(private readonly aggregator: MetricAggregator) {}

  after(hookContext: HookContext, details: EvaluationDetails<any>): void {
    // Collect ONLY key, variant, and reason code. NEVER touch hookContext.context!
    this.aggregator.recordEvaluation(
      hookContext.flagKey,
      details.variant ?? 'unknown',
      details.reason ?? 'UNKNOWN'
    );
  }

  error(hookContext: HookContext, error: Exception): void {
    this.aggregator.recordEvaluation(hookContext.flagKey, 'error', 'ERROR');
  }
}
```

---

## 5. Control API HTTP Specification

Base path: `/v1`

### 5.1 Endpoints

#### `GET /v1/time`
- **Response 200:**
  ```json
  {
    "server_time": "2026-10-06T02:14:00.120Z"
  }
  ```
- **Purpose:** Workstation clock synchronization before Ed25519 payload signing.

#### `GET /v1/sdk/state?env={env}&wait={duration}`
- **Query Parameters:** `env` (string, required), `wait` (duration string, e.g. `30s`, default `0s`, max `60s`).
- **Headers:** `If-None-Match: "<etag>"`, `Authorization: Bearer <service_token>`
- **Response 304:** Not Modified (empty body). Served directly from in-memory cache when `wait` timer elapses or on immediate poll.
- **Response 200:** Immediate response on state change.
  ```json
  {
    "server_time": "2026-10-06T02:15:30.120Z",
    "registry_version": 42,
    "active_leases": [
      {
        "payload": { ... },
        "sig": "..."
      }
    ],
    "revocations": [
      {
        "payload": { "lease_id": "01J...", ... },
        "sig": "..."
      }
    ],
    "key_revocations": [
      {
        "payload": { "kid": "compromised-key", ... },
        "sig": "..."
      }
    ]
  }
  ```
  *(Revocations array only includes records where `expires_at >= server_time`).*

#### `POST /v1/leases`
- **Headers:** `Authorization: Bearer <operator_or_cli_token>`
- **Body:** `{ "payload": { ... }, "sig": "..." }`
- **Response 201:** 
  ```json
  {
    "lease_id": "01J9X57YTRPQ8A7F4E12345678",
    "state": "ACTIVE",
    "warnings": ["UNKNOWN_FLAG"]
  }
  ```
  *(Soft reference: if the flag is absent from both the registry and telemetry, the override is accepted but emits an `UNKNOWN_FLAG` warning).*
- **Response 409:** Conflict (an active lease already exists for this `(flag_key, env)`; requires `--supersede`).

#### `GET /v1/leases/:id/rollout-status`
- **Response 200:**
  ```json
  {
    "lease_id": "01J9X57YTRPQ8A7F4E12345678",
    "instances_observed": 38,
    "instances_total": 40,
    "evaluations_count": 1420,
    "last_evaluation_at": "2026-10-06T02:16:00Z"
  }
  ```

#### `POST /v1/leases/:id/promote`
- **Headers:** `Authorization: Bearer <operator_token>`
- **Response 202:** `{ "lease_id": "01J...", "pr_url": "https://github.com/org/repo/pull/123" }`
- **Purpose:** Initiates Git reconciliation by creating a GitHub Draft PR to merge the flag override permanently into Git.

#### `POST /v1/leases/:id/revoke`
- **Headers:** `Authorization: Bearer <operator_token>`
- **Body:** `{ "payload": { ... }, "sig": "..." }`
- **Response 200:** `{ "lease_id": "01J...", "state": "REVOKED" }`
- **Purpose:** Atomically revokes an active lease with a cryptographically signed revocation payload.

#### `GET /v1/audit/events?from_seq={seq}&to_seq={seq}&limit={limit}`
- **Query Parameters:** `from_seq` (int, default `1`), `to_seq` (int, optional), `limit` (int, default `100`, max `1000`).
- **Headers:** `Authorization: Bearer <operator_or_admin_token>`
- **Response 200:**
  ```json
  {
    "events": [
      {
        "seq": 1,
        "ts": "2026-10-06T02:14:00.000Z",
        "actor": "sre-alice",
        "event_type": "LEASE_CREATED",
        "payload": { ... },
        "prev_hash": "0000000000000000000000000000000000000000000000000000000000000000",
        "hash": "3f7a8b..."
      }
    ],
    "count": 1,
    "has_more": false
  }
  ```
- **Purpose:** Streams sealed, SHA-256 hash-chained audit ledger events for independent client-side verification (`synapse audit verify`).

#### `GET /v1/audit/checkpoint/latest`
- **Headers:** `Authorization: Bearer <operator_or_admin_token>`
- **Response 200:**
  ```json
  {
    "checkpoint_seq": 42,
    "checkpoint_hash": "3f7a8b...",
    "sealed_count": 42,
    "timestamp": "2026-10-06T02:15:00.000Z"
  }
  ```
- **Purpose:** Returns the latest sealed sequence number and hash for external anchoring (`synapse audit checkpoint`).

#### `POST /v1/audit/events`
- **Headers:** `Authorization: Bearer <operator_or_admin_token>`
- **Body:** `{ "actor": "dashboard-user", "event_type": "DASHBOARD_LOGIN", "payload": { ... } }`
- **Response 202:** `{ "status": "staged", "event_type": "...", "actor": "..." }`
- **Purpose:** Stages operational and administrative actions into `audit_pending` for asynchronous sealing into the hash chain.

#### `POST /v1/webhooks/github`
- **Headers:** `x-hub-signature-256: sha256=...`
- **Body:** GitHub Pull Request webhook payload
- **Response 200:** `{ "status": "reconciled", "lease_id": "01J..." }`
- **Purpose:** Reconciles PR merges on branches matching `synapse/promote-lease-<ULID>`, transitions the lease to `PROMOTED`, logs `GIT_MERGE`, and notifies active SDK long-polls.

#### `POST /v1/webhooks/alertmanager`
- **Headers:** `x-alertmanager-secret: <secret>` or `Authorization: Bearer <secret>`
- **Body:** Prometheus Alertmanager webhook payload
- **Response 200:**
  ```json
  {
    "status": "attributed",
    "suspects": [ ... ],
    "remediation": "synapse lease create --flag checkout-v2 --env prod --value false --ttl 30m"
  }
  ```
- **Purpose:** Automated incident response webhook that correlates firing alerts with recent flag changes and generates Grafana annotations with copy-pasteable remediation commands.

#### `GET /healthz` & `GET /readyz`
- **Response 200:** `{ "status": "ok" }` (healthz) / `{ "status": "ok", "db": "connected" }` (readyz).
- **Purpose:** Kubernetes liveness and readiness container probes.

#### `GET /metrics`
- **Response 200:** Prometheus exposition text format. Fail-open with 5s database query cache throttle.

#### `POST /v1/telemetry/batches`
- **Headers:** `Authorization: Bearer <service_token>`
- **Body:**
  ```json
  {
    "instance_id": "pod-checkout-79b8-x42",
    "batch_id": "01J...",
    "window_start": "2026-10-06T02:10:00Z",
    "window_end": "2026-10-06T02:15:00Z",
    "metrics": [
      { "flag_key": "cart-cache", "variant": "on", "reason": "TARGETING_MATCH", "count": 9520 },
      { "flag_key": "checkout-v2", "variant": "false", "reason": "OVERRIDE", "count": 1420 }
    ],
    "propagation_lag_ms": 3200
  }
  ```
- **Response 202:** Accepted. (Handled via isolated connection pool; returns 429/503 during DB load spikes).

#### `GET /v1/changes?service={name}&env={env}&since={duration}`
- **Query Parameters:** `service` (string, optional), `env` (string, required), `since` (duration string, e.g. `30m`, default `30m`).
- **Headers:** `Authorization: Bearer <operator_token>`
- **Response 200:**
  ```json
  {
    "query": { "service": "checkout-service", "env": "prod", "since": "30m" },
    "events": [
      {
        "id": 1042,
        "event_type": "LEASE_CREATED",
        "env": "prod",
        "flag_key": "checkout-v2",
        "actor": "sre-alice-2026-01",
        "occurred_at": "2026-10-06T02:14:00Z",
        "payload": { "lease_id": "01J...", "value": false }
      },
      {
        "id": 1041,
        "event_type": "GIT_MERGE",
        "env": "prod",
        "flag_key": "payment-v3",
        "actor": "github-actions[bot]",
        "occurred_at": "2026-10-06T02:05:00Z",
        "payload": { "commit": "a1b2c3d", "pr": 412 }
      }
    ],
    "evaluations": [
      {
        "flag_key": "checkout-v2",
        "variant": "false",
        "eval_count": 1420
      }
    ]
  }
  ```
- **Purpose:** Change feed powering `synapse log` pull-based attribution; isolates GitHub credentials from operator workstations and provides a clean integration seam for future chatops/alerting bots.

---

## 6. Stale Detection & Scanner Engine (`synapse-purger`)

### 6.1 Mathematical Qualification Rule
A flag $f$ in environment $E$ is qualified as a `stale_candidate` over observation window $\tau$ (35 to 45 days) if and only if:

1. $\text{class}(f) = \text{release}$.
2. Invariance:
   $$\exists v^* \text{ s.t. } \forall (v, t) \in \mathcal{U}(f, E, \tau), v = v^* \quad \lor \quad \vert{}\mathcal{U}(f, E, \tau)\vert{} = 0$$
3. Per-Flag Consumer Coverage:
   $$\forall s \in \text{Evaluators}(f, E, \tau), \quad \text{status}(s, E) \in \{\text{ACTIVE}, \text{RETIRED}\}$$
   *(If any historical evaluator is `SILENT`, the flag is blocked until the service resumes emitting telemetry or is marked `RETIRED` in the database).*
4. AST Consistency:
   $$\text{ASTReferences}(f, \text{Repos}) \subseteq \text{Evaluators}(f, E, \tau)$$
   *(A read-only AST scan detects call sites only in known consumer services).*
5. Quiescence:
   $$\text{active\_lease}(f, E) = \emptyset \quad \land \quad \text{last\_promotion}(f, E) < \text{now} - \tau$$

### 6.2 Read-Only Scanner Scope & Candidate Reporting
`synapse-purger` operates as a read-only scanner using `ts-morph`:
- **Security Boundary:** The purger **never executes repo scripts, test suites, or package postinstalls** while holding GitHub App credentials.
- **Reporting Format:** Emits structured reports with exact file lines and winning variants ready for external AST rewriting engines (Uber Piranha, GritQL) or human review.
- **Structured Candidate / Refusal Schema:**
  ```json
  {
    "flag_key": "checkout-v2",
    "status": "QUALIFIED",
    "winning_variant": "false",
    "call_sites": [
      {
        "file": "src/services/checkout.ts",
        "line": 42,
        "code_snippet": "if (await client.getBooleanValue('checkout-v2', false))"
      }
    ],
    "evaluating_services": ["checkout-service"],
    "telemetry_window_days": 42
  }
  ```

---

## 7. Testing, Conformance & Fault-Injection Strategy

### 7.1 Cross-Platform Conformance Vectors (`packages/conformance`)
Language-neutral JSON test suites validate:
1. `vector_canonical_json`: RFC 8785 whitespace, key ordering, UTF-8 escaping, and floating point serialization.
2. `vector_signature_valid`: Valid Ed25519 signature verification against test keyset.
3. `vector_tampered_payload`: Payload modified by a single byte; verification must fail.
4. `vector_unknown_kid`: Key ID not present in pinned keyset; verification must fail.
5. `vector_expired_wall`: Wall clock exceeds `issued_at + ttl + SKEW_TOLERANCE`; rejected.
6. `vector_expired_mono`: Monotonic time exceeds `first_seen_mono + ttl`; rejected.
7. `vector_future_timestamp`: Timestamp in future beyond skew allowance; rejected.
8. `vector_revocation`: Revocation present in watermark; rejected.
9. `vector_keyfile_format`: Header versioning, scrypt parameters, AES-256-GCM ciphertext, and AAD binding validation.
10. `vector_keyset_eviction`: Verification that removing a `kid` from the pinned keyset immediately evicts all active in-memory leases signed by that key.
11. `vector_sealer_concurrency`: Sealer processes records strictly in seal order (`seq`) despite out-of-order `audit_pending` insertions, with restart continuity.

### 7.2 Fault Injection Scenarios
1. **Control Plane Outage:** Terminate Control API. Verify that SDK continues serving verified active leases until expiry, then seamlessly falls through to delegate provider.
2. **Clock Skew Attack:** Inject $\pm 10\text{ minutes}$ of NTP clock skew into application container. Verify that monotonic clock ensures lease does not outlive its intended TTL.
3. **Partitioned Revocation:** Disconnect SDK network and issue lease revocation. Verify lease remains active until TTL expiry and then reverts.
4. **Database Crash Recovery:** Force database reboot. Reconstruct audit hash chain and verify zero split-brain discrepancies against signed external checkpoints.