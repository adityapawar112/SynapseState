/**
 * Read-Only ts-morph AST Scanner for SynapseState Purger.
 *
 * Implements Phase 5 Deliverable 5.2 (Read-Only TypeScript Scanner) according to:
 * - AGENTS.md (§1 Non-Goals, §2 Architectural Invariants 1-8, especially Invariant 6)
 * - docs/ARCHITECTURE.md (§9 Telemetry-Driven Stale Detection & Scanner, §10 Security Threat Model)
 * - docs/adr/0006-read-only-scanner-for-code-retirement.md
 *
 * Boundary Invariant (Invariant 6):
 * Strictly read-only AST parser using ts-morph. Zero execution of `npm test`, `eval()`,
 * or repository build scripts while holding credentials.
 */

import {
  Project,
  SyntaxKind,
  Node,
  type SourceFile,
  type CallExpression,
} from "ts-morph";
import {
  OPENFEATURE_EVAL_METHODS,
  type OpenFeatureEvalMethod,
  type CallSite,
  type RefusalMarker,
  type SourceLocation,
  type EnclosingScope,
  type ASTFlagReference,
  type CodebaseScanResult,
  type ScannerOptions,
  type ConsumerCrossReference,
  type CrossReferenceOptions,
} from "./types.js";

const EVAL_METHODS_SET = new Set<string>(OPENFEATURE_EVAL_METHODS);

export { OPENFEATURE_EVAL_METHODS };

/**
 * Default service resolver mapping repository file paths to service/package names
 * based on standard monorepo folder conventions (apps/*, packages/*, services/*).
 * Uses the innermost component if nested in monorepo workspaces.
 */
export function defaultServiceResolver(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const matches = [...normalized.matchAll(/(?:^|\/)(?:apps|packages|services)\/([^/]+)/g)];
  if (matches.length > 0) {
    const lastMatch = matches[matches.length - 1];
    if (lastMatch && lastMatch[1]) {
      return lastMatch[1];
    }
  }
  return "root";
}

/**
 * Determines whether a call expression invokes a standard OpenFeature evaluation method.
 */
function getEvaluationMethodName(
  callExpr: CallExpression,
): OpenFeatureEvalMethod | undefined {
  const expr = callExpr.getExpression();

  if (Node.isPropertyAccessExpression(expr)) {
    const name = expr.getName();
    if (EVAL_METHODS_SET.has(name)) {
      return name as OpenFeatureEvalMethod;
    }
  } else if (Node.isIdentifier(expr)) {
    const name = expr.getText();
    if (EVAL_METHODS_SET.has(name)) {
      return name as OpenFeatureEvalMethod;
    }
  }

  return undefined;
}

/**
 * Normalizes file paths across operating systems and ts-morph in-memory virtual file systems.
 */
function normalizeFilePath(rawPath: string): string {
  let normalized = rawPath.replace(/\\/g, "/");
  if (normalized.startsWith("/")) {
    normalized = normalized.replace(/^\/+/, "");
  }
  return normalized;
}

/**
 * Extracts 1-indexed source location coordinates for an AST node.
 */
function extractSourceLocation(
  node: Node,
  sourceFile: SourceFile,
): SourceLocation {
  const start = node.getStart();
  const end = node.getEnd();
  const { line: startLine, column: startColumn } =
    sourceFile.getLineAndColumnAtPos(start);
  const { line: endLine, column: endColumn } =
    sourceFile.getLineAndColumnAtPos(end);

  return {
    filePath: normalizeFilePath(sourceFile.getFilePath()),
    startLine,
    startColumn,
    endLine,
    endColumn,
  };
}

/**
 * Traverses AST ancestors to determine enclosing function and class scope.
 */
function extractEnclosingScope(callExpr: CallExpression): EnclosingScope {
  let current: Node | undefined = callExpr.getParent();
  let functionName: string | undefined;
  let className: string | undefined;
  let kind = "SourceFile";

  while (current) {
    if (Node.isFunctionDeclaration(current)) {
      if (!functionName) {
        functionName = current.getName();
        kind = "FunctionDeclaration";
      }
    } else if (Node.isMethodDeclaration(current)) {
      if (!functionName) {
        functionName = current.getName();
        kind = "MethodDeclaration";
      }
    } else if (Node.isArrowFunction(current) || Node.isFunctionExpression(current)) {
      if (!functionName) {
        const parent = current.getParent();
        if (Node.isVariableDeclaration(parent)) {
          functionName = parent.getName();
          kind = "ArrowFunction";
        } else if (Node.isPropertyAssignment(parent)) {
          functionName = parent.getName();
          kind = "FunctionExpression";
        } else {
          kind = "AnonymousFunction";
        }
      }
    } else if (Node.isClassDeclaration(current) || Node.isClassExpression(current)) {
      if (!className) {
        className = current.getName();
      }
    }

    current = current.getParent();
  }

  return {
    functionName,
    className,
    kind,
  };
}

