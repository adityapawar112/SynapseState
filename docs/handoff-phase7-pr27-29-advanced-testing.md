# Phase 7 Handoff: End-to-End Verification & Mutation Resilience (PRs 27–29)

> **Target Audience:** SREs, QA Engineers, and Core Systems Contributors  
> **Goal:** Comprehensive implementation guide for establishing End-to-End browser verification (PR 27), mutation testing for cryptographic invariants (PR 28), and automated chaos/stress testing (PR 29) across the monorepo.

---

## 1. Overview & Testing Pyramid

To guarantee bulletproof incident-safety, SynapseState supplements unit and conformance tests with three specialized testing disciplines:

```
           / \
          /   \     E2E Testing (Playwright - PR 27)
         / E2E \    Browser-level user journeys, RBAC, live countdowns, promotion flow
        /-------\
       /Mutation \  Mutation Testing (Stryker Mutator - PR 28)
      /  Testing  \ Core invariant resilience: crypto, dual-clock expiry, fail-safe fallback
     /-------------\
    /  Stress/Chaos \ Automated Chaos Drills & Partition Testing (PR 29)
   /   Saturation    \ Bulkhead isolation, NTP clock jumps, revocation packet loss
  /-------------------\
 / Unit & Conformance  \ Conformance Golden Vectors, Vitest Unit Suites, Property Tests
/-----------------------\
```

---

## 2. PR 27: End-to-End Browser Testing with Playwright (`test/dashboard-playwright-e2e`)

### 2.1 Scope & Architecture (Decision: Real Services via Native `webServer`)
Per **Open Question 6**, we avoid brittle mock-routing (`page.route()`) which introduces maintenance drift and misses API serialization bugs. Playwright tests execute against **real production builds** connected to an ephemeral PostgreSQL service:
- **Target Application:** `apps/dashboard` (Next.js 15 Operations Portal).
- **Tooling:** `@playwright/test` located in `apps/dashboard/e2e/`.
- **Environment:** In GitHub Actions CI, PostgreSQL 16 runs as a native service container (`services: postgres`). Playwright's built-in `webServer` block boots both `control-api` and `dashboard` concurrently.

### 2.2 Directory Layout
```
apps/dashboard/
├── e2e/
│   ├── fixtures/
│   │   ├── auth.fixture.ts        # Pre-authenticates roles (viewer, operator, admin) via session cookies
│   │   └── seed-data.ts           # Populates known active leases and evaluation telemetry in test DB
│   ├── tests/
│   │   ├── auth-rbac.spec.ts      # Verifies role permissions, forbidden routes, and redirects
│   │   ├── leases-lifecycle.spec.ts # Inspects live countdown timers, revoke modal, and toast alerts
│   │   ├── promote-flow.spec.ts   # Tests Draft PR diff preview and promotion modal submission
│   │   ├── flags-quiescence.spec.ts # Validates 30-day evaluation tables and candidate filtering
│   │   └── audit-chain.spec.ts    # Asserts SHA-256 ledger display, seq ordering, and checkpoint badges
│   └── playwright.config.ts       # Multi-server orchestration (Control API + Dashboard)
```

