import { describe, it, expect } from "vitest";
import {
  OverrideProvider,
  LeaseStore,
  KeysetWatcher,
  EmergencyScanner,
  DEFAULT_KEYSET_PATH,
  DEFAULT_KEYSET_POLL_INTERVAL_MS,
  DEFAULT_KEYSET_MAX_STALE_MS,
  DEFAULT_EMERGENCY_DIR,
  DEFAULT_EMERGENCY_POLL_INTERVAL_MS,
  LEASE_DOMAIN_PREFIX,
} from "./index.js";

describe("SDK Package Public API Surface", () => {
  it("exports core classes and default constants", () => {
    expect(typeof OverrideProvider).toBe("function");
    expect(typeof LeaseStore).toBe("function");
    expect(typeof KeysetWatcher).toBe("function");
    expect(typeof EmergencyScanner).toBe("function");

    expect(DEFAULT_KEYSET_PATH).toBe("/etc/synapse/keyset/keyset.json");
    expect(DEFAULT_KEYSET_POLL_INTERVAL_MS).toBe(10_000);
    expect(DEFAULT_KEYSET_MAX_STALE_MS).toBe(900_000);

    expect(DEFAULT_EMERGENCY_DIR).toBe("/etc/synapse/emergency-leases");
    expect(DEFAULT_EMERGENCY_POLL_INTERVAL_MS).toBe(10_000);

    expect(LEASE_DOMAIN_PREFIX).toBe("synapsestate/lease/v1\n");
  });
});
