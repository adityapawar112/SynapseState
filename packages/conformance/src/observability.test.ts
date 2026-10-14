import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import yaml from "yaml";

const REPO_ROOT = path.resolve(__dirname, "../../..");
const DASHBOARD_PATH = path.join(
  REPO_ROOT,
  "deploy/helm/dashboards/synapsestate-operations.json",
);
const ALERTS_PATH = path.join(
  REPO_ROOT,
  "deploy/helm/alerts/synapsestate-rules.yaml",
);
const CONTROL_API_CHART_PATH = path.join(REPO_ROOT, "deploy/helm/control-api");

// Invariant 5: Cardinality boundary constants
const ALLOWED_METRIC_LABELS = new Set([
  "env",
  "status_code",
  "reason",
  "from",
  "to",
  "le",
]);
const FORBIDDEN_HIGH_CARDINALITY_LABELS = [
  "user_id",
  "userId",
  "context",
  "lease_id",
  "leaseId",
  "flag_key",
  "flagKey",
  "actor",
  "kid",
  "service",
  "instance_id",
  "instanceId",
  "targeting_key",
  "targetingKey",
];

describe("Phase 3 PR 13: Observability Dashboards & Alertmanager Rules", () => {
  describe("Grafana Operations Dashboard (deploy/helm/dashboards/synapsestate-operations.json)", () => {
    it("dashboard file exists and parses as valid JSON", () => {
      expect(fs.existsSync(DASHBOARD_PATH)).toBe(true);
      const raw = fs.readFileSync(DASHBOARD_PATH, "utf-8");
      const json = JSON.parse(raw);
      expect(json).toBeDefined();
      expect(typeof json).toBe("object");
    });

    it("has required top-level metadata and standard Grafana settings", () => {
      const raw = fs.readFileSync(DASHBOARD_PATH, "utf-8");
      const json = JSON.parse(raw);

      expect(json.uid).toBe("synapsestate-operations");
      expect(json.title).toContain("SynapseState");
      expect(json.editable).toBe(true);
      expect(json.schemaVersion).toBeGreaterThanOrEqual(30);
      expect(Array.isArray(json.tags)).toBe(true);
      expect(json.tags).toContain("synapsestate");
      expect(json.tags).toContain("openfeature");
      expect(json.time).toBeDefined();
      expect(json.time.from).toBeDefined();
      expect(json.time.to).toBeDefined();
    });

    it("configures required dashboard template variables ($datasource and $env)", () => {
      const raw = fs.readFileSync(DASHBOARD_PATH, "utf-8");
      const json = JSON.parse(raw);

      const templating = json.templating?.list ?? [];
      const varNames = templating.map((v: { name: string }) => v.name);

      expect(varNames).toContain("datasource");
      expect(varNames).toContain("env");
    });

    it("implements the full panel hierarchy across all 4 operational domains", () => {
      const raw = fs.readFileSync(DASHBOARD_PATH, "utf-8");
      const json = JSON.parse(raw);

      // Collect all panels (including rows or nested panels)
      const allPanels: Array<{
        id: number;
        title?: string;
        type?: string;
        targets?: Array<{ expr?: string }>;
        gridPos?: { h: number; w: number; x: number; y: number };
      }> = [];

      function collectPanels(panels: typeof allPanels) {
        for (const p of panels) {
          allPanels.push(p);
          if (Array.isArray((p as { panels?: typeof allPanels }).panels)) {
            collectPanels((p as { panels?: typeof allPanels }).panels!);
          }
        }
      }
      collectPanels(json.panels ?? []);

      expect(allPanels.length).toBeGreaterThanOrEqual(10);

      // Verify gridPos coordinates exist and are non-negative
      for (const p of allPanels) {
        if (p.type !== "row" && p.gridPos) {
          expect(p.gridPos.x).toBeGreaterThanOrEqual(0);
          expect(p.gridPos.y).toBeGreaterThanOrEqual(0);
          expect(p.gridPos.w).toBeGreaterThan(0);
          expect(p.gridPos.h).toBeGreaterThan(0);
        }
      }

      // Collect all target expressions
      const allExprs = allPanels
        .flatMap((p) => p.targets ?? [])
        .map((t) => t.expr)
        .filter((e): e is string => typeof e === "string");

      const exprStr = allExprs.join(" \n ");

      // Domain 1: Active Incident & Overrides Overview
      expect(exprStr).toContain("synapse_leases_active");
      expect(exprStr).toContain("synapse_lease_transitions_total");

      // Domain 2: SLO & Latency Performance
      expect(exprStr).toContain("synapse_lease_propagation_seconds");
      expect(exprStr).toContain("histogram_quantile");
      expect(exprStr).toContain("synapse_state_poll_duration_seconds");

      // Domain 3: Audit Ledger Health
      expect(exprStr).toContain("synapse_audit_pending_queue_size");
      expect(exprStr).toContain("synapse_audit_pending_age_seconds");
      expect(exprStr).toContain("synapse_audit_chain_length");

      // Domain 4: Client SDK Fleet Health
      expect(exprStr).toContain("synapse_sdk_state_age_seconds");
      expect(exprStr).toContain("synapse_sdk_keyset_age_seconds");
      expect(exprStr).toContain("synapse_sdk_poll_errors_total");
      expect(exprStr).toContain("synapse_sdk_telemetry_dropped_total");
      expect(exprStr).toContain("synapse_sdk_active_overrides");
    });

    it("Metric Cardinality Audit (Invariant 5): zero high-cardinality labels referenced in dashboard queries", () => {
      const raw = fs.readFileSync(DASHBOARD_PATH, "utf-8");
      const json = JSON.parse(raw);

      const allPanels: Array<{ targets?: Array<{ expr?: string }> }> = [];
      function collect(panels: typeof allPanels) {
        for (const p of panels) {
          allPanels.push(p);
          if (Array.isArray((p as { panels?: typeof allPanels }).panels)) {
            collect((p as { panels?: typeof allPanels }).panels!);
          }
        }
      }
      collect(json.panels ?? []);

      const allExprs = allPanels
        .flatMap((p) => p.targets ?? [])
        .map((t) => t.expr)
        .filter((e): e is string => typeof e === "string");

      for (const expr of allExprs) {
        for (const forbidden of FORBIDDEN_HIGH_CARDINALITY_LABELS) {
          const regex = new RegExp(`\\b${forbidden}\\b`, "i");
          expect(regex.test(expr)).toBe(false);
        }

        // Verify any label matched inside {label=...} or by (label, ...) is an allowed label
        const bracketLabels = [...expr.matchAll(/\{([^}]+)\}/g)].flatMap((m) =>
          m[1]!.split(",").map((kv) => kv.split(/[=~!]/)[0]!.trim()),
        );
        const byLabels = [...expr.matchAll(/by\s*\(([^)]+)\)/g)].flatMap((m) =>
          m[1]!.split(",").map((s) => s.trim()),
        );

        for (const label of [...bracketLabels, ...byLabels]) {
          if (label && label !== "__name__") {
            expect(ALLOWED_METRIC_LABELS.has(label)).toBe(true);
          }
        }
      }
    });
  });

  describe("Alertmanager Multi-Window Multi-Burn-Rate Rules (deploy/helm/alerts/synapsestate-rules.yaml)", () => {
    it("rules file exists and parses as valid YAML", () => {
      expect(fs.existsSync(ALERTS_PATH)).toBe(true);
      const raw = fs.readFileSync(ALERTS_PATH, "utf-8");
      const parsed = yaml.parse(raw);
      expect(parsed).toBeDefined();
      expect(Array.isArray(parsed.groups)).toBe(true);
    });

    it("defines the expected alert rules in group synapsestate-slo-alerts", () => {
      const raw = fs.readFileSync(ALERTS_PATH, "utf-8");
      const parsed = yaml.parse(raw);
      const group = parsed.groups.find(
        (g: { name: string }) => g.name === "synapsestate-slo-alerts",
      );
      expect(group).toBeDefined();

      const alertNames = group.rules
        .filter((r: { alert?: string }) => Boolean(r.alert))
        .map((r: { alert: string }) => r.alert);

      expect(alertNames).toContain("SynapseStateApiAvailabilityFastBurn");
      expect(alertNames).toContain("SynapseStateApiAvailabilitySlowBurn");
      expect(alertNames).toContain("SynapseLeasePropagationDegraded");
      expect(alertNames).toContain("SynapseAuditSealerLagging");
      expect(alertNames).toContain("SynapseStateStale");
      expect(alertNames).toContain("SynapseKeysetStale");
    });

    it("verifies Multi-Window Multi-Burn-Rate mathematical correctness for 99.5% SLO", () => {
      const raw = fs.readFileSync(ALERTS_PATH, "utf-8");
      const parsed = yaml.parse(raw);
      const group = parsed.groups.find(
        (g: { name: string }) => g.name === "synapsestate-slo-alerts",
      );
      const rules = group.rules;

      // 1. Fast Burn: 14.4x burn rate (consumes 2% in 1 hour)
      // 99.5% SLO => error budget = 0.5% (0.005)
      // 14.4 * 0.005 = 0.072 (7.2% error rate threshold)
      // Windows: 1h (long) and 5m (short)
      const fastBurn = rules.find(
        (r: { alert?: string }) =>
          r.alert === "SynapseStateApiAvailabilityFastBurn",
      );
      expect(fastBurn).toBeDefined();
      expect(fastBurn.labels.severity).toBe("critical");
      expect(fastBurn.expr).toContain("1h");
      expect(fastBurn.expr).toContain("5m");
      expect(fastBurn.expr).toMatch(/(14\.4\s*\*\s*0\.005|0\.072)/);
      expect(fastBurn.expr.toLowerCase()).toContain("and");

      // 2. Slow Burn: 6x burn rate (consumes 5% in 6 hours)
      // 6 * 0.005 = 0.030 (3.0% error rate threshold)
      // Windows: 6h (long) and 30m (short)
      const slowBurn = rules.find(
        (r: { alert?: string }) =>
          r.alert === "SynapseStateApiAvailabilitySlowBurn",
      );
      expect(slowBurn).toBeDefined();
      expect(slowBurn.labels.severity).toBe("warning");
      expect(slowBurn.expr).toContain("6h");
      expect(slowBurn.expr).toContain("30m");
      expect(slowBurn.expr).toMatch(/(6\s*\*\s*0\.005|0\.030|0\.03)/);
      expect(slowBurn.expr.toLowerCase()).toContain("and");
    });

    it("verifies lease propagation degradation alert matches p95 <= 10s SLO", () => {
      const raw = fs.readFileSync(ALERTS_PATH, "utf-8");
      const parsed = yaml.parse(raw);
      const group = parsed.groups.find(
        (g: { name: string }) => g.name === "synapsestate-slo-alerts",
      );
      const rule = group.rules.find(
        (r: { alert?: string }) =>
          r.alert === "SynapseLeasePropagationDegraded",
      );

      expect(rule).toBeDefined();
      expect(rule.expr).toContain("histogram_quantile");
      expect(rule.expr).toContain("0.95");
      expect(rule.expr).toContain("synapse_lease_propagation_seconds_bucket");
      expect(rule.expr).toContain("> 10");
      expect(rule.for).toBe("5m");
    });

    it("verifies audit sealer stall alert triggers if pending age exceeds 30s", () => {
      const raw = fs.readFileSync(ALERTS_PATH, "utf-8");
      const parsed = yaml.parse(raw);
      const group = parsed.groups.find(
        (g: { name: string }) => g.name === "synapsestate-slo-alerts",
      );
      const rule = group.rules.find(
        (r: { alert?: string }) => r.alert === "SynapseAuditSealerLagging",
      );

      expect(rule).toBeDefined();
      expect(rule.expr).toContain("synapse_audit_pending_age_seconds > 30");
      expect(rule.for).toBe("2m");
      expect(rule.labels.severity).toBe("critical");
    });

    it("verifies SDK state and keyset staleness alert thresholds (60s and 900s)", () => {
      const raw = fs.readFileSync(ALERTS_PATH, "utf-8");
      const parsed = yaml.parse(raw);
      const group = parsed.groups.find(
        (g: { name: string }) => g.name === "synapsestate-slo-alerts",
      );

      const stateStale = group.rules.find(
        (r: { alert?: string }) => r.alert === "SynapseStateStale",
      );
      expect(stateStale).toBeDefined();
      expect(stateStale.expr).toContain("synapse_sdk_state_age_seconds > 60");
      expect(stateStale.for).toBe("5m");

      const keysetStale = group.rules.find(
        (r: { alert?: string }) => r.alert === "SynapseKeysetStale",
      );
      expect(keysetStale).toBeDefined();
      expect(keysetStale.expr).toContain(
        "synapse_sdk_keyset_age_seconds > 900",
      );
      expect(keysetStale.labels.severity).toBe("critical");
    });

    it("Metric Cardinality Audit (Invariant 5): zero high-cardinality labels in alert expressions", () => {
      const raw = fs.readFileSync(ALERTS_PATH, "utf-8");
      const parsed = yaml.parse(raw);
      const group = parsed.groups.find(
        (g: { name: string }) => g.name === "synapsestate-slo-alerts",
      );

      for (const rule of group.rules) {
        if (!rule.expr) continue;
        for (const forbidden of FORBIDDEN_HIGH_CARDINALITY_LABELS) {
          const regex = new RegExp(`\\b${forbidden}\\b`, "i");
          expect(regex.test(rule.expr)).toBe(false);
        }
      }
    });
  });

  describe("Helm Chart Observability Integration (deploy/helm/control-api/)", () => {
    it("values.yaml defines monitoring section with dashboards, prometheusRule, and alertsConfigMap options", () => {
      const valuesPath = path.join(CONTROL_API_CHART_PATH, "values.yaml");
      expect(fs.existsSync(valuesPath)).toBe(true);
      const raw = fs.readFileSync(valuesPath, "utf-8");
      const values = yaml.parse(raw);

      expect(values.monitoring).toBeDefined();
      expect(values.monitoring.dashboards).toBeDefined();
      expect(typeof values.monitoring.dashboards.enabled).toBe("boolean");
      expect(values.monitoring.prometheusRule).toBeDefined();
      expect(typeof values.monitoring.prometheusRule.enabled).toBe("boolean");
      expect(values.monitoring.alertsConfigMap).toBeDefined();
      expect(typeof values.monitoring.alertsConfigMap.enabled).toBe("boolean");
    });

    it("contains Helm templates for dashboard and PrometheusRule/alert resources", () => {
      const templatesDir = path.join(CONTROL_API_CHART_PATH, "templates");
      const files = fs.readdirSync(templatesDir);

      const hasDashboardTemplate = files.some((f) => f.includes("dashboard"));
      const hasAlertsOrRuleTemplate = files.some(
        (f) => f.includes("prometheusrule") || f.includes("alert"),
      );

      expect(hasDashboardTemplate).toBe(true);
      expect(hasAlertsOrRuleTemplate).toBe(true);
    });

    it("renders dashboard ConfigMap by default and omits it when disabled via helm template", async () => {
      const { execSync } = await import("node:child_process");

      // 1. Default render should include dashboard ConfigMap
      const defaultOutput = execSync(
        `helm template test-rel "${CONTROL_API_CHART_PATH}"`,
        { encoding: "utf-8" },
      );
      expect(defaultOutput).toContain("kind: ConfigMap");
      expect(defaultOutput).toContain("test-rel-control-api-dashboard");
      expect(defaultOutput).toContain("synapsestate-operations.json");

      // 2. Disabled render should omit dashboard ConfigMap
      const disabledOutput = execSync(
        `helm template test-rel "${CONTROL_API_CHART_PATH}" --set monitoring.dashboards.enabled=false`,
        { encoding: "utf-8" },
      );
      expect(disabledOutput).not.toContain("test-rel-control-api-dashboard");
    });

    it("renders PrometheusRule CRD conditionally when monitoring.prometheusRule.enabled=true", async () => {
      const { execSync } = await import("node:child_process");

      // 1. Disabled by default
      const defaultOutput = execSync(
        `helm template test-rel "${CONTROL_API_CHART_PATH}"`,
        { encoding: "utf-8" },
      );
      expect(defaultOutput).not.toContain("kind: PrometheusRule");
      expect(defaultOutput).not.toContain("test-rel-control-api-alerts");

      // 2. Enabled renders PrometheusRule
      const enabledOutput = execSync(
        `helm template test-rel "${CONTROL_API_CHART_PATH}" --set monitoring.prometheusRule.enabled=true`,
        { encoding: "utf-8" },
      );
      expect(enabledOutput).toContain("kind: PrometheusRule");
      expect(enabledOutput).toContain("test-rel-control-api-alerts");
      expect(enabledOutput).toContain("SynapseStateApiAvailabilityFastBurn");
      expect(enabledOutput).toContain("SynapseLeasePropagationDegraded");
    });

    it("renders alerts ConfigMap conditionally when monitoring.alertsConfigMap.enabled=true", async () => {
      const { execSync } = await import("node:child_process");

      // 1. Disabled by default
      const defaultOutput = execSync(
        `helm template test-rel "${CONTROL_API_CHART_PATH}"`,
        { encoding: "utf-8" },
      );
      expect(defaultOutput).not.toContain("synapsestate-rules.yaml");

      // 2. Enabled renders ConfigMap with synapsestate-rules.yaml
      const enabledOutput = execSync(
        `helm template test-rel "${CONTROL_API_CHART_PATH}" --set monitoring.alertsConfigMap.enabled=true`,
        { encoding: "utf-8" },
      );
      expect(enabledOutput).toContain("kind: ConfigMap");
      expect(enabledOutput).toContain("test-rel-control-api-alerts");
      expect(enabledOutput).toContain("synapsestate-rules.yaml");
      expect(enabledOutput).toContain("synapsestate-slo-alerts");
    });
  });
});
