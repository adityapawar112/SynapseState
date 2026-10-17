import { describe, it, expect } from "vitest";
import type { CandidateFlag, FlagTelemetrySnapshot, QualificationResult } from "../qualification/types.js";
import type { CallSite, CodebaseScanResult, ConsumerCrossReference, RefusalMarker } from "../scanner/types.js";
import {
  createCandidateReport,
  formatCandidateReportMarkdown,
  formatCandidateReportCli,
  formatCandidateReportJson,
  createRefusalReportFromQualification,
  createRefusalReportFromCrossReference,
  formatRefusalReportMarkdown,
  formatRefusalReportCli,
  formatRefusalReportJson,
  runPurgerAudit,
  formatPurgerAuditMarkdown,
  formatPurgerAuditCli,
} from "./index.js";

describe("Purger Candidate Reports (PR 23)", () => {
  const sampleCandidate: CandidateFlag = {
    flagKey: "checkout-v2-enabled",
    env: "production",
    winningVariant: "true",
    totalEvaluations: 1_250_000,
    evaluatingServices: ["order-service", "payment-service"],
    windowDays: 42,
    firstSeen: "2026-09-01T00:00:00.000Z",
    lastSeen: "2026-10-13T00:00:00.000Z",
  };

  const sampleCallSites: CallSite[] = [
    {
      flagKey: "checkout-v2-enabled",
      isLiteralKey: true,
      methodName: "getBooleanValue",
      defaultValueText: "false",
      location: {
        filePath: "apps/order-service/src/checkout.ts",
        startLine: 45,
        startColumn: 12,
        endLine: 45,
        endColumn: 68,
      },
      scope: {
        functionName: "executeCheckout",
        className: "CheckoutController",
        kind: "MethodDeclaration",
      },
      fullCallText: "client.getBooleanValue('checkout-v2-enabled', false)",
      serviceName: "order-service",
    },
    {
      flagKey: "checkout-v2-enabled",
      isLiteralKey: true,
      methodName: "getBooleanDetails",
      defaultValueText: "false",
      location: {
        filePath: "packages/payment/src/gateway.ts",
        startLine: 110,
        startColumn: 8,
        endLine: 110,
        endColumn: 72,
      },
      scope: {
        functionName: "processPayment",
        kind: "FunctionDeclaration",
      },
      fullCallText: "openFeatureClient.getBooleanDetails('checkout-v2-enabled', false)",
      serviceName: "payment-service",
    },
  ];

  const sampleCrossReference: ConsumerCrossReference = {
    flagKey: "checkout-v2-enabled",
    isConsistent: true,
    evaluatingServices: ["order-service", "payment-service"],
    astConsumerServices: ["order-service", "payment-service"],
    undeclaredServices: [],
    unreferencedServices: [],
    callSites: sampleCallSites,
    refusals: [],
  };

  describe("createCandidateReport", () => {
    it("creates a complete CandidateReport with call sites, Piranha, and GritQL configs", () => {
      const report = createCandidateReport({
        candidate: sampleCandidate,
        crossReference: sampleCrossReference,
        now: "2026-10-18T00:00:00.000Z",
      });

      expect(report.flagKey).toBe("checkout-v2-enabled");
      expect(report.env).toBe("production");
      expect(report.winningVariant).toBe("true");
      expect(report.winningVariantType).toBe("boolean");
      expect(report.totalEvaluations).toBe(1_250_000);
      expect(report.evaluatingServices).toEqual(["order-service", "payment-service"]);
      expect(report.windowDays).toBe(42);
      expect(report.observationSpan?.firstSeen).toBe("2026-09-01T00:00:00.000Z");
      expect(report.totalCallSites).toBe(2);
      expect(report.generatedAt).toBe("2026-10-18T00:00:00.000Z");

      // Verify formatted call site rows
      expect(report.callSites).toHaveLength(2);
      expect(report.callSites[0].filePath).toBe("apps/order-service/src/checkout.ts");
      expect(report.callSites[0].locationString).toBe("apps/order-service/src/checkout.ts:45:12-45:68");
      expect(report.callSites[0].scopeDescription).toContain("executeCheckout");
      expect(report.callSites[0].defaultValueText).toBe("false");
      expect(report.callSites[0].serviceName).toBe("order-service");

      // Verify Uber Piranha configuration
      expect(report.toolConfigs.piranha).toEqual({
        language: "typescript",
        flagName: "checkout-v2-enabled",
        flagType: "boolean",
        treated: "true",
        treatedComplement: "false",
        methodNames: ["getBooleanDetails", "getBooleanValue"],
      });

      // Verify GritQL query pattern
      expect(report.toolConfigs.gritql.engine).toBe("grit(0.1)");
      expect(report.toolConfigs.gritql.language).toBe("typescript");
      expect(report.toolConfigs.gritql.flagKey).toBe("checkout-v2-enabled");
      expect(report.toolConfigs.gritql.winningVariant).toBe("true");
      expect(report.toolConfigs.gritql.pattern).toContain("checkout-v2-enabled");
      expect(report.toolConfigs.gritql.pattern).toContain("true");
    });

    it("handles string variant flag with appropriate variant type and Piranha complement omission", () => {
      const stringCandidate: CandidateFlag = {
        flagKey: "hero-banner-copy",
        env: "production",
        winningVariant: "autumn_sale",
        totalEvaluations: 50_000,
        evaluatingServices: ["web-ui"],
        windowDays: 38,
      };

      const stringCrossReference: ConsumerCrossReference = {
        flagKey: "hero-banner-copy",
        isConsistent: true,
        evaluatingServices: ["web-ui"],
        astConsumerServices: ["web-ui"],
        undeclaredServices: [],
        unreferencedServices: [],
        callSites: [
          {
            flagKey: "hero-banner-copy",
            isLiteralKey: true,
            methodName: "getStringValue",
            defaultValueText: "'default_copy'",
            location: {
              filePath: "apps/web/banner.ts",
              startLine: 12,
              startColumn: 10,
              endLine: 12,
              endColumn: 55,
            },
            scope: { kind: "SourceFile" },
            fullCallText: "client.getStringValue('hero-banner-copy', 'default_copy')",
            serviceName: "web-ui",
          },
        ],
        refusals: [],
      };

      const report = createCandidateReport({
        candidate: stringCandidate,
        crossReference: stringCrossReference,
      });

      expect(report.winningVariantType).toBe("string");
      expect(report.toolConfigs.piranha.flagType).toBe("string");
      expect(report.toolConfigs.piranha.treated).toBe("autumn_sale");
      expect(report.toolConfigs.piranha.treatedComplement).toBeUndefined();
      expect(report.toolConfigs.gritql.pattern).toContain("'autumn_sale'");
    });
  });

  describe("Candidate Report Formatting", () => {
    it("formats human-readable Markdown issue body with call site table and tool configs", () => {
      const report = createCandidateReport({
        candidate: sampleCandidate,
        crossReference: sampleCrossReference,
      });

      const md = formatCandidateReportMarkdown(report);
      expect(md).toContain("# Stale Feature Flag Candidate: `checkout-v2-enabled`");
      expect(md).toContain("| Flag Key | `checkout-v2-enabled` |");
      expect(md).toContain("| Winning Variant | `true` (boolean) |");
      expect(md).toContain("| Window Days | 42 days |");
      expect(md).toContain("| Evaluating Services | `order-service`, `payment-service` |");
      expect(md).toContain("apps/order-service/src/checkout.ts");
      expect(md).toContain("executeCheckout");
      expect(md).toContain("```json");
      expect(md).toContain('"flagName": "checkout-v2-enabled"');
      expect(md).toContain("```grit");
    });

    it("formats CLI terminal output cleanly", () => {
      const report = createCandidateReport({
        candidate: sampleCandidate,
        crossReference: sampleCrossReference,
      });

      const cli = formatCandidateReportCli(report);
      expect(cli).toContain("CANDIDATE: checkout-v2-enabled");
      expect(cli).toContain("Winning Variant: true (boolean)");
      expect(cli).toContain("Call Sites (2):");
      expect(cli).toContain("apps/order-service/src/checkout.ts:45:12-45:68");
    });

    it("formats valid JSON representation", () => {
      const report = createCandidateReport({
        candidate: sampleCandidate,
        crossReference: sampleCrossReference,
      });

      const jsonStr = formatCandidateReportJson(report);
      const parsed = JSON.parse(jsonStr);
      expect(parsed.flagKey).toBe("checkout-v2-enabled");
      expect(parsed.callSites).toHaveLength(2);
    });
  });

  describe("createRefusalReportFromQualification", () => {
    it("creates RefusalReport for silent service blocking candidate", () => {
      const qualResult: QualificationResult = {
        flagKey: "legacy-export",
        env: "production",
        status: "DISQUALIFIED",
        reasons: ["BLOCKED_BY_SILENT_SERVICE"],
        blockingServices: ["batch-exporter"],
      };

      const report = createRefusalReportFromQualification({
        qualificationResult: qualResult,
        now: "2026-10-18T00:00:00.000Z",
      });

      expect(report.flagKey).toBe("legacy-export");
      expect(report.refusalOrigin).toBe("QUALIFICATION");
      expect(report.isBlocked).toBe(true);
      expect(report.reasons).toHaveLength(1);
      expect(report.reasons[0].code).toBe("BLOCKED_BY_SILENT_SERVICE");
      expect(report.reasons[0].blockingServices).toEqual(["batch-exporter"]);
      expect(report.reasons[0].remediation).toContain("synapse service retire --service batch-exporter");
    });

    it("creates RefusalReport for active lease existence", () => {
      const qualResult: QualificationResult = {
        flagKey: "killswitch-beta",
        env: "production",
        status: "DISQUALIFIED",
        reasons: ["ACTIVE_LEASE_EXISTS"],
      };

      const report = createRefusalReportFromQualification({ qualificationResult: qualResult });
      expect(report.reasons[0].code).toBe("ACTIVE_LEASE_EXISTS");
      expect(report.reasons[0].remediation).toContain("synapse lease revoke");
    });

    it("creates RefusalReport for multi-variant or insufficient window", () => {
      const qualResult: QualificationResult = {
        flagKey: "gradual-rollout",
        env: "production",
        status: "DISQUALIFIED",
        reasons: ["MULTI_VARIANT_ACTIVE", "INSUFFICIENT_WINDOW"],
      };

      const report = createRefusalReportFromQualification({ qualificationResult: qualResult });
      expect(report.reasons).toHaveLength(2);
      expect(report.reasons[0].code).toBe("MULTI_VARIANT_ACTIVE");
      expect(report.reasons[1].code).toBe("INSUFFICIENT_WINDOW");
    });

    it("chains remediation commands for multiple silent services with && operator", () => {
      const qualResult: QualificationResult = {
        flagKey: "multi-silent-flag",
        env: "production",
        status: "DISQUALIFIED",
        reasons: ["BLOCKED_BY_SILENT_SERVICE"],
        blockingServices: ["analytics-worker", "batch-billing"],
      };

      const report = createRefusalReportFromQualification({ qualificationResult: qualResult });
      expect(report.reasons[0].remediation).toBe(
        "synapse service retire --service analytics-worker && synapse service retire --service batch-billing"
      );
    });
  });

  describe("createRefusalReportFromCrossReference", () => {
    it("creates RefusalReport for non-literal dynamic key detected in AST", () => {
      const refusalMarker: RefusalMarker = {
        reason: "NON_LITERAL_FLAG_KEY",
        message: "Dynamic flag key expression detected",
        nodeText: "prefix + 'banner'",
        location: {
          filePath: "apps/web/src/banner.ts",
          startLine: 18,
          startColumn: 20,
          endLine: 18,
          endColumn: 36,
        },
      };

      const crossRef: ConsumerCrossReference = {
        flagKey: "banner-flag",
        isConsistent: false,
        evaluatingServices: ["web-ui"],
        astConsumerServices: ["web-ui"],
        undeclaredServices: [],
        unreferencedServices: [],
        callSites: [],
        refusals: [refusalMarker],
      };

      const report = createRefusalReportFromCrossReference({
        crossReference: crossRef,
        env: "production",
      });

      expect(report.flagKey).toBe("banner-flag");
      expect(report.refusalOrigin).toBe("SCANNER");
      expect(report.isBlocked).toBe(true);
      expect(report.reasons[0].code).toBe("NON_LITERAL_FLAG_KEY");
      expect(report.reasons[0].nodeSnippet).toBe("prefix + 'banner'");
      expect(report.reasons[0].remediation).toContain("Refactor dynamic flag key expression");
    });

    it("creates RefusalReport for undeclared consumer service in AST", () => {
      const crossRef: ConsumerCrossReference = {
        flagKey: "auth-v2",
        isConsistent: false,
        evaluatingServices: ["auth-service"],
        astConsumerServices: ["auth-service", "shadow-service"],
        undeclaredServices: ["shadow-service"],
        unreferencedServices: [],
        callSites: [],
        refusals: [],
      };

      const report = createRefusalReportFromCrossReference({
        crossReference: crossRef,
        env: "production",
      });

      expect(report.refusalOrigin).toBe("CROSS_REFERENCE");
      expect(report.reasons[0].code).toBe("UNDECLARED_CONSUMER_SERVICE");
      expect(report.reasons[0].message).toContain("shadow-service");
      expect(report.reasons[0].remediation).toContain("shadow-service");
    });
  });

  describe("Refusal Report Formatting", () => {
    it("formats refusal report Markdown with actionable remediation list", () => {
      const qualResult: QualificationResult = {
        flagKey: "cart-abandonment",
        env: "production",
        status: "DISQUALIFIED",
        reasons: ["BLOCKED_BY_SILENT_SERVICE", "ACTIVE_LEASE_EXISTS"],
        blockingServices: ["analytics-worker"],
      };

      const report = createRefusalReportFromQualification({ qualificationResult: qualResult });
      const md = formatRefusalReportMarkdown(report);

      expect(md).toContain("# Refusal Report: `cart-abandonment`");
      expect(md).toContain("DISQUALIFIED");
      expect(md).toContain("BLOCKED_BY_SILENT_SERVICE");
      expect(md).toContain("`analytics-worker`");
      expect(md).toContain("`synapse service retire --service analytics-worker`");
    });

    it("formats refusal report CLI string with clear warnings", () => {
      const qualResult: QualificationResult = {
        flagKey: "cart-abandonment",
        env: "production",
        status: "DISQUALIFIED",
        reasons: ["BLOCKED_BY_SILENT_SERVICE"],
        blockingServices: ["analytics-worker"],
      };

      const report = createRefusalReportFromQualification({ qualificationResult: qualResult });
      const cli = formatRefusalReportCli(report);

      expect(cli).toContain("REFUSAL: cart-abandonment");
      expect(cli).toContain("BLOCKED_BY_SILENT_SERVICE");
      expect(cli).toContain("Remediation: synapse service retire --service analytics-worker");
    });

    it("formats valid JSON representation", () => {
      const qualResult: QualificationResult = {
        flagKey: "cart-abandonment",
        env: "production",
        status: "DISQUALIFIED",
        reasons: ["BLOCKED_BY_SILENT_SERVICE"],
        blockingServices: ["analytics-worker"],
      };

      const report = createRefusalReportFromQualification({ qualificationResult: qualResult });
      const jsonStr = formatRefusalReportJson(report);
      const parsed = JSON.parse(jsonStr);
      expect(parsed.flagKey).toBe("cart-abandonment");
      expect(parsed.isBlocked).toBe(true);
    });
  });

  describe("runPurgerAudit Pipeline", () => {
    it("orchestrates qualification, scan cross-referencing, and report generation", () => {
      const qualifiedSnapshot: FlagTelemetrySnapshot = {
        flagKey: "checkout-v2-enabled",
        env: "production",
        flagClass: "release",
        hasActiveLease: false,
        windowDays: 40,
        firstSeen: "2026-09-01T00:00:00.000Z",
        lastSeen: "2026-10-12T00:00:00.000Z",
        variants: [{ variant: "true", evalCount: 10_000 }],
        services: [{ serviceName: "order-service", status: "ACTIVE", evalCount: 10_000 }],
      };

      const silentBlockedSnapshot: FlagTelemetrySnapshot = {
        flagKey: "silent-flag",
        env: "production",
        flagClass: "release",
        hasActiveLease: false,
        windowDays: 40,
        firstSeen: "2026-09-01T00:00:00.000Z",
        lastSeen: "2026-10-12T00:00:00.000Z",
        variants: [{ variant: "true", evalCount: 500 }],
        services: [{ serviceName: "dead-service", status: "SILENT", evalCount: 500 }],
      };

      const scanResult: CodebaseScanResult = {
        totalFilesScanned: 1,
        totalCallSites: 1,
        callSites: [
          {
            flagKey: "checkout-v2-enabled",
            isLiteralKey: true,
            methodName: "getBooleanValue",
            defaultValueText: "false",
            location: {
              filePath: "apps/order-service/src/main.ts",
              startLine: 10,
              startColumn: 5,
              endLine: 10,
              endColumn: 55,
            },
            scope: { kind: "SourceFile" },
            fullCallText: "client.getBooleanValue('checkout-v2-enabled', false)",
            serviceName: "order-service",
          },
        ],
        flagReferences: {
          "checkout-v2-enabled": {
            flagKey: "checkout-v2-enabled",
            totalCallSites: 1,
            callSites: [
              {
                flagKey: "checkout-v2-enabled",
                isLiteralKey: true,
                methodName: "getBooleanValue",
                defaultValueText: "false",
                location: {
                  filePath: "apps/order-service/src/main.ts",
                  startLine: 10,
                  startColumn: 5,
                  endLine: 10,
                  endColumn: 55,
                },
                scope: { kind: "SourceFile" },
                fullCallText: "client.getBooleanValue('checkout-v2-enabled', false)",
                serviceName: "order-service",
              },
            ],
            consumerServices: ["order-service"],
            hasRefusals: false,
            refusals: [],
          },
        },
        unresolvedCallSites: [],
        unresolvedCallSitesByService: {},
        unresolvedServices: [],
        refusals: [],
      };

      const audit = runPurgerAudit({
        snapshots: [qualifiedSnapshot, silentBlockedSnapshot],
        scanResult,
      });

      expect(audit.summary.totalEvaluated).toBe(2);
      expect(audit.summary.totalQualified).toBe(1);
      expect(audit.summary.totalRefused).toBe(1);
      expect(audit.summary.totalCallSitesFound).toBe(1);

      expect(audit.candidates).toHaveLength(1);
      expect(audit.candidates[0].flagKey).toBe("checkout-v2-enabled");
      expect(audit.candidates[0].toolConfigs.piranha.flagName).toBe("checkout-v2-enabled");

      expect(audit.refusals).toHaveLength(1);
      expect(audit.refusals[0].flagKey).toBe("silent-flag");
      expect(audit.refusals[0].reasons[0].code).toBe("BLOCKED_BY_SILENT_SERVICE");

      // Verify formatted multi-report outputs
      const mdReport = formatPurgerAuditMarkdown(audit);
      expect(mdReport).toContain("# SynapseState Purger Audit Report");
      expect(mdReport).toContain("| Qualified Candidates | 1 |");
      expect(mdReport).toContain("checkout-v2-enabled");
      expect(mdReport).toContain("silent-flag");

      const cliReport = formatPurgerAuditCli(audit);
      expect(cliReport).toContain("SYNAPSESTATE PURGER AUDIT");
      expect(cliReport).toContain("Qualified: 1");
      expect(cliReport).toContain("checkout-v2-enabled");
    });

    it("demotes qualified candidate to RefusalReport when AST cross-reference reveals undeclared caller", () => {
      const qualifiedSnapshot: FlagTelemetrySnapshot = {
        flagKey: "feature-x",
        env: "production",
        flagClass: "release",
        hasActiveLease: false,
        windowDays: 40,
        firstSeen: "2026-09-01T00:00:00.000Z",
        lastSeen: "2026-10-12T00:00:00.000Z",
        variants: [{ variant: "true", evalCount: 10_000 }],
        services: [{ serviceName: "service-a", status: "ACTIVE", evalCount: 10_000 }],
      };

      // Scanner finds call in service-b (undeclared!)
      const scanResult: CodebaseScanResult = {
        totalFilesScanned: 1,
        totalCallSites: 1,
        callSites: [
          {
            flagKey: "feature-x",
            isLiteralKey: true,
            methodName: "getBooleanValue",
            defaultValueText: "false",
            location: {
              filePath: "services/service-b/src/index.ts",
              startLine: 20,
              startColumn: 5,
              endLine: 20,
              endColumn: 50,
            },
            scope: { kind: "SourceFile" },
            fullCallText: "client.getBooleanValue('feature-x', false)",
            serviceName: "service-b",
          },
        ],
        flagReferences: {
          "feature-x": {
            flagKey: "feature-x",
            totalCallSites: 1,
            callSites: [],
            consumerServices: ["service-b"],
            hasRefusals: false,
            refusals: [],
          },
        },
        unresolvedCallSites: [],
        unresolvedCallSitesByService: {},
        unresolvedServices: [],
        refusals: [],
      };

      const audit = runPurgerAudit({
        snapshots: [qualifiedSnapshot],
        scanResult,
      });

      expect(audit.summary.totalQualified).toBe(0);
      expect(audit.summary.totalRefused).toBe(1);
      expect(audit.candidates).toHaveLength(0);
      expect(audit.refusals).toHaveLength(1);
      expect(audit.refusals[0].flagKey).toBe("feature-x");
      expect(audit.refusals[0].reasons[0].code).toBe("UNDECLARED_CONSUMER_SERVICE");
    });

    it("runs audit with scannerOptions scanning provided source text dynamically", () => {
      const qualifiedSnapshot: FlagTelemetrySnapshot = {
        flagKey: "dynamic-scan-flag",
        env: "production",
        flagClass: "release",
        hasActiveLease: false,
        windowDays: 45,
        firstSeen: "2026-08-01T00:00:00.000Z",
        lastSeen: "2026-10-15T00:00:00.000Z",
        variants: [{ variant: "true", evalCount: 50_000 }],
        services: [{ serviceName: "order-service", status: "ACTIVE", evalCount: 50_000 }],
      };

      const sourceCode = `
        import { OpenFeature } from '@openfeature/server-sdk';
        const client = OpenFeature.getClient();
        export function checkFlag() {
          return client.getBooleanValue('dynamic-scan-flag', false);
        }
      `;

      const audit = runPurgerAudit({
        snapshots: [qualifiedSnapshot],
        scannerOptions: {
          sourceTexts: [{ filePath: "apps/order-service/src/index.ts", content: sourceCode }],
        },
      });

      expect(audit.summary.totalEvaluated).toBe(1);
      expect(audit.summary.totalQualified).toBe(1);
      expect(audit.candidates).toHaveLength(1);
      expect(audit.candidates[0].totalCallSites).toBe(1);
    });

    it("handles empty snapshots gracefully", () => {
      const audit = runPurgerAudit({ snapshots: [] });
      expect(audit.summary.totalEvaluated).toBe(0);
      expect(audit.summary.totalQualified).toBe(0);
      expect(audit.summary.totalRefused).toBe(0);
      expect(audit.candidates).toHaveLength(0);
      expect(audit.refusals).toHaveLength(0);
    });
  });

  describe("Edge Cases & Formatting Coverage", () => {
    it("handles number and object variant types in candidate reports", () => {
      const numCandidate: CandidateFlag = {
        flagKey: "rate-limit-per-sec",
        env: "production",
        winningVariant: "500",
        totalEvaluations: 10_000,
        evaluatingServices: ["api-gateway"],
        windowDays: 40,
      };

      const numReport = createCandidateReport({
        candidate: numCandidate,
        crossReference: {
          flagKey: "rate-limit-per-sec",
          isConsistent: true,
          evaluatingServices: ["api-gateway"],
          astConsumerServices: ["api-gateway"],
          undeclaredServices: [],
          unreferencedServices: [],
          callSites: [],
          refusals: [],
        },
      });

      expect(numReport.winningVariantType).toBe("number");
      expect(numReport.toolConfigs.piranha.flagType).toBe("number");
      expect(numReport.totalCallSites).toBe(0);

      const objCandidate: CandidateFlag = {
        flagKey: "feature-config-json",
        env: "production",
        winningVariant: '{"cacheEnabled":true}',
        totalEvaluations: 10_000,
        evaluatingServices: ["backend"],
        windowDays: 40,
      };

      const objReport = createCandidateReport({
        candidate: objCandidate,
        crossReference: {
          flagKey: "feature-config-json",
          isConsistent: true,
          evaluatingServices: ["backend"],
          astConsumerServices: ["backend"],
          undeclaredServices: [],
          unreferencedServices: [],
          callSites: [],
          refusals: [],
        },
      });

      expect(objReport.winningVariantType).toBe("object");
      expect(objReport.toolConfigs.piranha.flagType).toBe("object");

      // Verify empty call sites markdown note
      const md = formatCandidateReportMarkdown(numReport);
      expect(md).toContain("_No call sites detected in scanned source files._");
    });

    it("handles scanner refusal markers for missing arguments, missing defaults, and scan errors", () => {
      const missingArgsRefusal: RefusalMarker = {
        reason: "MISSING_ARGUMENTS",
        message: "0 arguments provided",
        nodeText: "client.getBooleanValue()",
        location: { filePath: "test.ts", startLine: 1, startColumn: 1, endLine: 1, endColumn: 25 },
      };

      const missingDefaultRefusal: RefusalMarker = {
        reason: "MISSING_DEFAULT_VALUE",
        message: "Missing default value argument",
        nodeText: "client.getBooleanValue('key')",
        location: { filePath: "test.ts", startLine: 2, startColumn: 1, endLine: 2, endColumn: 30 },
      };

      const scanErrorRefusal: RefusalMarker = {
        reason: "SCAN_ERROR",
        message: "Parser error",
        nodeText: "syntax error",
        location: { filePath: "test.ts", startLine: 3, startColumn: 1, endLine: 3, endColumn: 15 },
      };

      const crossRef: ConsumerCrossReference = {
        flagKey: "bad-calls-flag",
        isConsistent: false,
        evaluatingServices: ["svc"],
        astConsumerServices: ["svc"],
        undeclaredServices: [],
        unreferencedServices: [],
        callSites: [],
        refusals: [missingArgsRefusal, missingDefaultRefusal, scanErrorRefusal],
      };

      const report = createRefusalReportFromCrossReference({ crossReference: crossRef, env: "production" });
      expect(report.reasons).toHaveLength(3);
      expect(report.reasons[0].code).toBe("MISSING_ARGUMENTS");
      expect(report.reasons[1].code).toBe("MISSING_DEFAULT_VALUE");
      expect(report.reasons[2].code).toBe("SCAN_ERROR");
    });

    it("handles qualification refusals for unregistered and missing default variants", () => {
      const unregisteredResult: QualificationResult = {
        flagKey: "unreg-flag",
        env: "production",
        status: "DISQUALIFIED",
        reasons: ["UNREGISTERED_FLAG", "MISSING_DEFAULT_VARIANT", "EXCLUDED_LIFECYCLE_CLASS"],
      };

      const report = createRefusalReportFromQualification({ qualificationResult: unregisteredResult });
      expect(report.reasons).toHaveLength(3);
      expect(report.reasons[0].code).toBe("UNREGISTERED_FLAG");
      expect(report.reasons[1].code).toBe("MISSING_DEFAULT_VARIANT");
      expect(report.reasons[2].code).toBe("EXCLUDED_LIFECYCLE_CLASS");
    });

    it("fails closed when scan is missing or yields 0 call sites for candidate flag (C1)", () => {
      const qualifiedSnapshot: FlagTelemetrySnapshot = {
        flagKey: "zero-call-sites-flag",
        env: "production",
        flagClass: "release",
        hasActiveLease: false,
        windowDays: 40,
        firstSeen: "2026-09-01T00:00:00.000Z",
        lastSeen: "2026-10-12T00:00:00.000Z",
        variants: [{ variant: "true", evalCount: 5_000 }],
        services: [{ serviceName: "order-service", status: "ACTIVE", evalCount: 5_000 }],
      };

      // No scanResult or scannerOptions provided
      const audit = runPurgerAudit({
        snapshots: [qualifiedSnapshot],
      });

      expect(audit.summary.totalQualified).toBe(0);
      expect(audit.summary.totalRefused).toBe(1);
      expect(audit.candidates).toHaveLength(0);
      expect(audit.refusals).toHaveLength(1);
      expect(audit.refusals[0].flagKey).toBe("zero-call-sites-flag");
      expect(audit.refusals[0].reasons[0].code).toBe("CONSISTENCY_MISMATCH");
    });

    it("fails closed on unreferenced telemetry service when allowUnreferencedServices is false by default (C1)", () => {
      const qualifiedSnapshot: FlagTelemetrySnapshot = {
        flagKey: "unref-flag",
        env: "production",
        flagClass: "release",
        hasActiveLease: false,
        windowDays: 40,
        firstSeen: "2026-09-01T00:00:00.000Z",
        lastSeen: "2026-10-12T00:00:00.000Z",
        variants: [{ variant: "true", evalCount: 5_000 }],
        services: [{ serviceName: "billing-service", status: "ACTIVE", evalCount: 5_000 }],
      };

      // Scanner finds call in order-service, but telemetry only knows billing-service
      const scanResult: CodebaseScanResult = {
        totalFilesScanned: 1,
        totalCallSites: 1,
        callSites: [],
        flagReferences: {
          "unref-flag": {
            flagKey: "unref-flag",
            totalCallSites: 0,
            callSites: [],
            consumerServices: [],
            hasRefusals: false,
            refusals: [],
          },
        },
        unresolvedCallSites: [],
        unresolvedCallSitesByService: {},
        unresolvedServices: [],
        refusals: [],
      };

      const audit = runPurgerAudit({
        snapshots: [qualifiedSnapshot],
        scanResult,
        // allowUnreferencedServices defaults to false
      });

      expect(audit.summary.totalQualified).toBe(0);
      expect(audit.summary.totalRefused).toBe(1);
      expect(audit.refusals[0].reasons[0].code).toBe("CONSISTENCY_MISMATCH");
    });

    it("generates type-aware default methods for string, number, and object flags without call sites (C2)", () => {
      const stringCandidate: CandidateFlag = {
        flagKey: "str-flag",
        env: "production",
        winningVariant: "premium",
        totalEvaluations: 100,
        evaluatingServices: ["ui"],
        windowDays: 40,
      };

      const stringReport = createCandidateReport({
        candidate: stringCandidate,
        crossReference: {
          flagKey: "str-flag",
          isConsistent: true,
          evaluatingServices: ["ui"],
          astConsumerServices: ["ui"],
          undeclaredServices: [],
          unreferencedServices: [],
          callSites: [],
          refusals: [],
        },
      });

      expect(stringReport.toolConfigs.piranha.methodNames).toEqual([
        "getStringDetails",
        "getStringValue",
      ]);
      expect(stringReport.toolConfigs.gritql.targetMethods).toEqual([
        "getStringDetails",
        "getStringValue",
      ]);

      const numCandidate: CandidateFlag = {
        flagKey: "num-flag",
        env: "production",
        winningVariant: "100",
        totalEvaluations: 100,
        evaluatingServices: ["ui"],
        windowDays: 40,
      };

      const numReport = createCandidateReport({
        candidate: numCandidate,
        crossReference: {
          flagKey: "num-flag",
          isConsistent: true,
          evaluatingServices: ["ui"],
          astConsumerServices: ["ui"],
          undeclaredServices: [],
          unreferencedServices: [],
          callSites: [],
          refusals: [],
        },
      });

      expect(numReport.toolConfigs.piranha.methodNames).toEqual([
        "getNumberDetails",
        "getNumberValue",
      ]);
    });

    it("escapes single quotes and backslashes in GritQL patterns for string variants (C2)", () => {
      const stringCandidate: CandidateFlag = {
        flagKey: "quote-flag",
        env: "production",
        winningVariant: "it's an 'autumn' special\\discount",
        totalEvaluations: 100,
        evaluatingServices: ["ui"],
        windowDays: 40,
      };

      const report = createCandidateReport({
        candidate: stringCandidate,
        crossReference: {
          flagKey: "quote-flag",
          isConsistent: true,
          evaluatingServices: ["ui"],
          astConsumerServices: ["ui"],
          undeclaredServices: [],
          unreferencedServices: [],
          callSites: [],
          refusals: [],
        },
      });

      expect(report.toolConfigs.gritql.pattern).toContain(
        "it\\'s an \\'autumn\\' special\\\\discount"
      );
    });

    it("strictly verifies numeric strings and validates JSON for object variants (I2)", async () => {
      const { inferVariantType } = await import("./candidate.js");

      // Strict numbers
      expect(inferVariantType("123")).toBe("number");
      expect(inferVariantType("-42.5")).toBe("number");
      expect(inferVariantType("0")).toBe("number");

      // Non-strict numbers treated as strings
      expect(inferVariantType("0x10")).toBe("string");
      expect(inferVariantType("1e3")).toBe("string");
      expect(inferVariantType("Infinity")).toBe("string");
      expect(inferVariantType("NaN")).toBe("string");

      // Valid JSON objects vs invalid JSON
      expect(inferVariantType('{"valid": true}')).toBe("object");
      expect(inferVariantType('[1, 2, 3]')).toBe("object");
      expect(inferVariantType('{invalid: json}')).toBe("string");
    });
  });
});
