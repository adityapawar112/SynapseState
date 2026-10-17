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
 * Normalizes file paths across operating systems and ts-morph in-memory virtual file systems.
 * Strips leading slash only for virtual roots (/apps/, /packages/, /services/, /src/).
 */
export function normalizeFilePath(rawPath: string): string {
  let normalized = rawPath.replace(/\\/g, "/");
  if (
    normalized.startsWith("/") &&
    /^\/(?:apps|packages|services|src)\//.test(normalized)
  ) {
    normalized = normalized.slice(1);
  }
  return normalized;
}

/**
 * Default service resolver mapping repository file paths to service/package names
 * based on standard monorepo folder conventions (apps/*, packages/*, services/*).
 * Uses the innermost component if nested in monorepo workspaces.
 */
export function defaultServiceResolver(filePath: string): string {
  const normalized = normalizeFilePath(filePath);
  const matches = [
    ...normalized.matchAll(/(?:^|\/)(?:apps|packages|services)\/([^/]+)/g),
  ];
  if (matches.length > 0) {
    const lastMatch = matches[matches.length - 1];
    if (lastMatch && lastMatch[1]) {
      return lastMatch[1];
    }
  }
  return "root";
}

/**
 * Unwraps parenthesized expressions and type assertions (`as const`, `<type>`).
 */
export function unwrapExpression(node: Node): Node {
  let current = node;
  while (
    Node.isParenthesizedExpression(current) ||
    Node.isAsExpression(current) ||
    Node.isTypeAssertion(current)
  ) {
    current = current.getExpression();
  }
  return current;
}

interface MethodDispatchInspection {
  methodName?: OpenFeatureEvalMethod;
  isDynamicElementAccess?: boolean;
}

/**
 * Determines whether a call expression invokes a standard OpenFeature evaluation method,
 * handling property access (`client.getBooleanValue`), element access (`client['getBooleanValue']`),
 * dynamic element access (`client[method]`), and optional bare identifiers.
 */
