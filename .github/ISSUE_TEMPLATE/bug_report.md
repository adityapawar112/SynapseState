---
name: Systems Bug Report
about: Report a failure, crash, invariant violation, or conformance vector mismatch
title: "[BUG]: "
labels: ["bug", "investigation"]
assignees: ""
---

## Description

<!-- Clear and concise description of the bug -->

## Environment & Component

- **Component:** <!-- packages/lease, packages/sdk, packages/cli, apps/control-api, apps/purger, apps/dashboard, deploy/helm -->
- **Node / Runtime:** <!-- Node.js v20+, TypeScript v5.x, k3s v1.29+ -->
- **OS / Environment:** <!-- Linux, Windows, macOS -->

## Symptoms

- [ ] Invariant Violation (lease expired but still served, fail-safe delegation failed)
- [ ] Keyset / Signature Verification Failure
- [ ] Clock Skew / Expiry Inconsistency
- [ ] State Polling / ETag Sync Failure
- [ ] Conformance Vector Violation
- [ ] Audit Hash Chain Divergence
- [ ] Purger Refactoring Failure / Missing Refusal Report
- [ ] Unhandled Exception in OverrideProvider / TelemetryHook

## Steps to Reproduce

```bash
# Exact commands or script to reproduce
```

## Logs & Error Output

```
// Paste stack trace, API logs, or debug output here
```

## Systematic Debugging Checklist

- [ ] Phase 1: Problem reproduced with minimal test case or conformance vector
- [ ] Phase 2: Root cause isolated to specific invariant boundary
- [ ] Phase 3: Regression test added to test suite or conformance package
- [ ] Phase 4: Fix verified without violating hot-path fallback guarantees
