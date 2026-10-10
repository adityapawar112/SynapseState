import type {
  Provider,
  ProviderMetadata,
  EvaluationContext,
  Logger,
  ResolutionDetails,
  JsonValue,
  Hook,
  ServerProviderStatus,
} from "@openfeature/server-sdk";
import { LeaseStore } from "./lease-store.js";
import type {
  OverrideProviderOptions,
  ActiveLease,
  LeaseStoreMetrics,
} from "./types.js";
import { KeysetWatcher } from "./keyset-watcher.js";
import { EmergencyScanner } from "./emergency-scanner.js";

/**
 * OpenFeature OverrideProvider wrapper implementing Invariant 1 (Fail-Safe Hot Path)
 * and Invariant 5 (Zero-Context Privacy).
 *
 * Sits atop any delegate OpenFeature provider (such as flagd, InMemoryProvider, or Unleash).
 * Inspects the in-process LeaseStore for active, unexpired emergency override leases.
 * If an active lease matches the flag key and requested type, returns an OVERRIDE resolution.
 * Otherwise, immediately falls through to the underlying delegate provider.
 */
export class OverrideProvider implements Provider {
  readonly metadata: ProviderMetadata = {
    name: "SynapseStateOverrideProvider",
  };
  readonly runsOn = "server" as const;

  private readonly delegate: Provider;
  private readonly leaseStore: LeaseStore;
  private readonly keysetWatcher?: KeysetWatcher;
  private readonly emergencyScanner?: EmergencyScanner;
  private readonly logger?: Logger;

  private internalErrorsCount = 0;

  constructor(
    delegateOrOptions: Provider | OverrideProviderOptions,
    maybeOptions?: Partial<OverrideProviderOptions>,
  ) {
    let opts: OverrideProviderOptions;

    if ("resolveBooleanEvaluation" in delegateOrOptions) {
      opts = {
        delegate: delegateOrOptions,
        ...maybeOptions,
      };
    } else {
      opts = delegateOrOptions;
    }

    this.delegate = opts.delegate;
    this.logger = opts.logger;

    // Use passed leaseStore or construct a new in-memory LeaseStore
    if (opts.leaseStore && opts.leaseStore instanceof LeaseStore) {
      this.leaseStore = opts.leaseStore;
    } else {
      this.leaseStore = new LeaseStore({
        skewToleranceMs: opts.skewToleranceMs,
        maxTtlSeconds: opts.maxTtlSeconds,
      });
    }

    // Initialize KeysetWatcher if enabled
    if (opts.enableKeysetWatcher !== false) {
      this.keysetWatcher = new KeysetWatcher({
        keysetPath: opts.keysetPath,
        pollIntervalMs: opts.keysetPollIntervalMs,
        maxStaleMs: opts.keysetCacheMaxStaleMs,
        onKeysetUpdate: (newKeyset) => {
          this.leaseStore.handleKeysetUpdate(newKeyset);
        },
        logger: this.logger,
      });
    }

    // Initialize EmergencyScanner if enabled
    if (opts.enableEmergencyScanner !== false) {
      this.emergencyScanner = new EmergencyScanner({
        emergencyDir: opts.emergencyDir,
        pollIntervalMs: opts.emergencyPollIntervalMs,
        leaseStore: this.leaseStore,
        logger: this.logger,
      });
    }
  }

  get hooks(): Hook[] | undefined {
    try {
      return this.delegate.hooks;
    } catch {
      return undefined;
    }
  }

  get events(): Provider["events"] {
    try {
      return this.delegate.events;
    } catch {
      return undefined;
    }
  }

  get status(): ServerProviderStatus | undefined {
    try {
      return this.delegate.status;
    } catch {
      return undefined;
    }
  }

  /**
   * Returns internal LeaseStore instance.
   */
  getLeaseStore(): LeaseStore {
    return this.leaseStore;
  }

  /**
   * Returns KeysetWatcher instance if enabled.
   */
  getKeysetWatcher(): KeysetWatcher | undefined {
    return this.keysetWatcher;
  }

  /**
   * Returns EmergencyScanner instance if enabled.
   */
  getEmergencyScanner(): EmergencyScanner | undefined {
    return this.emergencyScanner;
  }

  /**
   * Returns operational metrics including internal errors count.
   */
  getMetrics(): LeaseStoreMetrics {
    const storeMetrics = this.leaseStore.getMetrics();
    return {
      ...storeMetrics,
      internalErrorsCount:
        storeMetrics.internalErrorsCount + this.internalErrorsCount,
    };
  }