function inspectEvaluationMethod(
  callExpr: CallExpression,
  allowBareIdentifiers = false,
): MethodDispatchInspection {
  const expr = callExpr.getExpression();

  if (Node.isPropertyAccessExpression(expr)) {
    const name = expr.getName();
    if (EVAL_METHODS_SET.has(name)) {
      return { methodName: name as OpenFeatureEvalMethod };
    }
  } else if (Node.isElementAccessExpression(expr)) {
    const argExpr = expr.getArgumentExpression();
    if (argExpr) {
      const unwrapped = unwrapExpression(argExpr);
      if (
        Node.isStringLiteral(unwrapped) ||
        Node.isNoSubstitutionTemplateLiteral(unwrapped)
      ) {
        const val = unwrapped.getLiteralValue();
        if (EVAL_METHODS_SET.has(val)) {
          return { methodName: val as OpenFeatureEvalMethod };
        }
      } else {
        // Dynamic element access: client[dynamicExpr](...)
        return { isDynamicElementAccess: true };
      }
    }
  } else if (Node.isIdentifier(expr)) {
    if (allowBareIdentifiers) {
      const name = expr.getText();
      if (EVAL_METHODS_SET.has(name)) {
        return { methodName: name as OpenFeatureEvalMethod };
      }
    }
  }

  return {};
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
 * Supports FunctionDeclaration, MethodDeclaration, PropertyDeclaration (arrow property),
 * ConstructorDeclaration, GetAccessor, SetAccessor, and ArrowFunction variable bindings.
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
    } else if (Node.isConstructorDeclaration(current)) {
      if (!functionName) {
        functionName = "constructor";
        kind = "ConstructorDeclaration";
      }
    } else if (Node.isGetAccessorDeclaration(current)) {
      if (!functionName) {
        functionName = current.getName();
        kind = "GetAccessor";
      }
    } else if (Node.isSetAccessorDeclaration(current)) {
      if (!functionName) {
        functionName = current.getName();
        kind = "SetAccessor";
      }
    } else if (
      Node.isArrowFunction(current) ||
      Node.isFunctionExpression(current)
    ) {
      if (!functionName) {
        const parent = current.getParent();
        if (Node.isVariableDeclaration(parent)) {
          functionName = parent.getName();
          kind = "ArrowFunction";
        } else if (Node.isPropertyAssignment(parent)) {
          functionName = parent.getName();
          kind = "PropertyAssignment";
        } else if (Node.isPropertyDeclaration(parent)) {
          functionName = parent.getName();
          kind = "PropertyDeclaration";
        } else {
          kind = "AnonymousFunction";
        }
      }
    } else if (
      Node.isClassDeclaration(current) ||
      Node.isClassExpression(current)
    ) {
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
  isDynamicMethodDispatch = false,
): CallSite {
  const location = extractSourceLocation(callExpr, sourceFile);
  const scope = extractEnclosingScope(callExpr);
  const fullCallText = callExpr.getText();
  const serviceName = serviceResolver(sourceFile.getFilePath());
  const args = callExpr.getArguments();

  if (isDynamicMethodDispatch) {
    const refusal: RefusalMarker = {
      reason: "NON_LITERAL_FLAG_KEY",
      message: `Dynamic method element access violates safety invariants; purger refuses dynamic resolution`,
      nodeText: callExpr.getExpression().getText(),
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
  const unwrappedFirstArg = unwrapExpression(firstArg);
  let flagKey: string | null = null;
  let isLiteralKey = false;
  let refusal: RefusalMarker | undefined;

  // Check if first argument is a literal string key
  if (Node.isStringLiteral(unwrappedFirstArg)) {
    flagKey = unwrappedFirstArg.getLiteralValue();
    isLiteralKey = true;
  } else if (Node.isNoSubstitutionTemplateLiteral(unwrappedFirstArg)) {
    // Template literal with no expressions (e.g. `flag-key`) is a constant literal
    flagKey = unwrappedFirstArg.getLiteralValue();
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
 * indexes caller references by flag key, indexes unresolved calls by service,
 * and traps any unexpected errors within a fail-closed boundary.
 */
export function scanSourceFiles(
  sourceFiles: SourceFile[],
  options?: ScannerOptions,
): CodebaseScanResult {
  const serviceResolver = options?.serviceResolver ?? defaultServiceResolver;
  const allowBare = options?.allowBareIdentifiers ?? false;

  const allCallSites: CallSite[] = [];
  const flagReferences: Record<string, ASTFlagReference> = {};
  const unresolvedCallSites: CallSite[] = [];
  const unresolvedCallSitesByService: Record<string, CallSite[]> = {};
  const unresolvedServicesSet = new Set<string>();
  const allRefusals: RefusalMarker[] = [];

  for (const sourceFile of sourceFiles) {
    try {
      const callExpressions = sourceFile.getDescendantsOfKind(
        SyntaxKind.CallExpression,
      );

      for (const callExpr of callExpressions) {
        try {
          const inspection = inspectEvaluationMethod(callExpr, allowBare);
          if (!inspection.methodName && !inspection.isDynamicElementAccess) {
            continue;
          }

          const targetMethod = inspection.methodName ?? "getBooleanValue";
          const callSite = parseCallSite(
            callExpr,
            targetMethod,
            sourceFile,
            serviceResolver,
            Boolean(inspection.isDynamicElementAccess),
          );
          allCallSites.push(callSite);

          if (callSite.refusal) {
            allRefusals.push(callSite.refusal);
          }

          if (callSite.flagKey === null) {
            unresolvedCallSites.push(callSite);
            if (callSite.serviceName) {
              if (!unresolvedCallSitesByService[callSite.serviceName]) {
                unresolvedCallSitesByService[callSite.serviceName] = [];
              }
              unresolvedCallSitesByService[callSite.serviceName].push(callSite);
              unresolvedServicesSet.add(callSite.serviceName);
            }
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
              flagRef.consumerServices.sort();
            }

            if (callSite.refusal) {
              flagRef.hasRefusals = true;
              flagRef.refusals.push(callSite.refusal);
            }
          }
        } catch (callErr) {
          // Fail-closed error boundary for individual call expressions
          const location = extractSourceLocation(callExpr, sourceFile);
          const refusal: RefusalMarker = {
            reason: "SCAN_ERROR",
            message: `AST scanning error on call expression: ${
              callErr instanceof Error ? callErr.message : String(callErr)
            }`,
            nodeText: callExpr.getText(),
            location,
          };
          allRefusals.push(refusal);
        }
      }
    } catch (fileErr) {
      // Fail-closed error boundary for entire source file
      const location: SourceLocation = {
        filePath: normalizeFilePath(sourceFile.getFilePath()),
        startLine: 1,
        startColumn: 1,
        endLine: 1,
        endColumn: 1,
      };
      const refusal: RefusalMarker = {
        reason: "SCAN_ERROR",
        message: `AST scanning error in file: ${
          fileErr instanceof Error ? fileErr.message : String(fileErr)
        }`,
        nodeText: sourceFile.getFilePath(),
        location,
      };
      allRefusals.push(refusal);
    }
  }

  return {
    totalFilesScanned: sourceFiles.length,
    totalCallSites: allCallSites.length,
    callSites: allCallSites,
    flagReferences,
    unresolvedCallSites,
    unresolvedCallSitesByService,
    unresolvedServices: Array.from(unresolvedServicesSet).sort(),
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
 * Invariant Violation Checks:
 * 1. Undeclared Caller: AST call sites found in a service with 0 telemetry evaluations -> `UNDECLARED_CONSUMER_SERVICE`.
 * 2. Unresolved Dynamic Evasion (C1): Candidate evaluating service contains dynamic/non-literal calls -> `NON_LITERAL_FLAG_KEY`.
 * 3. Unreferenced Service (I2): Telemetry service has no AST callers -> blocked if `allowUnreferencedServices: false`.
 */
export function crossReferenceConsumers(
  options: CrossReferenceOptions,
): ConsumerCrossReference[] {
  const { candidates, scanResult, allowUnreferencedServices = true } = options;
  const results: ConsumerCrossReference[] = [];

  for (const candidate of candidates) {
    const flagKey = candidate.flagKey;
    const evaluatingServices = candidate.evaluatingServices ?? [];
    const flagRef = scanResult.flagReferences[flagKey];

    const astConsumerServices = flagRef
      ? [...flagRef.consumerServices].sort()
      : [];
    const callSites = flagRef ? [...flagRef.callSites] : [];
    const refusals: RefusalMarker[] = flagRef ? [...flagRef.refusals] : [];

    // C1: Check if any service that evaluated this candidate flag contains unresolved dynamic calls
    for (const evaluatingService of evaluatingServices) {
      const unresolvedInService =
        scanResult.unresolvedCallSitesByService?.[evaluatingService];
      if (unresolvedInService && unresolvedInService.length > 0) {
        for (const unresolvedCall of unresolvedInService) {
          refusals.push({
            reason: "NON_LITERAL_FLAG_KEY",
            message: `Candidate flag '${flagKey}' has dynamic or non-literal evaluations in evaluating service '${evaluatingService}'; purger refuses dynamic resolution`,
            nodeText: unresolvedCall.fullCallText,
            location: unresolvedCall.location,
          });
        }
      }
    }

    // Find undeclared services: in AST but not in telemetry evaluatingServices
    const undeclaredServices = astConsumerServices
      .filter((svc) => !evaluatingServices.includes(svc))
      .sort();

    // Find unreferenced services: in telemetry evaluatingServices but no AST callers found
    const unreferencedServices = evaluatingServices
      .filter((svc) => !astConsumerServices.includes(svc))
      .sort();

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

    const unreferencedBlocker =
      !allowUnreferencedServices && unreferencedServices.length > 0;
    const isConsistent =
      undeclaredServices.length === 0 &&
      refusals.length === 0 &&
      !unreferencedBlocker;

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
