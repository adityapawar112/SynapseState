# Phase 8 Handoff: Production Load Saturation, Soak Benchmarks & Observability Visuals (PRs 30–31)

> **Target Audience:** SREs, Performance Engineers, and Full-Stack Contributors  
> **Goal:** Comprehensive implementation guide for running multi-scenario k6 load/soak tests (PR 30), capturing Prometheus metrics, and executing the containerized visual pipeline for `README.md` assets (PR 31).

---

## 1. What Modern SRE Teams Do (Industry Best Practices)

In production infrastructure engineering, high-impact documentation does not show empty dashboards or unverified claims. Teams use a **Story Arc Traffic Pattern**:

1. **Scenario-Based Traffic Orchestration:**
   Instead of indefinite uniform load, systems are driven through an operational narrative:
   - **Phase 1: Steady-State Baseline:** 100 concurrent SDKs long-polling with ETag caching (95%+ HTTP 304 quiet responses, 0 active leases).
   - **Phase 2: 2 AM Incident Break-Glass Override:** SRE signs an emergency lease (`checkout-v2` = `true`, 30m TTL). Control API broadcasts invalidation; SDKs wake up and ingest within $<500\text{ms}$.
   - **Phase 3: Bulkhead Saturation & Load-Shedding:** High-volume telemetry batch flushes (5,000+ evals/sec). Proves Invariant 1 bulkhead isolation: `telemetryPool` sheds load with HTTP 429 while `leasePool` state delivery remains 100% available with 0 drops.
   - **Phase 4: Graceful Expiry & Revocation:** Lease is promoted or revoked via `synapse lease revoke`. Active override count returns to 0.

2. **Automated Containerized Visual Pipeline:**
   Screenshots are captured programmatically via headless Chrome inside the official Playwright Docker container at exact viewports (1440x900) after waiting for network idle and metric collection windows, guaranteeing 100% platform-independent font rendering.

3. **No Synthetic Mocks:**
   All dashboards and metrics reflect actual database writes, real cryptographic Ed25519 signatures, and real Prometheus scrape intervals.

---

## 2. Infrastructure Setup (Local Stack)

### Step 1: Start PostgreSQL Database & Observability Stack
```bash
# Terminal 1: Start PostgreSQL, Prometheus, and Grafana
docker compose up -d postgres
docker compose -f docker-compose.observability.yml up -d
```
*Verify containers are running:*
- PostgreSQL: `localhost:5432`
- Prometheus: `http://localhost:9090` (configured to scrape Control API)
- Grafana: `http://localhost:3002` (anonymous Admin enabled; SynapseState dashboard pre-loaded)

### Step 2: Start Control API
```bash
# Terminal 2: Run Control API with auto-migrations
$env:PORT="3000"; $env:AUTO_MIGRATE="true"; pnpm --filter @synapsestate/control-api run dev
```

### Step 3: Start Operations Portal (Next.js Dashboard)
```bash
# Terminal 3: Run Next.js Dashboard with dev operator auth
$env:PORT="3010"; $env:SYNAPSE_DEV_AUTH="true"; $env:CONTROL_API_URL="http://localhost:3000"; pnpm --filter @synapsestate/dashboard run dev -- -p 3010
```

---

## 3. PR 30: Soak Harness, Saturation Benchmarks & Regression Enforcement (`test/k6-soak-and-saturation`)