/**
 * Inspects an OpenFeature CallExpression and returns a structured CallSite model.
 */
function parseCallSite(
  callExpr: CallExpression,
  methodName: OpenFeatureEvalMethod,
  sourceFile: SourceFile,
  serviceResolver: (filePath: string) => string | undefined,
): CallSite {
  const location = extractSourceLocation(callExpr, sourceFile);
  const scope = extractEnclosingScope(callExpr);
  const fullCallText = callExpr.getText();
  const serviceName = serviceResolver(sourceFile.getFilePath());
  const args = callExpr.getArguments();

  // Guard 1: Missing arguments (0 arguments)
  if (args.length === 0) {
    const refusal: RefusalMarker = {
      reason: "MISSING_ARGUMENTS",
      message: `OpenFeature evaluation method '${methodName}' called without arguments; expected flagKey and defaultValue`,
      nodeText: fullCallText,
      location,
    };
    return {
      flagKey: null,
      isLiteralKey: false,
      methodName,
      location,
      scope,
      fullCallText,
      serviceName,
      refusal,
    };
  }

  const firstArg = args[0]!;
  let flagKey: string | null = null;
  let isLiteralKey = false;
  let refusal: RefusalMarker | undefined;

  // Check if first argument is a literal string key
  if (Node.isStringLiteral(firstArg)) {
    flagKey = firstArg.getLiteralValue();
    isLiteralKey = true;
  } else if (Node.isNoSubstitutionTemplateLiteral(firstArg)) {
    // Template literal with no expressions (e.g. `flag-key`) is a constant literal
    flagKey = firstArg.getLiteralValue();
    isLiteralKey = true;
  } else {
    // Non-literal key: variable, ternary, interpolation, function call, property access
    isLiteralKey = false;
    refusal = {
      reason: "NON_LITERAL_FLAG_KEY",
      message: `Dynamic or non-literal flag key expression '${firstArg.getText()}' violates safety invariants; purger refuses dynamic resolution`,
      nodeText: firstArg.getText(),
      location: extractSourceLocation(firstArg, sourceFile),
    };
  }

  // Guard 2: Missing default value (1 argument)
  let defaultValueText: string | undefined;
  if (args.length >= 2) {
    defaultValueText = args[1]!.getText();
  } else if (!refusal) {
    refusal = {
      reason: "MISSING_DEFAULT_VALUE",
      message: `OpenFeature evaluation method '${methodName}' called without defaultValue argument`,
      nodeText: fullCallText,
      location,
    };
  }

  return {
    flagKey,
    isLiteralKey,
    methodName,
    defaultValueText,
    location,
    scope,
    fullCallText,
    serviceName,
    refusal,
  };
}

/**
 * Scans a list of ts-morph SourceFiles and extracts all OpenFeature call sites,
 * indexes caller references by flag key, and reports dynamic refusals.
 */
export function scanSourceFiles(
  sourceFiles: SourceFile[],
  options?: ScannerOptions,
): CodebaseScanResult {
  const serviceResolver = options?.serviceResolver ?? defaultServiceResolver;
  const allCallSites: CallSite[] = [];
  const flagReferences: Record<string, ASTFlagReference> = {};
  const unresolvedCallSites: CallSite[] = [];
  const allRefusals: RefusalMarker[] = [];

  for (const sourceFile of sourceFiles) {
    const callExpressions = sourceFile.getDescendantsOfKind(
      SyntaxKind.CallExpression,
    );

    for (const callExpr of callExpressions) {
      const methodName = getEvaluationMethodName(callExpr);
      if (!methodName) {
        continue;
      }

      const callSite = parseCallSite(
        callExpr,
        methodName,
        sourceFile,
        serviceResolver,
      );
      allCallSites.push(callSite);

      if (callSite.refusal) {
        allRefusals.push(callSite.refusal);
      }

      if (callSite.flagKey === null) {
        unresolvedCallSites.push(callSite);
      } else {
        let flagRef = flagReferences[callSite.flagKey];
        if (!flagRef) {
          flagRef = {
            flagKey: callSite.flagKey,
            totalCallSites: 0,
            callSites: [],
            consumerServices: [],
            hasRefusals: false,
            refusals: [],
          };
          flagReferences[callSite.flagKey] = flagRef;
        }

        flagRef.totalCallSites += 1;
        flagRef.callSites.push(callSite);

        if (
          callSite.serviceName &&
          !flagRef.consumerServices.includes(callSite.serviceName)
        ) {
          flagRef.consumerServices.push(callSite.serviceName);
        }

        if (callSite.refusal) {
          flagRef.hasRefusals = true;
          flagRef.refusals.push(callSite.refusal);
        }
      }
    }
  }

  return {
    totalFilesScanned: sourceFiles.length,
    totalCallSites: allCallSites.length,
    callSites: allCallSites,
    flagReferences,
    unresolvedCallSites,
    refusals: allRefusals,
  };
}

