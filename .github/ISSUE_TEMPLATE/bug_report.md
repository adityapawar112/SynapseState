---
name: Systems Bug Report
about: Report a crash, race condition, memory leak, or conformance violation
title: '[BUG]: '
labels: ['bug', 'investigation']
assignees: ''
---

## Description
<!-- Clear and concise description of the bug -->

## Environment & Component
- **Component:** <!-- cmd/synapse-agent, sdk/go, synapse-operator, etc. -->
- **OS / Kernel:** <!-- Linux 6.x, K8s v1.29+, tmpfs mount -->
- **Architecture:** <!-- amd64 / arm64 -->

## Symptoms
- [ ] Panic / Crash (`SIGSEGV`, `SIGBUS`)
- [ ] Memory Leak (cgroup memory growth in tmpfs)
- [ ] Goroutine / Thread Lock contention
- [ ] Conformance / Invariant Violation (torn read, stale generation)
- [ ] Latency Degradation (p99 violation)

## Steps to Reproduce
```bash
# Exact commands / benchmark to reproduce
```

## Logs & Core Dumps
```
// Paste stack trace, dmesg, or pprof output here
```

## Systematic Debugging Checklist (obra/superpowers)
- [ ] Phase 1: Problem verified with minimal reproducible test case
- [ ] Phase 2: Root cause identified (not just symptom mitigation)
- [ ] Phase 3: Regression test added
- [ ] Phase 4: Fix verified against high-concurrency benchmarks