The repository includes pre-tuned k6 test harnesses in [`load/k6/`](file:///c:/Users/adity/Desktop/Projects/SynapseState/load/k6/).

### 3.1 Decision & Architecture (Native k6 Thresholds & CI Artifacts)
Per **Open Question 8**, we avoid complex auto-commit bots that pollute Git history. We define native k6 `thresholds` inside the test script options:
```javascript
export const options = {
  thresholds: {
    'lease_propagation_lag': ['p(95)<10000'], // <= 10s SLO
    'http_req_failed': ['rate<0.001'],         // < 0.1% error rate
  },
};
```
- **Exit Code Enforcement:** Violations exit with code 99 and automatically fail CI.
- **Workflow Artifact Export:** CI exports `summary.json` as a standard GitHub Actions artifact (retained 30 days). Static baselines in [docs/benchmarks/load-test-report.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/benchmarks/load-test-report.md) are updated manually only upon tagged release milestones.

### 3.2 Scenario A: Steady-State & ETag Long-Polling Delivery
Simulates 100 concurrent application microservices long-polling state:
```bash
k6 run -e VUS=100 -e DURATION=1m load/k6/long-polling.js
```
- **What it exercises:** In-process caching, conditional HTTP 304 holding, memory leak stability.
- **Observability impact:** In Grafana, `synapse_state_poll_duration_seconds` shows steady 304 count; `synapse_leases_active` remains 0.

### 3.3 Scenario B: Live Invalidation & Emergency Lease Injection
Simulates 100 concurrent pollers while a background thread injects and revokes signed emergency overrides:
```bash
k6 run -e VUS=100 -e DURATION=2m -e INJECT_MUTATIONS=true load/k6/long-polling.js
```
- **What it exercises:** Dynamic ETag invalidation, server event loop wakeup, propagation lag measurement (`server_time - issued_at`).
- **Observability impact:** 
  - Grafana: `Lease Propagation Lag` panel plots $p50/p95/p99$ curves below the $10\text{s}$ red line.
  - Next.js Portal: `/leases` displays live countdown cards and active override badges.

### 3.4 Scenario C: High-Throughput Telemetry Ingestion (Zero-Context Flush)
Drives high-rate batch ingestion across multiple synthetic services:
```bash
k6 run -e VUS=50 -e DURATION=1m -e BATCH_SIZE=50 load/k6/telemetry.js
```
- **What it exercises:** Batch database upserts into `flag_usage_daily`, Zero-Context validation (Invariant 5).
- **Observability impact:**
  - Next.js Portal: `/flags` updates with 30-day evaluation counts and variant percentage bars.
  - Grafana: `synapse_sdk_telemetry_evaluations_total` spikes upwards.

### 3.5 Scenario D: Combined 10-Minute Soak & Bulkhead Saturation Proof
Executes concurrent readers, telemetry writers, and background lease mutators continuously for 10 minutes:
```bash
k6 run -e PROFILE=stress -e DURATION=10m load/k6/mixed-stress.js
```
- **What it exercises:** Proves zero connection starvation on `leasePool` during telemetry write bursts; memory profile flat over 10 minutes.

---

## 4. PR 31: Deterministic Containerized Visual Capture (`ci/automated-dashboard-screenshots`)

### 4.1 Decision & Architecture (On-Demand Docker One-Liner)
Per **Open Question 10**, to prevent subpixel font antialiasing differences across macOS, Windows, and Linux CI runners from causing noisy binary diffs, we execute visual capture inside the official Playwright Docker container with pinned fonts:
```bash
pnpm run capture:docs
```
Which executes under the hood:
```bash
docker run --rm -v $(pwd):/work -w /work mcr.microsoft.com/playwright:v1.49.0-jammy node scratch/capture-dashboards.js
```

### 4.2 Automated Capture Script (`scratch/capture-dashboards.js`)
```javascript
import { chromium } from "playwright";

const targets = [
  { url: "http://host.docker.internal:3010/", file: "docs/assets/dashboard-overview.png" },
  { url: "http://host.docker.internal:3010/leases", file: "docs/assets/dashboard-leases.png" },
  { url: "http://host.docker.internal:3010/flags", file: "docs/assets/dashboard-flags.png" },
  { url: "http://host.docker.internal:3010/audit", file: "docs/assets/dashboard-audit.png" },
  { url: "http://host.docker.internal:3002/d/synapsestate-operations/synapsestate-incident-safety-and-fleet-operations?kiosk", file: "docs/assets/grafana-dashboard.png" }
];

const browser = await chromium.launch({
  args: ["--disable-font-subpixel-positioning"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

for (const target of targets) {
  await page.goto(target.url, { waitUntil: "networkidle" });
  await page.waitForTimeout(2000); // Allow charts to render animations
  await page.screenshot({ path: target.file });
  console.log(`Captured ${target.file}`);
}

await browser.close();
```

---

## 5. Visual Asset Checklist for README Updates

Before committing new screenshots to `docs/assets/` and referencing them in `README.md`, verify:

- [ ] **No Personal Identifiers:** Header profile badges display standard demo personas (`operator` or `alice-oncall-sre`).
- [ ] **Data Populated:** Tables and charts show real data (active leases, non-zero telemetry counts, and sealed SHA-256 blocks), not "No data available".
- [ ] **No Visual Glitches:** Font rendering is crisp, SVG hairlines have 1px crispness, and alert banners are closed.
- [ ] **Consistent Framing:** Next.js dashboard screenshots captured on standard light canvas (`#ffffff` / `#fffbf5`); Grafana captured in standard dark theme or kiosk mode (`?kiosk`).
- [ ] **File Size Optimization:** Images are compressed with lossless PNG tools (`oxipng` or standard PNG optimization) to maintain repository cloning speed.
