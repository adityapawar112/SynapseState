# Handoff: Advanced Testing Architecture (Playwright E2E, Stryker Mutation & Chaos/Stress Testing)

> **Target Audience:** SREs, QA Engineers, and Core Systems Contributors  
> **Goal:** Comprehensive implementation guide for establishing End-to-End browser verification, mutation testing for cryptographic invariants, and automated chaos/stress testing across the monorepo.

---

## 1. Overview & Testing Pyramid

To guarantee bulletproof incident-safety, SynapseState supplements unit and conformance tests with three specialized testing disciplines:

```
           / \
          /   \     E2E Testing (Playwright)
         / E2E \    Browser-level user journeys, RBAC, modals, countdowns
        /-------\
       /Mutation \  Mutation Testing (Stryker Mutator)
      /  Testing  \ Invariant resilience: crypto, dual-clock, fail-safe fallback
     /-------------\
    /  Stress/Chaos \ Stress & Chaos (k6 + Chaos Drills)
   /   Saturation    \ Bulkhead isolation, NTP clock jumps, partition bounds
  /-------------------\
 / Unit & Conformance  \ Conformance Vectors, Vitest Unit Suites, Property Tests
/-----------------------\
```

---

## 2. Workstream 1: End-to-End (E2E) Browser Testing with Playwright

### 2.1 Scope & Target Package
- **Target Application:** `apps/dashboard` (Next.js 15 Operations Portal).
- **Tooling:** `@playwright/test` running in a dedicated `apps/dashboard/e2e` workspace or subfolder.
- **Operating Target:** Pre-compiled production server (`next build && next start` on port 3010) to avoid dev-server hydration jitter.

### 2.2 Directory Layout
```
apps/dashboard/
├── e2e/
│   ├── fixtures/
│   │   ├── auth.fixture.ts        # Pre-authenticates roles (viewer, operator, admin) via cookies
│   │   └── api-mocks.ts           # Optional Control API response stubs for edge cases
│   ├── tests/
│   │   ├── auth-rbac.spec.ts      # Verifies role permissions, forbidden routes, and redirects
│   │   ├── leases-lifecycle.spec.ts # Inspects live countdown timers, revoke modal, and toast alerts
│   │   ├── promote-flow.spec.ts   # Tests Draft PR diff preview and promotion modal submission
│   │   ├── flags-quiescence.spec.ts # Validates 30-day evaluation tables and candidate filtering
│   │   └── audit-chain.spec.ts    # Asserts SHA-256 ledger display, seq ordering, and checkpoint badges
│   └── playwright.config.ts       # Orchestrates production webServer and viewport config
```

### 2.3 Key Configuration (`apps/dashboard/playwright.config.ts`)
```typescript
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e/tests",
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [["html", { outputFolder: "playwright-report" }], ["list"]],
  use: {
    baseURL: "http://localhost:3010",
    viewport: { width: 1440, height: 900 },
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "next start -p 3010",
    url: "http://localhost:3010/login",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      SYNAPSE_DEV_AUTH: "true",
      PORT: "3010",
      CONTROL_API_URL: "http://localhost:3000",
    },
  },
});
```

### 2.4 User Journeys to Verify
1. **RBAC Boundary (PR 25):** 
   - Verify `viewer` cannot see or click "Revoke" or "Promote" buttons.
   - Verify `operator` can open modal and submit actions.
2. **Dual-Clock Countdown Timers:**
   - Verify lease cards render dynamic countdown strings (`XXm YYs remaining`).
   - Advance virtual clock or wait 2s to verify monotonic decrement.
3. **Promotion Modal & Git Diff Preview:**
   - Click "Promote", verify the simulated YAML diff renders correctly, submit, and assert success toast.

---

## 3. Workstream 2: Mutation Testing with Stryker Mutator

### 3.1 Scope & Package Boundaries
Mutation testing verifies that test assertions are sufficiently sensitive to catch logic mutations. We scope mutation testing strictly to **mission-critical invariants and cryptographic boundaries**:
1. `packages/lease`:
   - RFC 8785 JSON canonicalization (`src/canonicalize.ts`).
   - Ed25519 signing and verification (`src/crypto.ts`).
   - SHA-256 tamper-evident hash chaining (`src/chain.ts`).
   - Keyset parsing and role verification (`src/keyset.ts`).
