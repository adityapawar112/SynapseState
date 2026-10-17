import { describe, it, expect } from "vitest";
import {
  scanSourceTexts,
  scanCodebase,
  crossReferenceConsumers,
  defaultServiceResolver,
} from "./scanner.js";
import { createPurgerProject } from "../index.js";
import type { CandidateFlag } from "../qualification/types.js";

describe("Read-Only ts-morph AST Scanner (PR 22)", () => {
  describe("OpenFeature Method Call Site Detection", () => {
    it("detects standard OpenFeature getBooleanValue with literal key and default value", () => {
      const source = `
        import { OpenFeature } from '@openfeature/server-sdk';
        const client = OpenFeature.getClient();

        export function checkFeature() {
          const isEnabled = client.getBooleanValue('payment.v2', false);
          return isEnabled;
        }
      `;

      const result = scanSourceTexts([
        { filePath: "apps/payment-svc/src/index.ts", content: source },
      ]);

      expect(result.totalFilesScanned).toBe(1);
      expect(result.totalCallSites).toBe(1);
      const callSite = result.callSites[0]!;
      expect(callSite.flagKey).toBe("payment.v2");
      expect(callSite.isLiteralKey).toBe(true);
      expect(callSite.methodName).toBe("getBooleanValue");
      expect(callSite.defaultValueText).toBe("false");
      expect(callSite.location.filePath).toBe("apps/payment-svc/src/index.ts");
      expect(callSite.location.startLine).toBe(6);
      expect(callSite.scope.functionName).toBe("checkFeature");
      expect(callSite.serviceName).toBe("payment-svc");
      expect(callSite.refusal).toBeUndefined();
    });

    it("detects getStringValue, getNumberValue, and getObjectValue with respective types", () => {
      const source = `
        const theme = client.getStringValue('ui.theme', 'dark');
        const limit = client.getNumberValue('rate.limit', 500);
        const config = client.getObjectValue('checkout.config', { retry: true });
      `;

      const result = scanSourceTexts([
        { filePath: "apps/frontend-api/src/config.ts", content: source },
      ]);

      expect(result.totalCallSites).toBe(3);

      expect(result.callSites[0]?.flagKey).toBe("ui.theme");
      expect(result.callSites[0]?.methodName).toBe("getStringValue");
      expect(result.callSites[0]?.defaultValueText).toBe("'dark'");

      expect(result.callSites[1]?.flagKey).toBe("rate.limit");
      expect(result.callSites[1]?.methodName).toBe("getNumberValue");
      expect(result.callSites[1]?.defaultValueText).toBe("500");

      expect(result.callSites[2]?.flagKey).toBe("checkout.config");
      expect(result.callSites[2]?.methodName).toBe("getObjectValue");
      expect(result.callSites[2]?.defaultValueText).toBe("{ retry: true }");
    });

    it("detects get*Details variants", () => {
      const source = `
        const boolDetails = client.getBooleanDetails('flag.bool', true);
        const strDetails = client.getStringDetails('flag.str', 'fallback');
        const numDetails = client.getNumberDetails('flag.num', 42);
        const objDetails = client.getObjectDetails('flag.obj', {});
      `;

      const result = scanSourceTexts([
        { filePath: "apps/test-svc/src/details.ts", content: source },
      ]);

      expect(result.totalCallSites).toBe(4);
      expect(result.callSites.map((c) => c.methodName)).toEqual([
        "getBooleanDetails",
        "getStringDetails",
        "getNumberDetails",
        "getObjectDetails",
      ]);
    });

    it("extracts class and method scope for class methods", () => {
      const source = `
        export class OrderProcessor {
          public async processOrder() {
            return client.getBooleanValue('order.async-flow', true);
          }
        }
      `;

      const result = scanSourceTexts([
        { filePath: "apps/order-svc/src/processor.ts", content: source },
      ]);

      expect(result.totalCallSites).toBe(1);
      const callSite = result.callSites[0]!;
      expect(callSite.scope.className).toBe("OrderProcessor");
      expect(callSite.scope.functionName).toBe("processOrder");
    });

    it("extracts arrow function variable name as function scope", () => {
      const source = `
        const validateCart = () => {
          return client.getBooleanValue('cart.strict-validation', false);
        };
      `;

      const result = scanSourceTexts([
        { filePath: "apps/cart-svc/src/validate.ts", content: source },
      ]);

      expect(result.totalCallSites).toBe(1);
      expect(result.callSites[0]?.scope.functionName).toBe("validateCart");
    });

    it("handles top-level calls without enclosing function or class", () => {
      const source = `
        const initialFlag = client.getBooleanValue('startup.banner', false);
      `;

      const result = scanSourceTexts([
        { filePath: "apps/banner-svc/src/init.ts", content: source },
      ]);

      expect(result.totalCallSites).toBe(1);
      expect(result.callSites[0]?.scope.functionName).toBeUndefined();
      expect(result.callSites[0]?.scope.className).toBeUndefined();
    });

    it("supports static template literals without interpolation as literal keys", () => {
      const source = `
        const enabled = client.getBooleanValue(\`static-template-key\`, false);
      `;

      const result = scanSourceTexts([
        { filePath: "apps/static-svc/src/index.ts", content: source },
      ]);

      expect(result.totalCallSites).toBe(1);
      expect(result.callSites[0]?.flagKey).toBe("static-template-key");
      expect(result.callSites[0]?.isLiteralKey).toBe(true);
      expect(result.callSites[0]?.refusal).toBeUndefined();
    });
  });

  describe("Refusal by Default on Non-Literal Keys (Security Invariant 6)", () => {
    it("refuses binary concatenation expressions as non-literal flag keys", () => {
      const source = `
        const prefix = 'feature.';
        const enabled = client.getBooleanValue(prefix + 'checkout', false);
      `;

      const result = scanSourceTexts([
        { filePath: "apps/checkout-svc/src/index.ts", content: source },
      ]);

      expect(result.totalCallSites).toBe(1);
      const callSite = result.callSites[0]!;
      expect(callSite.flagKey).toBeNull();
      expect(callSite.isLiteralKey).toBe(false);
      expect(callSite.refusal).toBeDefined();
      expect(callSite.refusal?.reason).toBe("NON_LITERAL_FLAG_KEY");
      expect(callSite.refusal?.nodeText).toBe("prefix + 'checkout'");
      expect(result.unresolvedCallSites).toHaveLength(1);
      expect(result.refusals).toHaveLength(1);
    });

    it("refuses variable identifiers as non-literal flag keys", () => {
      const source = `
        const myFlagKey = 'promo.banner';
        const enabled = client.getBooleanValue(myFlagKey, false);
      `;

      const result = scanSourceTexts([
        { filePath: "apps/promo-svc/src/index.ts", content: source },
      ]);

      expect(result.totalCallSites).toBe(1);
      const callSite = result.callSites[0]!;
      expect(callSite.flagKey).toBeNull();
      expect(callSite.isLiteralKey).toBe(false);
      expect(callSite.refusal?.reason).toBe("NON_LITERAL_FLAG_KEY");
      expect(callSite.refusal?.nodeText).toBe("myFlagKey");
    });

    it("refuses ternary conditional expressions", () => {
      const source = `
        const isStaging = true;
        const enabled = client.getBooleanValue(isStaging ? 'flag.staging' : 'flag.prod', false);
      `;

      const result = scanSourceTexts([
        { filePath: "apps/routing-svc/src/index.ts", content: source },
      ]);

      expect(result.totalCallSites).toBe(1);
      expect(result.callSites[0]?.refusal?.reason).toBe("NON_LITERAL_FLAG_KEY");
    });

    it("refuses interpolated template literals", () => {
      const source = `
        const env = 'prod';
        const enabled = client.getBooleanValue(\`flag.\${env}.feature\`, false);
      `;

      const result = scanSourceTexts([
        { filePath: "apps/routing-svc/src/index.ts", content: source },
      ]);

      expect(result.totalCallSites).toBe(1);
      expect(result.callSites[0]?.refusal?.reason).toBe("NON_LITERAL_FLAG_KEY");
      expect(result.callSites[0]?.refusal?.nodeText).toBe("`flag.${env}.feature`");
    });

    it("refuses function call expressions passed as flag key", () => {
      const source = `
        function getDynamicKey() { return 'dynamic'; }
        const enabled = client.getBooleanValue(getDynamicKey(), false);
      `;

      const result = scanSourceTexts([
        { filePath: "apps/routing-svc/src/index.ts", content: source },
      ]);

      expect(result.totalCallSites).toBe(1);
      expect(result.callSites[0]?.refusal?.reason).toBe("NON_LITERAL_FLAG_KEY");
    });

    it("refuses property access expressions passed as flag key", () => {
      const source = `
        const FLAGS = { CHECKOUT: 'checkout-v2' };
        const enabled = client.getBooleanValue(FLAGS.CHECKOUT, false);
      `;

      const result = scanSourceTexts([
        { filePath: "apps/routing-svc/src/index.ts", content: source },
      ]);

      expect(result.totalCallSites).toBe(1);
      expect(result.callSites[0]?.refusal?.reason).toBe("NON_LITERAL_FLAG_KEY");
      expect(result.callSites[0]?.refusal?.nodeText).toBe("FLAGS.CHECKOUT");
    });

    it("refuses calls with missing arguments (0 args)", () => {
      const source = `
        // @ts-ignore
        const enabled = client.getBooleanValue();
      `;

      const result = scanSourceTexts([
        { filePath: "apps/invalid-svc/src/index.ts", content: source },
      ]);

      expect(result.totalCallSites).toBe(1);
      expect(result.callSites[0]?.refusal?.reason).toBe("MISSING_ARGUMENTS");
    });

    it("refuses calls with missing default value (1 arg)", () => {
      const source = `
        // @ts-ignore
        const enabled = client.getBooleanValue('payment.v2');
      `;

      const result = scanSourceTexts([
        { filePath: "apps/invalid-svc/src/index.ts", content: source },
      ]);

      expect(result.totalCallSites).toBe(1);
      expect(result.callSites[0]?.flagKey).toBe("payment.v2");
      expect(result.callSites[0]?.refusal?.reason).toBe("MISSING_DEFAULT_VALUE");
    });
  });

  describe("Service Resolution & Codebase Indexing", () => {
    it("resolves default service from standard monorepo folder conventions", () => {
      expect(defaultServiceResolver("apps/billing-api/src/index.ts")).toBe(
        "billing-api",
      );
      expect(defaultServiceResolver("packages/shared-lib/src/util.ts")).toBe(
        "shared-lib",
      );
      expect(defaultServiceResolver("services/auth/src/token.ts")).toBe(
        "auth",
      );
      expect(defaultServiceResolver("src/index.ts")).toBe("root");
    });

    it("allows custom serviceResolver override", () => {
      const source = `client.getBooleanValue('test.flag', false);`;
      const result = scanSourceTexts(
        [{ filePath: "custom/path/worker.ts", content: source }],
        {
          serviceResolver: (path) =>
            path.includes("worker") ? "worker-service" : "other",
        },
      );

      expect(result.callSites[0]?.serviceName).toBe("worker-service");
    });

    it("aggregates multiple call sites into flag reference index", () => {
      const file1 = `
        client.getBooleanValue('checkout.v2', false);
      `;
      const file2 = `
        client.getBooleanValue('checkout.v2', false);
        client.getStringValue('other.flag', 'val');
      `;

      const result = scanSourceTexts([
        { filePath: "apps/web/src/checkout.ts", content: file1 },
        { filePath: "apps/api/src/checkout.ts", content: file2 },
      ]);

      expect(result.totalCallSites).toBe(3);
      const checkoutRef = result.flagReferences["checkout.v2"];
      expect(checkoutRef).toBeDefined();
      expect(checkoutRef?.totalCallSites).toBe(2);
      expect(checkoutRef?.consumerServices).toEqual(["web", "api"]);
      expect(checkoutRef?.hasRefusals).toBe(false);

      const otherRef = result.flagReferences["other.flag"];
      expect(otherRef?.totalCallSites).toBe(1);
      expect(otherRef?.consumerServices).toEqual(["api"]);
    });

    it("ignores irrelevant method calls and non-OpenFeature receivers", () => {
      const source = `
        client.setContext({ user: '123' });
        client.onProviderReady();
        const num = Math.min(1, 2);
        const str = "hello".toUpperCase();
      `;

      const result = scanSourceTexts([
        { filePath: "apps/test/src/index.ts", content: source },
      ]);

      expect(result.totalCallSites).toBe(0);
      expect(result.refusals).toHaveLength(0);
    });
  });

  describe("Consumer Cross-Referencing", () => {
    const candidate: CandidateFlag = {
      flagKey: "checkout.v2",
      env: "production",
      winningVariant: "true",
      totalEvaluations: 100000,
      evaluatingServices: ["web-frontend", "checkout-api"],
      windowDays: 45,
    };

    it("returns consistent when AST consumers match runtime evaluating services", () => {
      const file1 = `client.getBooleanValue('checkout.v2', false);`;
      const file2 = `client.getBooleanValue('checkout.v2', false);`;

      const scanResult = scanSourceTexts([
        { filePath: "apps/web-frontend/src/a.ts", content: file1 },
        { filePath: "apps/checkout-api/src/b.ts", content: file2 },
      ]);

      const crossRef = crossReferenceConsumers({
        candidates: [candidate],
        scanResult,
      });

      expect(crossRef).toHaveLength(1);
      const ref = crossRef[0]!;
      expect(ref.flagKey).toBe("checkout.v2");
      expect(ref.isConsistent).toBe(true);
      expect(ref.undeclaredServices).toEqual([]);
      expect(ref.unreferencedServices).toEqual([]);
      expect(ref.refusals).toEqual([]);
    });

    it("detects undeclared callers when AST call site exists in service with 0 telemetry evaluations", () => {
      const file1 = `client.getBooleanValue('checkout.v2', false);`;
      const file2 = `client.getBooleanValue('checkout.v2', false);`;
      // rogue service calling flag without recorded telemetry!
      const file3 = `client.getBooleanValue('checkout.v2', false);`;

      const scanResult = scanSourceTexts([
        { filePath: "apps/web-frontend/src/a.ts", content: file1 },
        { filePath: "apps/checkout-api/src/b.ts", content: file2 },
        { filePath: "apps/rogue-cron/src/c.ts", content: file3 },
      ]);

      const crossRef = crossReferenceConsumers({
        candidates: [candidate],
        scanResult,
      });

      expect(crossRef).toHaveLength(1);
      const ref = crossRef[0]!;
      expect(ref.flagKey).toBe("checkout.v2");
      expect(ref.isConsistent).toBe(false);
      expect(ref.undeclaredServices).toEqual(["rogue-cron"]);
      expect(ref.refusals).toHaveLength(1);
      expect(ref.refusals[0]?.reason).toBe("UNDECLARED_CONSUMER_SERVICE");
      expect(ref.refusals[0]?.message).toContain("rogue-cron");
    });

    it("detects unreferenced services when candidate telemetry had evaluations but no AST call sites exist", () => {
      // Only web-frontend has AST call site, checkout-api has none in code
      const file1 = `client.getBooleanValue('checkout.v2', false);`;

      const scanResult = scanSourceTexts([
        { filePath: "apps/web-frontend/src/a.ts", content: file1 },
      ]);

      const crossRef = crossReferenceConsumers({
        candidates: [candidate],
        scanResult,
      });

      expect(crossRef).toHaveLength(1);
      const ref = crossRef[0]!;
      // An unreferenced service indicates dead or removed callers, but not an undeclared risk
      expect(ref.unreferencedServices).toEqual(["checkout-api"]);
      expect(ref.undeclaredServices).toEqual([]);
      expect(ref.isConsistent).toBe(true);
    });

    it("marks cross-reference inconsistent if AST references have non-literal refusals", () => {
      const file = `
        const k = 'checkout.v2';
        client.getBooleanValue(k, false);
      `;

      const scanResult = scanSourceTexts([
        { filePath: "apps/web-frontend/src/a.ts", content: file },
      ]);

      const crossRef = crossReferenceConsumers({
        candidates: [candidate],
        scanResult,
      });

      expect(crossRef).toHaveLength(1);
      const ref = crossRef[0]!;
      // Because 'k' was non-literal, 'checkout.v2' was not recognized in AST
      expect(ref.callSites).toHaveLength(0);
      expect(ref.unreferencedServices).toEqual([
        "web-frontend",
        "checkout-api",
      ]);
    });
  });

  describe("Codebase Scanner Invariants & Entry Points", () => {
    it("scans via scanCodebase using sourceTexts option", () => {
      const result = scanCodebase({
        sourceTexts: [
          {
            filePath: "apps/api/src/index.ts",
            content: "client.getBooleanValue('flag.a', true);",
          },
        ],
      });

      expect(result.totalFilesScanned).toBe(1);
      expect(result.totalCallSites).toBe(1);
      expect(result.callSites[0]?.flagKey).toBe("flag.a");
    });

    it("scans an existing ts-morph Project instance directly", () => {
      const project = createPurgerProject();
      project.createSourceFile(
        "apps/service-x/src/app.ts",
        "client.getStringValue('greeting', 'hello');",
      );

      const result = scanCodebase({ project });
      expect(result.totalFilesScanned).toBe(1);
      expect(result.totalCallSites).toBe(1);
      expect(result.callSites[0]?.flagKey).toBe("greeting");
      expect(result.callSites[0]?.serviceName).toBe("service-x");
    });
  });
});

