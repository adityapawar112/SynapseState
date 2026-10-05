# 9. Refusal-by-Default AST Refactoring for Code Retirement

Date: 2026-10-06  
Status: Accepted

## Context

Automated code refactoring tools that delete dead feature flags carry significant risk of breaking production builds or introducing subtle logic regressions.

Flag evaluations often rely on complex patterns:
- Dynamically evaluated or concatenated keys (`client.getBooleanValue(prefix + key)`).
- Custom wrapper utility functions or React hooks.
- Mocked evaluations inside unit test fixtures.
- Flags controlling TypeScript type narrowing.

Existing automated tools like Uber's Piranha operate on explicit manual inputs (flag key and desired variant provided by an engineer) and can still fail or require deep rule customization.

## Decision

We chose a strict **safety-first, refusal-by-default architecture** for `synapse-purger`:

1. **Targeting Scope:** Restricted to literal string keys in supported TypeScript syntax patterns (`if`, ternary, simple const assignment).
2. **Refusal-by-Default:** If dynamic keys, wrapper abstractions, or ambiguous mocks are detected, the purger **refuses to modify code** and emits a structured `Refusal Report`.
3. **Compiler and Test Verification:** The purger executes pre-flight validation gates:
   - TypeScript compiler type check (`tsc --noEmit`).
   - Repository linter (`npm run lint`).
   - Repository unit test suite (`npm test`).
4. **Draft PR Submission Only:** If all gates pass, the purger opens a GitHub **Draft Pull Request** with attached telemetry proofs. Automatic merges to master branches are strictly prohibited.

## Consequences

### Positive
* Zero risk of breaking production builds through automated bad merges.
* Clear visibility into why specific flags could not be automated via structured Refusal Reports.
* High engineering confidence in submitted Draft PRs.

### Negative
* Narrower automated coverage in v1: complex or dynamically keyed flags must be cleaned up manually.
