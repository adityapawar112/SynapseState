# 4. Operator-Signed Leases with Pluggable Signer, Pinned Keyset, and Bounded Caching

Date: 2026-10-09  
Status: Accepted

---

## Context

Authorizing emergency overrides during critical production incidents requires balancing rapid mitigation against credential compromise and configuration drift:

1. **Control-Plane Compromise Threat:** If the central control API holds signing authority, any database or API compromise enables an attacker to forge overrides cluster-wide.
2. **The 2 AM Coordination Bottleneck:** Requiring two independent cryptographic signatures at 2 AM delays critical mitigation while responders locate a second authorized signer.
3. **Operator Key Storage:** Native OS keychain dependencies (`keytar`) introduce fragile native compilation hazards. Conversely, naively reusing `~/.ssh/id_ed25519` mixes trust domains, lacks standard Node crypto parser support, and carries high credential exfiltration risks. Storing keys on disk requires robust encryption, authenticated data binding, strict permissions, and on-call redundancy.
4. **Keyset Staleness & Revocation Latency:** SDKs verify signatures against a Git-pinned keyset mounted from a ConfigMap. If filesystem volume mounts stall, caching the keyset indefinitely would cause revoked keys to be honored indefinitely.

---

## Decision

We chose **operator-signed emergency leases validated against a Git-pinned keyset** with pluggable signing, fast-path key invalidation, bounded caching, and dual-clock auto-expiry:

1. **Pluggable Operator Signer (`packages/cli`):**
   - The CLI defines an extensible `Signer` interface (`sign(message: Uint8Array): Promise<string>`).
   - **Pure-TS Default (`EncryptedKeyfileSigner`):** Stores private keys at `~/.synapse/keys/<kid>.key`, encrypted via AES-256-GCM using keys derived via `crypto.scrypt` with a mandatory non-empty passphrase. Ciphertext cryptographically binds `kid` and format version via AAD.
   - **Permission Hygiene:** Strictly enforces POSIX mode `0600` (fails if group/world readable) and logs warnings on Windows.
   - **Trust Domain Isolation:** Reusing `~/.ssh/id_ed25519` is strictly prohibited. Pluggable signers (such as OS keyrings or SSH-agent / SSHSIG) can be configured as optional extensions.
   - **On-Call Redundancy:** Team policies mandate at least **two authorized key holders** on every on-call rotation. The CLI provides `synapse key generate` and `synapse key export-public` to automate keyset PR generation.
2. **Git-Pinned Keyset Trust Root:**
   - The authoritative keyset (`kid -> { publicKey, roles, max_ttl_seconds }`) is committed to Git and mounted into workload pods as a Kubernetes ConfigMap volume. The Control API never serves or manages trusted keys.
   - **Hot-Reload File-Hash Polling:** SDKs poll `SHA-256(fileContent)` of `/etc/synapse/keyset/keyset.json` every **10 seconds**, avoiding `fs.watch` symlink bugs.
   - **Bounded Fallback Cache:** The SDK caches the parsed keyset in memory alongside `keyset_verified_at` and exports `synapse_sdk_keyset_age_seconds`. If volume reads continue to fail beyond **15 minutes**, the SDK halts acceptance of _new_ emergency leases (failing static for overrides). Baseline delegate flag evaluation is unaffected.
   - **Lease Eviction on Reload:** Whenever a keyset reload or key revocation occurs, active in-memory leases are re-evaluated; any lease signed by a missing or revoked key is evicted immediately.
   - **Read Hygiene:** Retries transient symlink swap errors; parse errors retain the last valid keyset; a valid empty JSON `{}` acts as an authoritative directive to revoke all keys and evict all active leases.
3. **Signed Fast-Path Key Revocation:**
   - The Control API distributes signed key revocation envelopes (`synapsestate/keyrevocation/v1\n`). These are deny-only: the Control API can distribute an emergency revocation signed by a security lead across long-poll streams to drop compromised keys immediately, but cannot add trust.
4. **Deterministic Dual-Clock Expiry:**
   - Overrides enforce both monotonic process duration (`first_seen_mono + ttl_seconds`) and absolute wall-clock bounds (`issued_at + ttl_seconds + SKEW_TOLERANCE`). Leases are honored for $\le \min(\text{wall\_expiry}, \text{mono\_expiry})$. Zero leases survive past their intended lifespan.
5. **Git Reconciliation as Dual Control:**
   - A single operator issues a break-glass lease with a configurable TTL (default 30 minutes, up to 24 hours). Making an override permanent requires running `synapse promote`, which opens a GitHub PR against the Git baseline. A human peer review and merge of that PR serves as the mandatory secondary approval (dual control).

---

## Consequences

### Positive

- Zero override forgery risk even if the Control API or PostgreSQL database is completely compromised.
- Single-operator emergency override creation eliminates late-night coordination delays.
- Zero native compilation dependencies in the CLI or SDK.
- Bounded keyset fallback ceiling prevents honoring revoked keys indefinitely under volume failure.
- Automatic self-reversion prevents forgotten temporary overrides from lingering in production.

### Negative

- Storing keyfiles on disk requires operators to enter passphrases and safeguard workstation file permissions.
- A 15-minute keyset staleness ceiling trades temporary override availability against key revocation safety.