/**
 * In-memory scanner helper: creates an in-memory ts-morph Project from source text entries
 * and returns the codebase scan result.
 */
export function scanSourceTexts(
  sourceTexts: Array<{ filePath: string; content: string }>,
  options?: ScannerOptions,
): CodebaseScanResult {
  const project =
    options?.project ??
    new Project({
      useInMemoryFileSystem: true,
      compilerOptions: { allowJs: true },
    });

  for (const item of sourceTexts) {
    project.createSourceFile(item.filePath, item.content, { overwrite: true });
  }

  return scanSourceFiles(project.getSourceFiles(), options);
}

/**
 * Scans an existing ts-morph Project or creates one based on ScannerOptions.
 */
export function scanCodebase(options?: ScannerOptions): CodebaseScanResult {
  if (options?.sourceTexts) {
    return scanSourceTexts(options.sourceTexts, options);
  }

  const project =
    options?.project ??
    new Project({
      skipAddingFilesFromTsConfig: true,
    });

  if (options?.sourceFilePaths && options.sourceFilePaths.length > 0) {
    for (const filePath of options.sourceFilePaths) {
      project.addSourceFileAtPathIfExists(filePath);
    }
  }

  return scanSourceFiles(project.getSourceFiles(), options);
}

/**
 * Cross-references candidate flags against codebase scan results to verify that
 * static AST consumers align with runtime evaluating services recorded in telemetry.
 *
 * Invariant Violation Check:
 * If an AST call site is discovered in a service that recorded 0 evaluations in telemetry
 * (an Undeclared Caller), this emits an explicit refusal/warning marker and marks the flag inconsistent.
 */
export function crossReferenceConsumers(
  options: CrossReferenceOptions,
): ConsumerCrossReference[] {
  const { candidates, scanResult } = options;
  const results: ConsumerCrossReference[] = [];

  for (const candidate of candidates) {
    const flagKey = candidate.flagKey;
    const evaluatingServices = candidate.evaluatingServices ?? [];
    const flagRef = scanResult.flagReferences[flagKey];

    const astConsumerServices = flagRef ? [...flagRef.consumerServices] : [];
    const callSites = flagRef ? [...flagRef.callSites] : [];
    const refusals: RefusalMarker[] = flagRef ? [...flagRef.refusals] : [];

    // Find undeclared services: in AST but not in telemetry evaluatingServices
    const undeclaredServices = astConsumerServices.filter(
      (svc) => !evaluatingServices.includes(svc),
    );

    // Find unreferenced services: in telemetry evaluatingServices but no AST callers found
    const unreferencedServices = evaluatingServices.filter(
      (svc) => !astConsumerServices.includes(svc),
    );

    for (const undeclared of undeclaredServices) {
      const matchSite = callSites.find((cs) => cs.serviceName === undeclared);
      const defaultLoc: SourceLocation = {
        filePath: matchSite?.location.filePath ?? "",
        startLine: matchSite?.location.startLine ?? 1,
        startColumn: matchSite?.location.startColumn ?? 1,
        endLine: matchSite?.location.endLine ?? 1,
        endColumn: matchSite?.location.endColumn ?? 1,
      };

      refusals.push({
        reason: "UNDECLARED_CONSUMER_SERVICE",
        message: `AST call sites for flag '${flagKey}' found in service '${undeclared}' which has 0 recorded evaluations in telemetry`,
        nodeText: matchSite?.fullCallText ?? flagKey,
        location: matchSite?.location ?? defaultLoc,
      });
    }

    const isConsistent = undeclaredServices.length === 0 && refusals.length === 0;

    results.push({
      flagKey,
      isConsistent,
      evaluatingServices,
      astConsumerServices,
      undeclaredServices,
      unreferencedServices,
      callSites,
      refusals,
    });
  }

  return results;
}
