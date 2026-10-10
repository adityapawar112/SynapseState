import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
import {
  signLease,
  signRevocation,
  signKeyRevocation,
  formatPublicKeyToBase64Url,
  type Keyset,
  type LeasePayload,
  type RevocationPayload,
  type KeyRevocationPayload,
} from "@synapsestate/lease";
import { LeaseStore } from "./lease-store.js";
import { StateClient } from "./state-client.js";

describe("StateClient (ETag Long-Polling & Fail-Static Resilience)", () => {
  const alicePair = crypto.generateKeyPairSync("ed25519");
  const bobPair = crypto.generateKeyPairSync("ed25519");
  const adminPair = crypto.generateKeyPairSync("ed25519");

  const alicePubB64 = formatPublicKeyToBase64Url(alicePair.publicKey);
  const bobPubB64 = formatPublicKeyToBase64Url(bobPair.publicKey);
  const adminPubB64 = formatPublicKeyToBase64Url(adminPair.publicKey);

  let trustedKeyset: Keyset;
  let store: LeaseStore;

  beforeEach(() => {
    vi.useFakeTimers();

    trustedKeyset = {
      "sre-alice": {
        public_key: alicePubB64,
        role: "operator",
        roles: ["lease_signer"],
        status: "active",
        max_ttl_seconds: 3600,
      },
      "sre-bob": {
        public_key: bobPubB64,
        role: "operator",
        roles: ["lease_signer"],
        status: "active",
        max_ttl_seconds: 3600,
      },
      "admin-carol": {
        public_key: adminPubB64,
        role: "admin",
        roles: ["lease_signer", "key_revoker"],
        status: "active",
        max_ttl_seconds: 86400,
      },
    };

    store = new LeaseStore({ keyset: trustedKeyset });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const createLease = (overrides?: Partial<LeasePayload>) => {
    const payload: LeasePayload = {
      v: 1,
      lease_id: "01J9X57YTRPQ8A7F4E12345678",
      env: "prod",
      flag_key: "checkout-v2",
      value: false,
      reason: "INC-123: Emergency override",
      issued_at: new Date().toISOString(),
      ttl_seconds: 1800,
      kid: "sre-alice",
      nonce: "YWJjZGVmZ2hpams",
      ...overrides,
    };
    return signLease(payload, alicePair.privateKey);
  };

  const createRevocation = (leaseId: string) => {
    const payload: RevocationPayload = {
      v: 1,
      lease_id: leaseId,
      revoked_at: new Date().toISOString(),
      reason: "Emergency rollout reverted",
      kid: "sre-alice",
    };
    return signRevocation(payload, alicePair.privateKey);
  };

  const createKeyRevocation = (compromisedKid: string) => {
    const payload: KeyRevocationPayload = {
      v: 1,
      kid: compromisedKid,
      revoked_at: new Date().toISOString(),
      reason: "Compromised key",
      revoked_by_kid: "admin-carol",
    };
    return signKeyRevocation(payload, adminPair.privateKey);
  };

  it("polls GET /v1/sdk/state with env and wait parameters, ingesting active leases on HTTP 200", async () => {
    const validLease = createLease();
    const serverTime = new Date().toISOString();

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({
        etag: '"etag-gen-42"',
      }),
      json: async () => ({
        server_time: serverTime,
        registry_version: 42,
        active_leases: [validLease],
        revocations: [],
        key_revocations: [],
      }),
    });

    const client = new StateClient({
      controlApiUrl: "https://control-api.synapse.internal",
      leaseStore: store,
      env: "prod",
      waitSeconds: 30,
      serviceToken: "service-token-xyz",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const result = await client.pollOnce();

    expect(result.status).toBe(200);
    expect(result.etag).toBe('"etag-gen-42"');
    expect(client.getCurrentEtag()).toBe('"etag-gen-42"');
    expect(client.getLastSyncTime()).toBeDefined();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://control-api.synapse.internal/v1/sdk/state?env=prod&wait=30s");
    expect(init.headers).toEqual({
      Accept: "application/json",
      Authorization: "Bearer service-token-xyz",
    });

    // Verify lease was ingested into LeaseStore
    const active = store.getActiveLease("checkout-v2");
    expect(active).toBeDefined();
    expect(active?.value).toBe(false);
  });

  it("handles HTTP 304 Not Modified by retaining existing state and sending If-None-Match", async () => {
    const initialLease = createLease();
    store.addLease(initialLease);

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 304,
      headers: new Headers({
        etag: '"etag-gen-42"',
      }),
    });

    const client = new StateClient({
      controlApiUrl: "https://control-api.synapse.internal",
      leaseStore: store,
      initialEtag: '"etag-gen-42"',
      fetch: fetchMock as unknown as typeof fetch,
    });

    const result = await client.pollOnce();

    expect(result.status).toBe(304);
    expect(result.etag).toBe('"etag-gen-42"');
    expect(client.getLastSyncTime()).toBeDefined();

    // Verify If-None-Match header was sent
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers["If-None-Match"]).toBe('"etag-gen-42"');

    // Lease in LeaseStore must be preserved
    expect(store.getActiveLease("checkout-v2")).toBeDefined();
  });

  it("enforces cryptographic ordering: applies key_revocations, then revocations, then active_leases", async () => {
    // A lease signed by sre-bob
    const bobPayload: LeasePayload = {
      v: 1,
      lease_id: "01J9X57YTRPQ8A7F4E99999999",
      env: "prod",
      flag_key: "bob-feature",
      value: "bob-override",
      reason: "Bob override",
      issued_at: new Date().toISOString(),
      ttl_seconds: 1800,
      kid: "sre-bob",
      nonce: "bm9uY2UtYm9iLTE",
    };
    const bobLease = signLease(bobPayload, bobPair.privateKey);

    // Key revocation revoking sre-bob
    const bobKeyRevocation = createKeyRevocation("sre-bob");

    // Revocation for checkout-v2
    const aliceLease = createLease({ lease_id: "01J9X57YTRPQ8A7F4E11111111", flag_key: "checkout-v2" });
    const aliceRevocation = createRevocation("01J9X57YTRPQ8A7F4E11111111");

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ etag: '"etag-ordered"' }),
      json: async () => ({
        server_time: new Date().toISOString(),
        registry_version: 10,
        active_leases: [bobLease, aliceLease],
        revocations: [aliceRevocation],
        key_revocations: [bobKeyRevocation],
      }),
    });

    const client = new StateClient({
      controlApiUrl: "https://control-api.synapse.internal",
      leaseStore: store,
      fetch: fetchMock as unknown as typeof fetch,
    });

    await client.pollOnce();

    // bob-feature should be rejected because sre-bob key was revoked
    expect(store.getActiveLease("bob-feature")).toBeUndefined();

    // checkout-v2 should be rejected because lease_id 01J9X57YTRPQ8A7F4E11111111 was revoked
    expect(store.getActiveLease("checkout-v2")).toBeUndefined();
  });

  it("Tamper-Proof Keyset Seam: rejects leases signed by unauthorized keys not in pinned keyset", async () => {
    const malloryPair = crypto.generateKeyPairSync("ed25519");
    const malloryPayload: LeasePayload = {
      v: 1,
      lease_id: "01J9X57YTRPQ8A7F4E66666666",
      env: "prod",
      flag_key: "rogue-override",
      value: "hacked",
      reason: "Mallory attack",
      issued_at: new Date().toISOString(),
      ttl_seconds: 1800,
      kid: "rogue-mallory",
      nonce: "bm9uY2UtbWFsbG9yeQ",
    };
    const rogueLease = signLease(malloryPayload, malloryPair.privateKey);

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ etag: '"etag-rogue"' }),
      json: async () => ({
        server_time: new Date().toISOString(),
        registry_version: 11,
        active_leases: [rogueLease],
        revocations: [],
        key_revocations: [],
      }),
    });

    const client = new StateClient({
      controlApiUrl: "https://control-api.synapse.internal",
      leaseStore: store,
      fetch: fetchMock as unknown as typeof fetch,
    });

    await client.pollOnce();

    // rogue-override must NEVER be stored
    expect(store.getActiveLease("rogue-override")).toBeUndefined();
  });

  it("Fail-Static Network Resilience: retains active leases and applies backoff when fetch fails or returns 5xx", async () => {
    const existingLease = createLease();
    store.addLease(existingLease);
    expect(store.getActiveLease("checkout-v2")).toBeDefined();

    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
      });

    const warnMock = vi.fn();
    const client = new StateClient({
      controlApiUrl: "https://control-api.synapse.internal",
      leaseStore: store,
      fetch: fetchMock as unknown as typeof fetch,
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: warnMock,
        error: vi.fn(),
      },
    });

    // Attempt 1: network rejection
    const res1 = await client.pollOnce();
    expect(res1.status).toBe("error");
    expect(store.getActiveLease("checkout-v2")).toBeDefined();
    expect(warnMock).toHaveBeenCalled();

    // Attempt 2: 503 server error
    const res2 = await client.pollOnce();
    expect(res2.status).toBe("error");
    expect(store.getActiveLease("checkout-v2")).toBeDefined();
  });

  it("validates response schema and rejects malformed payloads without crashing", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ etag: '"bad-payload"' }),
      json: async () => ({
        server_time: "invalid-date",
        // missing required fields: registry_version, active_leases, etc.
      }),
    });

    const warnMock = vi.fn();
    const client = new StateClient({
      controlApiUrl: "https://control-api.synapse.internal",
      leaseStore: store,
      fetch: fetchMock as unknown as typeof fetch,
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: warnMock,
        error: vi.fn(),
      },
    });

    const res = await client.pollOnce();
    expect(res.status).toBe("error");
    expect(warnMock).toHaveBeenCalled();
  });

  it("lifecycle: start() begins background long-polling loop and stop() aborts it cleanly", async () => {
    let callCount = 0;
    const fetchMock = vi.fn().mockImplementation(async (_url, init: RequestInit) => {
      callCount++;
      // Simulate long-poll wait
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          resolve({
            ok: true,
            status: 304,
            headers: new Headers({ etag: '"etag-loop"' }),
          });
        }, 500);

        init.signal?.addEventListener("abort", () => {
          clearTimeout(timeout);
          reject(new DOMException("The operation was aborted", "AbortError"));
        });
      });
    });

    const client = new StateClient({
      controlApiUrl: "https://control-api.synapse.internal",
      leaseStore: store,
      fetch: fetchMock as unknown as typeof fetch,
    });

    expect(client.isRunning()).toBe(false);
    await client.start();
    expect(client.isRunning()).toBe(true);

    // Advance fake timer to complete first long poll
    await vi.advanceTimersByTimeAsync(500);
    expect(callCount).toBeGreaterThanOrEqual(1);

    client.stop();
    expect(client.isRunning()).toBe(false);
  });
});
