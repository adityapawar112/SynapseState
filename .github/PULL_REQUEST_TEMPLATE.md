## Summary & Context
<!-- Brief summary of what changes are introduced and link to corresponding issue -->
Closes #

## Spec & Contract Alignment
- [ ] Conforms to [SpecDoc.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/SpecDoc.md) and [ARCHITECTURE.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/ARCHITECTURE.md) requirements.
- [ ] Adheres to [AGENTS.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/AGENTS.md) engineering charter.
- [ ] Respects explicit non-goals (no custom flag evaluator, no client-side SDKs, no in-pod sidecars/UDS, no autonomous code merges).

## Systems Invariants & Architecture Checklist
- [ ] **Fail-Safe Hot Path:** OverrideProvider catches internal exceptions and falls through to delegate provider; zero evaluation disruption.
- [ ] **Pinned Keyset Trust Root:** Overrides verified strictly against local Git-pinned keyset; Control API cannot forge leases.
- [ ] **Dual-Clock Expiry:** Enforces $\min(\text{wall\_expiry}, \text{mono\_expiry})$; zero leases survive past deadline.
- [ ] **Zero-Context Telemetry:** TelemetryHook aggregates only `(flag_key, variant, reason)`; never touches evaluation context or user data.
- [ ] **Refusal-by-Default (if purger):** Only literal-key supported TypeScript patterns rewritten; emits Refusal Report on ambiguous syntax; Draft PRs only.
- [ ] **Tamper-Evident Audit Ledger:** State mutations hash-chained with SHA-256 and periodic external checkpoints.

## Verification & Test Output
```bash
# Paste test results and verification logs here
# E.g.:
# 1. npm test
# 2. npm run lint
# 3. npx tsc --noEmit
# 4. Conformance suite vectors passing
```

## Reviewer Checklist
- [ ] Architectural Invariants Verified
- [ ] Fail-Static Behavior Verified Under Failure Drills
- [ ] Evidence-Based Claims Policy Upheld (no unsubstantiated benchmark claims)