  /**
   * Lifecycle initialize: invokes delegate initialization and starts background watchers if enabled.
   *
   * NOTE: This method must be called (e.g. via OpenFeature.setProviderAndWait) to start the
   * KeysetWatcher and EmergencyScanner and seed the initial trusted keyset from disk into LeaseStore.
   * Re-throws delegate initialization failures so OpenFeature is aware of setup failures.
   */
  async initialize(context?: EvaluationContext): Promise<void> {
    try {
      if (this.delegate.initialize) {
        await this.delegate.initialize(context);
      }
      if (this.keysetWatcher) {
        await this.keysetWatcher.start();
      }
      if (this.emergencyScanner) {
        await this.emergencyScanner.start();
      }
    } catch (err) {
      this.internalErrorsCount++;
      this.logger?.warn?.(
        `[SynapseState] OverrideProvider failed during initialize: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
  }

  /**
   * Lifecycle onClose: stops background watchers and invokes delegate shutdown.
   */
  async onClose(): Promise<void> {
    try {
      if (this.emergencyScanner) {
        this.emergencyScanner.stop();
      }
      if (this.keysetWatcher) {
        this.keysetWatcher.stop();
      }
      if (this.delegate.onClose) {
        await this.delegate.onClose();
      }
    } catch (err) {
      this.internalErrorsCount++;
      this.logger?.warn?.(
        `[SynapseState] OverrideProvider failed during onClose: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async resolveBooleanEvaluation(
    flagKey: string,
    defaultValue: boolean,
    context: EvaluationContext,
    logger: Logger,
  ): Promise<ResolutionDetails<boolean>> {
    try {
      const activeLease = this.leaseStore.getActiveLease(flagKey);
      if (activeLease && typeof activeLease.value === "boolean") {
        return this.buildOverrideDetails(activeLease, activeLease.value);
      }
    } catch (err) {
      this.handleHotPathError(flagKey, err, logger);
    }

    return this.delegate.resolveBooleanEvaluation(
      flagKey,
      defaultValue,
      context,
      logger,
    );
  }

  async resolveStringEvaluation(
    flagKey: string,
    defaultValue: string,
    context: EvaluationContext,
    logger: Logger,
  ): Promise<ResolutionDetails<string>> {
    try {
      const activeLease = this.leaseStore.getActiveLease(flagKey);
      if (activeLease && typeof activeLease.value === "string") {
        return this.buildOverrideDetails(activeLease, activeLease.value);
      }
    } catch (err) {
      this.handleHotPathError(flagKey, err, logger);
    }

    return this.delegate.resolveStringEvaluation(
      flagKey,
      defaultValue,
      context,
      logger,
    );
  }

  async resolveNumberEvaluation(
    flagKey: string,
    defaultValue: number,
    context: EvaluationContext,
    logger: Logger,
  ): Promise<ResolutionDetails<number>> {
    try {
      const activeLease = this.leaseStore.getActiveLease(flagKey);
      if (
        activeLease &&
        typeof activeLease.value === "number" &&
        Number.isFinite(activeLease.value)
      ) {
        return this.buildOverrideDetails(activeLease, activeLease.value);
      }
    } catch (err) {
      this.handleHotPathError(flagKey, err, logger);
    }

    return this.delegate.resolveNumberEvaluation(
      flagKey,
      defaultValue,
      context,
      logger,
    );
  }

  async resolveObjectEvaluation<T extends JsonValue>(
    flagKey: string,
    defaultValue: T,
    context: EvaluationContext,
    logger: Logger,
  ): Promise<ResolutionDetails<T>> {
    try {
      const activeLease = this.leaseStore.getActiveLease(flagKey);
      if (
        activeLease &&
        typeof activeLease.value === "object" &&
        activeLease.value !== null
      ) {
        return this.buildOverrideDetails(
          activeLease,
          activeLease.value as unknown as T,
        );
      }
    } catch (err) {
      this.handleHotPathError(flagKey, err, logger);
    }

    return this.delegate.resolveObjectEvaluation(
      flagKey,
      defaultValue,
      context,
      logger,
    );
  }

  /**
   * Helper to format an OpenFeature ResolutionDetails object for an active emergency override.
   */
  private buildOverrideDetails<T>(
    lease: ActiveLease,
    typedValue: T,
  ): ResolutionDetails<T> {
    const variantStr =
      typeof lease.value === "object" && lease.value !== null
        ? JSON.stringify(lease.value)
        : String(lease.value);

    return {
      value: typedValue,
      variant: variantStr,
      reason: "OVERRIDE",
      flagMetadata: {
        "synapse.override": true,
        "synapse.lease_id": lease.leaseId,
        "synapse.issued_by": lease.kid,
        "synapse.effective_expiry": lease.effectiveExpiry.toISOString(),
      },
    };
  }

  /**
   * Invariant 1: Shield application traffic from internal exceptions.
   * Invariant 5: Zero-Context Privacy — never log context or targeting attributes.
   */
  private handleHotPathError(
    flagKey: string,
    err: unknown,
    logger?: Logger,
  ): void {
    this.internalErrorsCount++;
    const errMsg = err instanceof Error ? err.message : String(err);
    const logTarget = logger ?? this.logger;
    logTarget?.warn?.(
      `[SynapseState] Internal exception during override evaluation for flag "${flagKey}", falling back to delegate: ${errMsg}`,
    );
  }
}