### 2.3 Configuration (`apps/dashboard/playwright.config.ts`)
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
  webServer: [
    {
      command: "pnpm --filter @synapsestate/control-api start",
      url: "http://localhost:3000/healthz",
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: {
        PORT: "3000",
        AUTO_MIGRATE: "true",
      },
    },
    {
      command: "next start -p 3010",
      url: "http://localhost:3010/login",
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: {
        SYNAPSE_DEV_AUTH: "true",
        PORT: "3010",
        CONTROL_API_URL: "http://localhost:3000",
      },
    },
  ],
});
```

### 2.4 User Journeys to Verify
1. **RBAC Boundary (PR 25):** 
   - Verify `viewer` role cannot see or click "Revoke" or "Promote" buttons.
   - Verify `operator` role can open modals and dispatch promotions.
2. **Dual-Clock Countdown Timers:**
   - Verify lease cards render dynamic countdown strings (`XXm YYs remaining`).
   - Verify monotonic decrement without page reload.
3. **Promotion Modal & Git Diff Preview:**
   - Click "Promote", verify the generated YAML diff displays correctly, submit, and assert success toast with PR URL.

---

## 3. PR 28: Mutation Testing with Stryker Mutator (`test/mutation-stryker-invariants`)

### 3.1 Scope & Boundaries (Decision: Strictly Core-Scoped)
Per **Open Question 7**, mutation testing is strictly confined to the security-critical and hot-path evaluation libraries:
- `packages/lease`:
  - RFC 8785 JSON canonicalization (`src/canonicalize.ts`).
  - Ed25519 signing and verification (`src/crypto.ts`).
  - SHA-256 tamper-evident hash chaining (`src/chain.ts`).
  - Keyset parsing and role verification (`src/keyset.ts`).
- `packages/sdk`:
  - Dual-clock expiry calculation: $\min(\text{mono}, \text{wall})$ (`src/lease-store.ts`).
  - Fail-safe fallback try/catch to delegate provider (`src/provider.ts`).
  - Zero-context tuple aggregation (`src/telemetry-hook.ts`).

*Excluded from Stryker:* `apps/dashboard`, `packages/cli`, and `apps/purger`. Standard unit/integration suites and TypeScript typechecks provide sufficient safety without CI execution bloat.

### 3.2 Tooling Setup & CI Fast Execution
Install Stryker dependencies:
```bash
pnpm --filter @synapsestate/lease add -D @stryker-mutator/core @stryker-mutator/vitest-runner @stryker-mutator/typescript-checker
pnpm --filter @synapsestate/sdk add -D @stryker-mutator/core @stryker-mutator/vitest-runner @stryker-mutator/typescript-checker
```

**Fast CI Execution Command:**
```bash
# In PR CI, mutate only modified lines against main
pnpm exec stryker run --since origin/main
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
    "high": 90,
    "low": 80,
    "break": 80
  }
}
```

### 3.4 Key Invariants to Kill
- **Invariant 3:** If Stryker replaces `Math.min(monoExpiry, wallCeiling)` with `Math.max(...)` or deletes the skew tolerance, tests must fail immediately.
- **Invariant 1:** If Stryker removes `try { return this.delegate... } catch`, the fail-safe test must fail.
- **Invariant 2:** If Stryker mutates `verifySignature()` to return `true`, invalid signature tests must catch it.

---

## 4. PR 29: Automated Chaos & Fault-Injection Pipeline (`test/chaos-drill-automation`)

### 4.1 Scope & Automated Harness
Automate the 3 chaos failure drills ([test/drills/](file:///c:/Users/adity/Desktop/Projects/SynapseState/test/drills/)) to run directly in GitHub Actions CI:
1. **Drill 1: Air-Gapped Override Channel (`drill1-airgap-override.test.ts`):** Complete Control API partition; SDK evaluates signed emergency override loaded from local disk.
2. **Drill 2: Host Clock Skew & NTP Rollback (`drill2-clock-skew.test.ts`):** Inject 120s monotonic and wall-clock shifts; verify zero leases survive past deadline.
3. **Drill 3: Network Partition During Revocation (`drill3-revocation-partition.test.ts`):** Partition active lease revocation; confirm automatic fail-safe fallback to delegate provider upon TTL expiry.

### 4.2 CI Execution Command
```bash
pnpm vitest run test/drills/
```

---

## 5. Execution Summary Table (Phase 7)

| PR | Test Layer | Target Package | Command | Pass Criteria |
|---|---|---|---|---|
| **PR 27** | **E2E Browser Tests** | `apps/dashboard` | `pnpm --filter @synapsestate/dashboard test:e2e` | 100% passes across all RBAC user journeys |
| **PR 28** | **Mutation Testing** | `packages/lease` | `pnpm --filter @synapsestate/lease test:mutation` | Mutation Score (MSI) $\ge 80\%$ |
| **PR 28** | **Mutation Testing** | `packages/sdk` | `pnpm --filter @synapsestate/sdk test:mutation` | Mutation Score (MSI) $\ge 80\%$ |
| **PR 29** | **Automated Chaos Drills** | `test/drills` | `pnpm vitest run test/drills` | 3/3 drills pass (0 survival past TTL) |
