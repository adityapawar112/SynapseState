# 2. TypeScript Monorepo Unification

Date: 2026-10-06  
Status: Accepted

---

## Context

Previous iterations of SynapseState divided the platform across a Go control plane daemon (`synapse-control`), Go operator (`synapse-operator`), Go sidecar (`synapse-agent`), Go CLI (`synapse-cli`), and polyglot SDKs in Go and TypeScript.

For a focused project maintained by a solo developer or small team, maintaining dual-language build chains, protobuf generators, cross-runtime test suites, and separate CI pipelines created disproportionate operational friction and slowed delivery.

---

## Decision

We chose to standardize the entire SynapseState codebase on a unified **TypeScript / Node.js monorepo**:

1. **Shared Cryptographic Core:** `packages/lease` houses deterministic RFC 8785 JSON canonicalization, Ed25519 cryptography, and dual-clock expiry validation logic shared across SDK, CLI, and API.
2. **Standardized Runtime Ecosystem:** `apps/control-api`, `apps/purger`, `packages/sdk`, `packages/cli`, and `apps/dashboard` (Next.js) all compile within a unified npm/pnpm workspace using standard TypeScript project references.
3. **Zero Native C Dependencies:** All packages strictly prohibit native compilation dependencies (`node-gyp`, platform-specific C/Rust binaries), ensuring effortless cross-platform development on Linux, macOS, and Windows.
4. **Engineering Bandwidth Allocation:** Eliminating polyglot toolchain overhead frees engineering focus for cloud-native infrastructure, reliability, and security practices: Terraform IaC, k3s Helm packaging, Prometheus/Grafana observability, Cosign signing, and failure drills.

---

## Consequences

### Positive

- Single build, lint (`eslint`), format (`prettier`), and test (`vitest`/`jest`) toolchain across all packages and services.
- 100% code sharing for cryptographic canonicalization and verification logic.
- Faster iteration velocity and clean, single-pipeline CI/CD.
- Frictionless local development without Docker cross-compilation or native C toolchain setups.

### Negative

- The Control API incurs Node.js V8 memory and runtime characteristics compared to a compiled Go binary (which is entirely acceptable for single-cluster governance workloads).
