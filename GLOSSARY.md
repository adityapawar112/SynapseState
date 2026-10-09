# Domain Glossary: SynapseState

This glossary establishes the canonical vocabulary for SynapseState. Every term defines a domain concept. Implementation details, file paths, and low-level code mechanics belong in architectural specifications rather than this document.

### Audit Checkpoint
A signed, periodic summary of the append-only audit ledger written to an external, write-once storage destination to detect and prevent unauthorized tampering.

### Audit Sealer
An asynchronous in-process single-writer background loop that consumes staged audit events from a buffer table, computes a sequential SHA-256 hash chain, and commits sealed records to an append-only ledger.

### Break-Glass Lease
A short-lived, cryptographically signed emergency override issued by a single on-call operator to force a specific flag variant across a cluster during an active production incident.

### Change Attribution
The process of correlating operational incidents with recent feature flag modifications to identify likely causal changes and suggest mitigation actions.

### Change Event
An immutable record of an operational state transition (such as a lease creation, revocation, promotion, or Git configuration merge) used for incident attribution and investigation.

### Delegate Provider
An underlying, standard OpenFeature provider (such as flagd in-process, an in-memory JSON provider, or Unleash) that performs steady-state targeting and flag evaluation beneath SynapseState's governance wrapper.

### Drift
An operational condition where the active configuration evaluated in production diverges from the baseline configuration committed to the authoritative Git repository.

### Dual Control
A security requirement where a permanent operational change or lease promotion must be independently approved by a second human operator or verified through a peer-reviewed Git pull request.

### Dual-Clock Expiry
A verification algorithm that enforces both a monotonic clock duration from the moment a lease is first observed and an absolute wall-clock deadline from the issue timestamp, guaranteeing that no override outlives its intended lifespan.

### Emergency Lease
A time-bounded, Ed25519-signed envelope that forces a specific flag variant in-memory within application runtimes to mitigate an outage.

### Flag Lifecycle Class
The operational classification of a feature flag (such as temporary `release`, permanent `killswitch`, or long-lived `permission`) that dictates its governing rules and its eligibility for automated code retirement.

### In-Process Override Map
A thread-safe, in-memory collection of verified, unexpired emergency leases checked by the `OverrideProvider` prior to delegating evaluations.

### Override Provider
An OpenFeature provider implementation that intercepts flag evaluations, serving active emergency lease values when present, and falling back safely to a delegate provider otherwise.

### Pinned Keyset
A trusted, Git-managed registry mapping key IDs (`kid`) to public keys and authorized operational roles, mounted into workloads to verify signatures independently of the central control plane.

### Promotion
The workflow of converting a temporary break-glass lease into a permanent Git baseline configuration by opening an automated Pull Request.

### Refusal Report
A structured report emitted by the automated code refactoring engine (`synapse-purger`) detailing specific AST locations where ambiguity or unsupported patterns prevented safe automated code deletion.

### Revocation
A cryptographically signed directive that prematurely terminates an active emergency lease before its scheduled expiration deadline.

### Signer
An extensible abstraction responsible for producing cryptographic signatures using operator keys, supporting implementations for password-protected encrypted keyfiles, operating system keyrings, or SSH agents.

### Stale Candidate
A release flag that has served an invariant variant across all evaluating consumer services over a full observation window (35 to 45 days) with active or retired coverage, qualifying it for source code retirement.

### Telemetry Coverage
A verification prerequisite for stale flag detection requiring that every service that recorded evaluations for a flag within data retention is in an `ACTIVE` or explicitly `RETIRED` status.

### Telemetry Hook
An OpenFeature evaluation hook that aggregates flag evaluation outcomes `(flag_key, variant, reason)` in memory without capturing or exporting contextual attributes or user identifiers.

### Air-Gapped Override
An emergency break-glass override applied directly to application workloads via mounted ConfigMap files (`kubectl apply`), bypassing the Control API during control-plane or database outages.