2. `packages/sdk`:
   - Dual-clock expiry calculation: $\min(\text{mono}, \text{wall})$ (`src/lease-store.ts`).
   - Fail-safe fallback try/catch to delegate provider (`src/provider.ts`).
   - Zero-context tuple aggregation (`src/telemetry-hook.ts`).

### 3.2 Tooling Setup
Install Stryker dependencies in target packages:
```bash
pnpm --filter @synapsestate/lease add -D @stryker-mutator/core @stryker-mutator/vitest-runner @stryker-mutator/typescript-checker
```

### 3.3 Configuration (`packages/lease/stryker.config.json`)
```json
{
  "$schema": "../../node_modules/@stryker-mutator/core/schema/stryker-schema.json",
  "packageManager": "pnpm",
  "testRunner": "vitest",
  "coverageAnalysis": "perTest",
  "mutate": [
    "src/**/*.ts",
    "!src/**/*.test.ts",
    "!src/index.ts"
  ],
  "vitest": {
    "configFile": "vitest.config.ts",
    "related": true
  },
  "reporters": ["html", "clear-text", "progress"],
  "checkers": ["typescript"],
  "tsconfigFile": "tsconfig.json",
  "thresholds": {
    "high": 85,
    "low": 70,
    "break": 75
  }
}
```

### 3.4 Key Invariants to Kill
- **Invariant 3:** If Stryker replaces `Math.min(monoExpiry, wallCeiling)` with `Math.max(...)` or deletes the skew tolerance, tests must fail immediately.
- **Invariant 1:** If Stryker removes `try { return this.delegate... } catch`, the fail-safe test must fail.
- **Invariant 2:** If Stryker mutates `verifySignature()` to return `true`, invalid signature tests must catch it.

---

## 4. Workstream 3: Chaos & Stress Testing Automation

### 4.1 Scope & Tools
- **Protocol Saturation:** `load/k6/` (`long-polling.js`, `telemetry.js`, `mixed-stress.js`).
- **Chaos Injections:** `test/drills/` (API outage, NTP clock-skew, revocation network partition).
- **Automated CI Execution:** Run drill suites in GitHub Actions against Docker containers.

### 4.2 Automated Chaos Drill Verification Script
Create an automated test orchestrator `test/run-all-drills.sh` (or PowerShell equivalent):
```bash
# 1. Drill 1: Air-Gapped Emergency Override Channel
pnpm exec vitest run test/drills/drill1-airgap-override.test.ts

# 2. Drill 2: Host Clock Skew & NTP Rollback Defense
pnpm exec vitest run test/drills/drill2-clock-skew.test.ts

# 3. Drill 3: Network Partition During Revocation
pnpm exec vitest run test/drills/drill3-revocation-partition.test.ts
```

### 4.3 Saturation Benchmarks Protocol
- Execute `k6 run -e PROFILE=stress load/k6/mixed-stress.js`.
- Confirm that when `telemetryPool` saturates and returns `HTTP 429`, the state delivery path (`GET /v1/sdk/state`) maintains $100\%$ availability with $p95 \le 10\text{s}$.

---

## 5. Execution Summary Table

| Test Layer | Target Package | Tool | Command | Pass Criteria |
|---|---|---|---|---|
| **E2E Browser Tests** | `apps/dashboard` | Playwright | `pnpm --filter @synapsestate/dashboard test:e2e` | 100% passes across all RBAC user journeys |
| **Mutation Testing** | `packages/lease` | Stryker | `pnpm --filter @synapsestate/lease test:mutation` | Mutation Score (MSI) $\ge 80\%$ |
| **Mutation Testing** | `packages/sdk` | Stryker | `pnpm --filter @synapsestate/sdk test:mutation` | Mutation Score (MSI) $\ge 80\%$ |
| **Chaos Drills** | `test/drills` | Vitest | `pnpm vitest run test/drills` | 3/3 drills pass (0 survival past TTL) |
| **Stress / Saturation** | `load/k6` | k6 | `k6 run load/k6/mixed-stress.js` | Bulkhead isolation intact; $0$ state poll drops |
