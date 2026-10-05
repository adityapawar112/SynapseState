# 8. TypeScript Monorepo Unification

Date: 2026-10-06  
Status: Accepted

## Context

The previous architecture divided SynapseState across a Go control plane daemon (`synapse-control`), Go operator (`synapse-operator`), Go sidecar (`synapse-agent`), Go CLI (`synapse-cli`), and polyglot SDKs in Go and TypeScript.

For a focused project maintained by a solo developer or small team, maintaining dual-language build chains, protobuf generators, cross-runtime test suites, and separate CI pipelines created disproportionate operational friction and slowed delivery.

## Decision

We chose to standardize the entire SynapseState codebase on **TypeScript / Node.js**:
1. **Shared Core:** `packages/lease` contains RFC 8785 canonicalization, Ed25519 cryptography, and validation logic shared across SDK, CLI, and API.
2. **Standardized Runtime:** `apps/control-api`, `apps/purger`, `packages/sdk`, `packages/cli`, and `apps/dashboard` (Next.js) all compile within a unified npm/pnpm workspace.
3. **Infrastructure Focus:** Eliminating polyglot toolchain friction frees engineering bandwidth to establish rigorous cloud-native practices: Terraform IaC, k3s Helm packaging, Prometheus/Grafana observability, Cosign signing, and failure drills.

## Consequences

### Positive
* Single build, lint, format, and test toolchain across all packages and services.
* 100% code sharing for cryptographic canonicalization and verification.
* Faster iteration velocity and simpler CI/CD pipelines.

### Negative
* The Control API incurs Node.js V8 memory and runtime characteristics compared to a compiled Go daemon (sufficient for single-cluster governance workloads).
