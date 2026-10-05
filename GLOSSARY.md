# Domain glossary: SynapseState

This glossary establishes the canonical vocabulary for SynapseState. Every term defines a domain concept. Implementation details, file paths, and low-level code mechanics belong in architectural specifications rather than this document.

### Break-Glass Lease
A short-lived emergency override signed by a single authorized operator to mitigate a critical production incident immediately.

### Delta Stream
A local push-based communication channel between a sidecar agent and application runtimes that delivers incremental configuration updates.

### Drift
An operational condition where the active configuration evaluated in a running cluster diverges from the committed configuration in the authoritative Git repository.

### Dual Control
A security requirement where a permanent operational override or lease extension must be independently authorized by two distinct operators or verified through a merged code review.

### Emergency Lease
A time-bounded, cryptographically signed override that forces a specific flag variant across a cluster to mitigate an active production incident.

### Epoch
A discrete lifecycle phase of an in-process ruleset snapshot, transitioning when an updated generation is atomically swapped into active evaluation.

### Feature Flag
A named configuration decision point in software that controls runtime behavior, enables code paths, or alters operational limits without deploying new code.

### Flag Lifecycle
The operational classification of a feature flag (such as temporary release, experiment, permanent kill switch, or permission gate) that dictates its governing rules and eligibility for automated code cleanup.

### Generation
A strictly increasing integer sequence that uniquely identifies an immutable snapshot of all feature flag rulesets for a project.

### In-Process Cache
An in-memory data store within an application runtime that holds compiled feature rules for direct local access without network round-trips.

### MurmurHash3 Bucketing
A deterministic, uniform hashing method that maps contextual attributes (such as user identifiers or tenant tokens) into an integer range between 0 and 9,999 for percentage rollouts.

### Quiescence ($Q$)
A mathematical ratio between 0.0 and 1.0 representing the proportion of evaluations for a given flag that resolved to its dominant variant across all environments over a continuous observation window.

### Reader
An active execution context within an application workload that evaluates a feature flag against runtime attributes using the active in-process cache.

### Rollout Split
A percentage allocation of traffic distributed across multiple variants of a flag when no deterministic targeting rule matches.

### Stale Candidate
A release or experiment flag that has demonstrated complete Quiescence ($Q = 1.0$) over a full observation period without operational errors, qualifying it for automated source code deletion.

### Straggler Pod
A workload instance that has not applied or acknowledged a published configuration generation within the expected intra-cluster propagation deadline.

### Targeting Rule
A prioritized condition that compares runtime context attributes against defined criteria to select an execution variant.

### Tombstone
A cryptographically verified revocation record that terminates an active emergency lease before its scheduled expiration.

### Variant
One specific, mutually exclusive value or execution path that a feature flag can return to a caller upon evaluation.
