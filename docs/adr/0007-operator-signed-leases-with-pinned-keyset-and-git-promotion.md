# 7. Operator-Signed Leases with Pinned Keyset and Git Promotion

Date: 2026-10-06  
Status: Accepted  
Supersedes: [ADR 0003](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/adr/0003-tiered-emergency-leases.md)

## Context

Managing emergency overrides during incidents requires balancing rapid mitigation against credential safety and configuration drift:
1. **Compromised Control Plane Threat:** If the central control plane signs overrides, a database or API compromise allows attackers to forge overrides cluster-wide.
2. **2 AM Coordination Bottleneck:** Requiring dual-key co-signing at 2 AM delays critical outage mitigation while responders search for a second authorized signer.
3. **Configuration Drift:** Temporary overrides applied via APIs often linger permanently, causing clusters to drift silently from GitOps baselines.

## Decision

We chose operator-signed emergency leases validated against a locally pinned keyset from Git, coupled with dual-clock expiration and Git PR promotion:

1. **Operator Signatures:** Emergency leases are signed locally on operator workstations using Ed25519 private keys stored in the OS keychain or hardware tokens.
2. **Pinned Keyset Trust Root:** Workload SDKs verify signatures against a pinned public keyset (`kid -> publicKey, role`) mounted directly from a Git-managed ConfigMap. The Control API never serves or manages trusted keys.
3. **Single-Signer 30-Minute Break-Glass:** Overrides require only one operator signature and carry a mandatory maximum TTL of 30 minutes (mitigating late-night bottlenecks).
4. **Dual-Clock Expiry:** SDKs enforce both monotonic duration from first observation (`first_seen_mono + ttl`) and wall-clock bounds (`issued_at + ttl + SKEW_TOLERANCE`).
5. **PR Promotion as Second Approval:** Making an override permanent requires running `synapse promote`, which opens a GitHub PR against the Git baseline. A human peer review and merge of that PR serves as the mandatory secondary approval (dual control).

## Consequences

### Positive
* Zero override forgery risk even if the Control API or PostgreSQL database is completely compromised.
* Single-operator mitigation enables rapid response (< 30s) during critical incidents.
* Leases guaranteed to self-revert within 30 minutes if forgotten, preventing configuration drift.
* Clear cryptographic audit trail linking every override to an attributable operator identity.

### Negative
* Key rotation requires committing an updated keyset to Git and redeploying ConfigMaps.
* Operators must hold local private signing keys on their workstations.
