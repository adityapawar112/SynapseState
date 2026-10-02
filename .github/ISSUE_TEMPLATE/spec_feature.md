---
name: Feature / Spec Ticket
about: Implement a component or tracer bullet from the SynapseState Spec
title: '[FEAT]: '
labels: ['enhancement', 'spec-tracer']
assignees: ''
---

## Spec Reference
- **Spec Section:** <!-- e.g., §5.2 Safe Reader Contract -->
- **Phase Milestone:** <!-- e.g., Phase 1 Data Plane -->
- **Target Component:** <!-- e.g., sdk/go, cmd/synapse-agent, pkg/engine -->

## Problem & Acceptance Criteria
<!-- What is being implemented and what exact conditions define completion? -->
- [ ] Invariant 1:
- [ ] Invariant 2:
- [ ] Invariant 3:

## Performance & SLO Impact
- [ ] Allocation budget: Zero heap allocations on hot path (or specify limit)
- [ ] Latency budget: p99 <= <!-- e.g., 0.8µs native, 2.0µs Go SDK -->

## Blocking Dependencies
<!-- List issues/tickets that must merge before this can start -->
- Depends on: None
- Blocks: None

## Verification Strategy
<!-- How will this be tested? (Unit, Conformance, Chaos, Benchmarks) -->
```bash
# Verification commands
```
