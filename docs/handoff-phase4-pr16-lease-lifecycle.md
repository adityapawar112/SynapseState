# SynapseState Handoff: Phase 4 PR 16 Onboarding (Lease Lifecycle & Emergency Apply)

> **Document Status:** Active Engineering Baseline  
> **Milestone:** Phase 4 (Weeks 7 – 8: Incident Break-Glass Loop & Git Reconciliation)  
> **Current Target:** PR 16 (`feat/cli-lease-lifecycle`)  
> **Repository:** `synapsestate/synapsestate`  
> **Current Branch:** `feat/cli-signer-and-keys` (PR 15 merged / ready for PR 16 branch `feat/cli-lease-lifecycle`)  
> **Primary Charter & Specs:**  
> - System Charter & Invariants: [AGENTS.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/AGENTS.md) (§1 Non-Goals, §2 Architectural Invariants 1–7, §5 SLOs, §6 Verification Guidelines)  
> - Authoritative Architecture: [docs/ARCHITECTURE.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/ARCHITECTURE.md) (§1 Operator Key Storage, §2 Git-Managed Keyset, §3 State Delivery, §5 Emergency Scanner)  
> - Operator Key Storage Decision: [docs/adr/0004-operator-signed-leases-with-pluggable-signer-and-pinned-keyset.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/adr/0004-operator-signed-leases-with-pluggable-signer-and-pinned-keyset.md)  
> - Delivery Roadmap: [docs/ROADMAP.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/ROADMAP.md) (§5 Phase 4, PR 15 & PR 16)  
> - PR 15 Implementation: [GitHub PR #15](https://github.com/adityapawar112/SynapseState/pull/15)

---

## 1. Executive Summary & Monorepo State (PR 15 Completion)

**PR 15 (`feat/cli-signer-and-keys`)** is **100% complete, peer-reviewed, hardened against adversarial review, and verified across all CI runners**:
- **Pluggable Signer Interface:** Defined [`Signer`](file:///c:/Users/adity/Desktop/Projects/SynapseState/packages/cli/src/signer/interface.ts) interface (`kid`, `sign(message: Uint8Array): Promise<string>`).
- **EncryptedKeyfileSigner:** Implemented in [`packages/cli/src/signer/encrypted-file.ts`](file:///c:/Users/adity/Desktop/Projects/SynapseState/packages/cli/src/signer/encrypted-file.ts):
  - AES-256-GCM authenticated encryption with 12-byte IV and 16-byte auth tag.
  - Key derivation via `crypto.scrypt` with strict parameters ($N=32768, r=8, p=1, \text{keyLen}=32$) and random 16-byte salt.
  - AAD cryptographic binding to format version and `kid` (`synapsestate:keyfile:v1:<kid>`).
  - Strict POSIX `0600` file mode and `0700` directory permission enforcement (with explicit Windows security warnings).
  - KDF parameter pinning and component length verification preventing downgrade attacks.
  - Defense-in-depth public key derivation check (`crypto.createPublicKey(privateKey) === data.public_key`).
- **Key Management Commands:** Implemented in [`packages/cli/src/commands/key.ts`](file:///c:/Users/adity/Desktop/Projects/SynapseState/packages/cli/src/commands/key.ts):
  - `synapse key generate`: generates keypair on disk with 0600 mode, outputs public key and copy-pasteable Git keyset PR entry.
  - `synapse key export-public`: extracts unencrypted metadata and serializes authoritative keyset JSON/YAML entries with role, status, max-TTL, and kid validation.
- **Pull Request Status:** Open and green at [PR #15](https://github.com/adityapawar112/SynapseState/pull/15) (Commit `d45b017`). All GitHub Actions check runs passed (329/329 tests green, 0 lint warnings, 0 type errors).

---

## 2. PR 16 Scope & Deliverables (`feat/cli-lease-lifecycle`)

The target milestone for the upcoming session is **PR 16 (`feat/cli-lease-lifecycle`)**, creating [`packages/cli/src/commands/lease.ts`](file:///c:/Users/adity/Desktop/Projects/SynapseState/packages/cli/src/commands/lease.ts):

```
packages/cli/src/
├── index.ts                # Register lease subcommands
├── signer/
│   ├── interface.ts        # Pluggable Signer contract
│   └── encrypted-file.ts   # EncryptedKeyfileSigner
└── commands/
    ├── key.ts              # synapse key generate & export-public
    └── lease.ts            # synapse lease create, list, revoke, emergency-apply
```

### Deliverable Breakdown:

#### 1. `synapse lease create`
- **CLI Flags:**
  - `--env <env>`: Target environment (e.g. `production`, `staging`).
  - `--flag <key>`: Feature flag key (validated against `FLAG_KEY_REGEX`).
  - `--value <val>`: Override value (parsed boolean, number, string, or JSON object).
  - `--reason <text>`: Mandatory operational justification.
  - `--ttl <seconds>`: Duration in seconds (default 1800, validated $\le \text{key.max\_ttl\_seconds}$ and $\le 86400$).
  - `--kid <kid>`: Key ID used to sign the lease.
  - `--key-file <path>`: Direct path to `.key` file (defaults to `~/.synapse/keys/<kid>.key`).
  - `--password <pass>`: Passphrase for keyfile decryption (checks `SYNAPSE_KEY_PASSWORD` env var or prompts).
  - `--api-url <url>`: Control API base URL (defaults to `http://localhost:3000` or `SYNAPSE_API_URL`).
- **Execution Flow:**
  1. Synchronizes workstation time by querying `GET /v1/time` from the Control API to compute local clock delta.
  2. Constructs authoritative [LeasePayload](file:///c:/Users/adity/Desktop/Projects/SynapseState/packages/lease/src/schema.ts#L54) (`v: 1`, `lease_id: ulid()`, `issued_at`, `ttl_seconds`, `kid`, `nonce: randomBytes(16)`).
  3. Loads [EncryptedKeyfileSigner](file:///c:/Users/adity/Desktop/Projects/SynapseState/packages/cli/src/signer/encrypted-file.ts) and signs payload with domain separation prefix (`synapsestate/lease/v1\n`).
  4. Submits signed [LeaseEnvelope](file:///c:/Users/adity/Desktop/Projects/SynapseState/packages/lease/src/schema.ts#L91) to Control API: `POST /v1/leases`.
  5. Rollout Verification Loop: Polls `GET /v1/changes` or `GET /v1/state` with timeout until the lease appears active in the state feed.

#### 2. `synapse lease list`
- Queries `GET /v1/state` from the Control API (or accepts `--offline` reading from `/etc/synapse/emergency-leases/*.json`).
- Renders an SRE-formatted table (using `cli-table3` and `picocolors`):
  - Columns: `Lease ID`, `Env`, `Flag Key`, `Value`, `Remaining TTL` (calculated countdown vs wall clock), `Reason`, `Issued At`, `Signer (kid)`.
  - Flags: `--env <env>`, `--json` (machine-readable raw output).

#### 3. `synapse lease revoke`
- **CLI Flags:** `--id <lease_id>`, `--reason <text>`, `--kid <kid>`, `--key-file <path>`, `--password <pass>`, `--api-url <url>`.
- Constructs [RevocationPayload](file:///c:/Users/adity/Desktop/Projects/SynapseState/packages/lease/src/schema.ts#L104) (`v: 1`, `lease_id`, `revoked_at: now()`, `kid`, `reason`).
- Signs envelope using operator key (`signRevocation`).
- Submits envelope to `POST /v1/leases/:id/revoke`.
- Displays confirmation and revocation timestamp.

#### 4. `synapse lease emergency-apply`
- Air-gapped fallback generation (Invariant 1 & Architecture §5).
- Takes identical parameters to `synapse lease create`, signs envelope locally, but instead of calling the Control API, generates a Kubernetes `ConfigMap` YAML:
  ```yaml
  apiVersion: v1
  kind: ConfigMap
  metadata:
    name: synapse-emergency-lease-<lease_id>
    namespace: default
    labels:
      synapse.io/lease: "true"
  data:
    <lease_id>.json: |
      {
        "payload": { ... },
        "sig": "..."
      }
  ```
- Ready for immediate `kubectl apply -f -` during central API outages.

---

## 3. Architectural Invariants to Uphold in PR 16

1. **Fail-Safe Hot Path Delegation (Invariant 1):** The CLI produces standard signed envelopes verifiable by `@synapsestate/lease` and the SDK without requiring sidecar communication.
2. **Pinned Keyset Trust Root (Invariant 2):** The CLI signs leases strictly using operator private keys mounted locally; the Control API is never trusted with signing credentials.
3. **Deterministic Dual-Clock Expiry (Invariant 3):** Server time sync (`GET /v1/time`) prevents operator workstation clock skew from extending lease lifetime beyond authorized bounds.
4. **Zero-Context Integrity (Invariant 5):** The CLI operates purely on `(flag_key, value, reason)` tuples without capturing context attributes or user targeting rules.

---

## 4. Suggested Skills for Next Agent

The next agent should call the `Skill` tool for:
- `test-driven-development`: Write failing CLI command tests for `lease create`, `list`, `revoke`, and `emergency-apply` against mock Fastify / HTTP handlers before writing command implementation.
- `verification-before-completion`: Run all repository gates (`pnpm run lint`, `pnpm -r run build`, `pnpm -r run typecheck`, `pnpm --filter @synapsestate/cli run test`) before claiming completion.
- `codebase-design`: Keep the CLI command interfaces small, composable, and separate from HTTP client mechanics.
- `domain-modeling`: Ensure CLI options, flags, and table column names strictly match the ubiquitous language established in [docs/ARCHITECTURE.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/ARCHITECTURE.md).

---

## 5. Verification Commands for Monorepo Gates

```bash
# 1. Monorepo Quality Gates
pnpm run lint
pnpm -r run build
pnpm -r run typecheck

# 2. Package Unit Tests
pnpm --filter @synapsestate/cli run test
pnpm --filter @synapsestate/lease run test
pnpm --filter @synapsestate/sdk run test
pnpm --filter @synapsestate/conformance run test

# 3. Full Coverage
pnpm run test:coverage
```
