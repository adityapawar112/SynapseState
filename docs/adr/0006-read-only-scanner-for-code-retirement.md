# 6. Read-Only Scanner and Per-Flag Consumer Coverage for Code Retirement

Date: 2026-10-09  
Status: Accepted

---

## Context

Deleting dead feature flags from application source code carries severe operational and security risks:

1. **Credential Exfiltration Hazard:** Automated in-pod code refactoring tools that execute repository test suites (`npm test`) or build scripts inside containers holding privileged GitHub App credentials risk credential theft via malicious or compromised build dependencies.
2. **Global Service Heartbeat Deadlock:** Requiring 100% of all registered microservices to report actively before qualifying a flag permanently blocks stale flag retirement whenever decommissioned or monthly batch services stop sending telemetry.
3. **AST Ambiguity & Broken Builds:** Automated tools that blindly rewrite dynamic keys or complex wrappers risk breaking production builds or causing runtime regressions.

---

## Decision

We chose a **read-only codebase scanner** coupled with **per-flag consumer coverage** and **refusal-by-default reporting** for `synapse-purger`:

1. **Strictly Read-Only Scanner Architecture:**
   - `apps/purger` operates strictly as a read-only AST scanner (powered by `ts-morph`) and qualification engine.
   - **Zero Untrusted Code Execution:** The purger **never** executes `npm test`, `npm run lint`, or arbitrary build scripts inside application repositories while holding GitHub App credentials.
2. **Per-Flag Consumer Coverage:**
   - To qualify as a `stale_candidate`, a release flag must serve an invariant variant for 35–45 days.
   - Coverage requires active or retired status **only from microservices that recorded evaluations for that specific flag** within the data retention window.
   - If an evaluating service becomes `SILENT` (no telemetry for > 14 days), the flag is blocked from qualification until an SRE explicitly retires the service via `synapse service retire` (or the 90-day auto-retirement sweep transitions it).
3. **Refusal by Default:**
   - If the AST scanner encounters dynamic keys (`client.getBooleanValue(prefix + key)`), custom wrappers, or undeclared consumer services, it **refuses** to qualify the flag and emits a structured `Refusal Report`.
4. **Structured Candidate Reporting:**
   - Outputs structured reports detailing file paths, line numbers, and `(flag_key, winning_variant)` tuples.
   - This output serves as verified input for established external refactoring engines (Uber Piranha, GritQL) or human-reviewed Draft Pull Requests. Automated direct merges to master branches are strictly prohibited.

---

## Consequences

### Positive

- Complete elimination of credential exfiltration risks: untrusted repository code never runs in the credentialed container.
- Decommissioned or batch services no longer deadlock cluster-wide stale flag detection.
- Refusal-by-default guarantees zero incorrect removals across complex or ambiguous codebases.
- Interoperable: cleanly separates the novel telemetry-driven qualification engine from external AST code modification tools.

### Negative

- Does not perform turnkey autonomous code modifications in v1; requires external tools (Piranha/GritQL) or human review to apply the diffs.
