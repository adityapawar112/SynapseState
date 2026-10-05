# 3. Tiered Emergency Leases with Short-Lived Break-Glass Authorization

Date: 2026-10-05
Status: Accepted

## Context

Feature flags act as operational kill switches during severe production incidents (e.g. database pool exhaustion, cascading upstream timeouts).

Authorizing emergency overrides presents a fundamental conflict:
1. **Single-operator SaaS toggles:** Allow an engineer to flip a flag in 15 to 45 seconds from a web UI, but carry high risk of fat-finger errors, credential compromise, and untracked GitOps drift.
2. **Strict dual-control Ed25519 signing:** Requires two independent cryptographic signatures (issuer + approver) before the system applies an override. In a late-night P0 incident, locating a second authorized signer with an active hardware token takes 15 to 20 minutes, prolonging severe downtime.
3. **GitOps reconciliation collision:** If an emergency override is applied directly to a cluster, continuous delivery reconcilers (such as ArgoCD or Flux) may detect drift against Git and automatically revert the fix, re-enabling the failing feature.

## Decision

We chose a two-tiered emergency lease architecture:

* **Tier 1 (Single-Operator Break-Glass Lease):**
  - An authorized SRE can issue an immediate emergency override signed with a single Ed25519 private key.
  - The lease carries a mandatory maximum time-to-live (TTL) of 30 minutes.
  - Propagates cluster-wide in under 30 seconds (MTTE < 30s), enabling immediate incident mitigation.
  - The control plane automatically opens a back-sync pull request against the authoritative Git repository.
* **Tier 2 (Dual-Control Promotion):**
  - To persist the override beyond 30 minutes, an independent approver must co-sign the lease, or the automated GitOps back-sync PR must be merged.
  - If neither occurs within 30 minutes, the lease expires automatically, preventing permanent configuration drift.
* **GitOps Pause Annotation:**
  - Active emergency leases signal GitOps reconcilers to temporarily pause automated rollbacks on affected resources until the lease expires or merges.

## Consequences

### Positive
* Eliminates the 2 AM coordination bottleneck: Outages are mitigated within 30 seconds by a single responder.
* Eliminates permanent configuration drift: The mandatory 30-minute expiration prevents forgotten temporary overrides from lingering in production.
* Maintains high-assurance security: Dual control is preserved for long-term policy changes and permanent overrides.
* Non-repudiation: Every break-glass action is cryptographically signed and recorded in an append-only audit ledger.

### Negative
* SREs must be trained on the two-tier lifecycle to ensure leases are promoted before the 30-minute expiration.
