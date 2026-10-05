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
  * **Elimination of Sidecars & IPC:** Removed in-pod sidecar daemons (`synapse-agent`), mutating admission webhooks, and local Unix domain socket IPC. Workload SDKs communicate directly with the Control API over standard HTTP polling with `ETag` conditional caching.
  * **Unified TypeScript Ecosystem:** Unified entire platform onto TypeScript/Node.js across SDK, CLI, Control API, Purger, and Next.js Dashboard.
  * **Pinned Keyset Trust Root:** Overrides are signed by operator Ed25519 keys and validated against a locally pinned, Git-audited keyset file, ensuring compromise of the Control API cannot lead to forged overrides.
  * **Dual-Clock Expiry Enforcement:** Combined monotonic elapsed time with wall-clock bounds to ensure zero leases survive past their intended lifespan.
  * **Refusal-by-Default Code Pruning:** Focused `synapse-purger` on high-confidence literal-key TypeScript patterns with compiler verification (`tsc --noEmit`) and structured refusal reports.
  * **Incident Attribution ("What Changed?"):** Added Alertmanager webhook integration to rank suspect flag events and provide copy-pasteable mitigation commands.

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

| Dimension | flagd / OpenFeature Operator | Unleash (Self-Hosted OSS) | Uber Piranha | LaunchDarkly Enterprise | SynapseState v3.0 Specification |
|---|---|---|---|---|---|
| **Primary Classification** | Evaluation engine & sync daemon | Full feature-management platform | Batch AST refactoring tool | Commercial SaaS platform | **Incident safety & lifecycle governance layer** |
| **Evaluation Strategy** | In-process or socket RPC | In-process SDK cache | N/A (Build-time tool) | In-process SDK cache | **Delegates to existing OpenFeature provider** |
| **Emergency Overrides** | Re-deploy or CRD edit | Dashboard toggle (bypasses Git) | N/A | Dashboard toggle (bypasses Git) | **Ed25519-signed leases with dual-clock auto-expiry** |
| **GitOps Drift Defense** | K8s CRD authoritative | Database authoritative | N/A | SaaS DB authoritative | **Git authoritative; PR promotion acts as 2nd approval** |
| **Stale Detection** | None | Manual UI review | None (Requires flag as input) | UI stale markers | **Telemetry-driven; requires 100% service coverage** |
| **Automated Cleanup** | None | None | Multi-language refactoring | Manual PR required | **ts-morph Draft PRs with refusal-by-default** |
| **Transport Model** | gRPC sync stream | HTTP polling (15s default) | N/A | Streaming connection | **HTTP polling with ETag (5s + jitter)** |
| **Trust Model** | Unauthenticated sync in baseline | Service token authentication | N/A | API key authentication | **Signed envelopes verified against pinned Git keyset** |

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

### 3.2 Dual-Clock Verification Algorithm
Workload SDKs enforce strict monotonic and wall-clock expiry bounds:

1. **Version & Keyset Lookup:** Verify `v == 1`. Lookup `kid` in locally pinned keyset. Reject if key is missing or revoked.
2. **Signature Verification:** Verify Ed25519 signature over domain-separated canonical payload.
3. **TTL Validation:** Verify $0 < \text{ttl\_seconds} \le \text{SDK\_MAX\_TTL}$ (default 3600 seconds).
4. **Anti-Future Skew Check:** Reject if $\text{issued\_at} > \text{now\_wall} + \text{SKEW\_TOLERANCE}$ (default 30 seconds).
5. **Wall-Clock Expiration:**
   $$\text{wall\_expiry} = \text{issued\_at} + \text{ttl\_seconds} + \text{SKEW\_TOLERANCE}$$
   If $\text{now\_wall} \ge \text{wall\_expiry}$, mark lease expired.
6. **Monotonic Expiration:** On first successful verification of `lease_id`:
   $$\text{mono\_expiry} = \text{now\_mono} + \text{ttl\_seconds}$$
7. **Effective Expiration:**
   $$\text{effective\_expiry} = \min(\text{wall\_expiry}, \text{mono\_expiry})$$
8. **Evaluation Activation:** An override is applied if and only if $\text{now\_mono} < \text{mono\_expiry}$ and $\text{now\_wall} < \text{wall\_expiry}$ and `lease_id` is not present in local revocations.

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
            leaseId: activeLease.leaseId,
            issuedBy: activeLease.kid,
            effectiveExpiry: activeLease.effectiveExpiry.toISOString(),
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

