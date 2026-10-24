// scripts/capture-dashboards.mjs
import fs from "node:fs";
import path from "node:path";

let chromium;
try {
  const pw = await import("playwright");
  chromium = pw.chromium;
} catch {
  const pwt = await import("@playwright/test");
  chromium = pwt.chromium;
}

async function resolveBaseUrl(envVar, defaultUrl, fallbackUrl) {
  if (envVar) return envVar;
  try {
    const res = await fetch(defaultUrl, { method: "HEAD", signal: AbortSignal.timeout(1000) });
    if (res.ok || res.status < 500) return defaultUrl;
  } catch {}
  try {
    const res = await fetch(fallbackUrl, { method: "HEAD", signal: AbortSignal.timeout(1000) });
    if (res.ok || res.status < 500) return fallbackUrl;
  } catch {}
  return defaultUrl;
}

const DASHBOARD_BASE = await resolveBaseUrl(
  process.env.DASHBOARD_URL,
  "http://localhost:3010",
  "http://host.docker.internal:3010"
);

const CONTROL_API_BASE = await resolveBaseUrl(
  process.env.CONTROL_API_URL,
  "http://localhost:3000",
  "http://host.docker.internal:3000"
);

const GRAFANA_BASE = await resolveBaseUrl(
  process.env.GRAFANA_URL,
  "http://localhost:3002",
  "http://host.docker.internal:3002"
);

console.log(`Connecting to:
- Dashboard:   ${DASHBOARD_BASE}
- Control API: ${CONTROL_API_BASE}
- Grafana:     ${GRAFANA_BASE}`);

// 1. Seed deterministic dashboard data
console.log("Seeding test data via Control API...");
try {
  const seedRes = await fetch(`${CONTROL_API_BASE}/__test/reset`, {
    method: "POST",
  });
  if (seedRes.ok) {
    console.log("Test data seeded successfully.");
  } else {
    console.warn(
      `Seeding returned status ${seedRes.status}; proceeding with live data.`,
    );
  }
} catch (err) {
  console.warn(
    "Control API test reset endpoint unavailable; proceeding with current state:",
    err.message,
  );
}

// 2. Target definitions
const targets = [
  {
    url: `${DASHBOARD_BASE}/`,
    file: "docs/assets/dashboard-overview.png",
    desc: "Operations Portal Overview",
  },
  {
    url: `${DASHBOARD_BASE}/leases`,
    file: "docs/assets/dashboard-leases.png",
    desc: "Active Emergency Leases",
  },
  {
    url: `${DASHBOARD_BASE}/flags`,
    file: "docs/assets/dashboard-flags.png",
    desc: "Flag Inventory & Dead Flag Qualifiers",
  },
  {
    url: `${DASHBOARD_BASE}/audit`,
    file: "docs/assets/dashboard-audit.png",
    desc: "Cryptographic Audit Ledger",
  },
  {
    url: `${GRAFANA_BASE}/d/synapsestate-operations/synapsestate-incident-safety-and-fleet-operations?kiosk`,
    file: "docs/assets/grafana-dashboard.png",
    desc: "Grafana Operations Dashboard (Kiosk Mode)",
  },
];

// 3. Launch headless browser with deterministic rendering options
console.log("Launching headless browser (1440x900)...");
const browser = await chromium.launch({
  args: [
    "--disable-font-subpixel-positioning",
    "--font-render-hinting=none",
    "--no-sandbox",
    "--disable-setuid-sandbox",
  ],
});

const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
  colorScheme: "light",
});

const page = await context.newPage();

// Enforce standard light canvas on Next.js dashboard surfaces
await page.addInitScript(() => {
  try {
    localStorage.setItem("synapse_theme", "light");
  } catch {}
});

let failedCount = 0;

for (const target of targets) {
  console.log(`Capturing ${target.desc} from ${target.url}...`);
  try {
    fs.mkdirSync(path.dirname(target.file), { recursive: true });
    await page.goto(target.url, { waitUntil: "networkidle", timeout: 30000 });
    // Allow SVG charts, CSS countdown transitions, and Grafana gauges to settle
    await page.waitForTimeout(3000);
    await page.screenshot({ path: target.file, fullPage: false });
    console.log(`Saved: ${target.file}`);
  } catch (err) {
    console.error(`Failed to capture ${target.desc}:`, err.message);
    failedCount++;
  }
}

await browser.close();

if (failedCount > 0) {
  console.error(`Visual capture completed with ${failedCount} failures.`);
  process.exit(1);
} else {
  console.log("All visual assets captured successfully.");
}