#### `GET /v1/sdk/state?env={env}`
- **Headers:** `If-None-Match: "<etag>"`, `Authorization: Bearer <service_token>`
- **Response 304:** Not Modified (empty body).
- **Response 200:**
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
        "payload": { ... },
        "sig": "..."
      }
    ]
  }
  ```

#### `POST /v1/leases`
- **Headers:** `Authorization: Bearer <operator_or_cli_token>`
- **Body:** `{ "payload": { ... }, "sig": "..." }`
- **Response 201:** `{ "lease_id": "01J...", "state": "ACTIVE" }`
- **Response 409:** Conflict (an active lease already exists for this `(flag_key, env)`; requires `--supersede`).

#### `POST /v1/leases/:id/promote`
- **Headers:** `Authorization: Bearer <operator_token>`
- **Response 202:** `{ "lease_id": "01J...", "pr_url": "https://github.com/org/repo/pull/123" }`

#### `POST /v1/leases/:id/revoke`
- **Headers:** `Authorization: Bearer <operator_token>`
- **Body:** `{ "payload": { ... }, "sig": "..." }`
- **Response 200:** `{ "lease_id": "01J...", "state": "REVOKED" }`

#### `POST /v1/telemetry/batches`
- **Headers:** `Authorization: Bearer <service_token>`
- **Body:**
  ```json
  {
    "instance_id": "pod-checkout-79b8-x42",
    "batch_id": "01J...",
    "window_start": "2026-10-06T02:14:00Z",
    "window_end": "2026-10-06T02:15:00Z",
    "metrics": [
      { "flag_key": "checkout-v2", "variant": "false", "reason": "OVERRIDE", "count": 1420 },
      { "flag_key": "cart-cache", "variant": "on", "reason": "TARGETING_MATCH", "count": 9520 }
    ],
    "propagation_lag_ms": 3200
  }
  ```
- **Response 202:** Accepted.

#### `POST /v1/alerts/webhook`
- **Headers:** Alertmanager Webhook Payload
- **Response 200:**
  ```json
  {
    "alert": "CheckoutHigh5xxBurnRate",
    "suspects": [
      {
        "flag_key": "checkout-v2",
        "last_change_type": "LEASE_CREATED",
        "last_change_time": "2026-10-06T02:14:00Z",
        "score": 0.95,
        "suggested_mitigation": "synapse lease create --flag checkout-v2 --env prod --value false --ttl 30m --reason \"INC-142\""
      }
    ]
  }
  ```

---

## 6. Stale Detection & AST Refactoring (`synapse-purger`)

### 6.1 Mathematical Qualification Rule
A flag $f$ in environment $E$ is qualified as a `stale_candidate` over observation window $\tau$ (30 days) if and only if:

1. $\text{class}(f) = \text{release}$.
2. Invariance:
   $$\exists v^* \text{ s.t. } \forall (v, t) \in \mathcal{U}(f, E, \tau), v = v^* \quad \lor \quad \vert{}\mathcal{U}(f, E, \tau)\vert{} = 0$$
3. Coverage:
   $$\forall s \in \text{Services}(E), \quad \text{last\_seen}(s) \ge \text{now} - \tau$$
4. Quiescence:
   $$\text{active\_lease}(f, E) = \emptyset \quad \land \quad \text{last\_promotion}(f, E) < \text{now} - \tau$$

### 6.2 Supported AST Patterns & Rewrite Transformations
Using `ts-morph`:

* **Case 1: Direct If-Statement**
  ```typescript
  // Before
  if (await client.getBooleanValue('checkout-v2', false)) {
    return runNewCheckout();
  } else {
    return runLegacyCheckout();
  }
  // After (Winning variant: true)
  return runNewCheckout();
  ```

* **Case 2: Negated If-Statement**
  ```typescript
  // Before
  if (!await client.getBooleanValue('checkout-v2', false)) {
    return runLegacyCheckout();
  }
  // After (Winning variant: true)
  // Branch removed completely
  ```

* **Case 3: Inline Ternary**
  ```typescript
  // Before
  const engine = (await client.getBooleanValue('checkout-v2', false)) ? newEngine : oldEngine;
  // After (Winning variant: true)
  const engine = newEngine;
  ```

### 6.3 Structured Refusal Report Schema
When ambiguous or unsupported syntax is encountered, the purger writes a JSON report:
```json
{
  "flag_key": "checkout-v2",
  "status": "REFUSED",
  "reasons": [
    {
      "file": "src/services/checkout.ts",
      "line": 42,
      "code_snippet": "const key = getFlagKey(); client.getBooleanValue(key, false);",
      "refusal_code": "DYNAMIC_FLAG_KEY",
      "description": "Flag key is dynamically evaluated from expression and cannot be resolved statically."
    }
  ]
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

### 7.2 Fault Injection Scenarios
1. **Control Plane Outage:** Terminate Control API. Verify that SDK continues serving verified active leases until expiry, then seamlessly falls through to delegate provider.
2. **Clock Skew Attack:** Inject $\pm 10\text{ minutes}$ of NTP clock skew into application container. Verify that monotonic clock ensures lease does not outlive its intended TTL.
3. **Partitioned Revocation:** Disconnect SDK network and issue lease revocation. Verify lease remains active until TTL expiry and then reverts.
4. **Database Crash Recovery:** Force database reboot. Reconstruct audit hash chain and verify zero split-brain discrepancies against signed external checkpoints.