import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import {
  signLease,
  formatPublicKeyToBase64Url,
  type Keyset,
  type LeasePayload,
  type KeyRevocationPayload,
} from "@synapsestate/lease";
import { LeaseStore } from "./lease-store.js";
import { EmergencyScanner } from "./emergency-scanner.js";

describe("EmergencyScanner", () => {
  let tmpDir: string;
  let emergencyDir: string;
  let scanner: EmergencyScanner | undefined;
  let leaseStore: LeaseStore;

  const alicePair = crypto.generateKeyPairSync("ed25519");
  const alicePubB64 = formatPublicKeyToBase64Url(alicePair.publicKey);

  const bobPair = crypto.generateKeyPairSync("ed25519");
  const bobPubB64 = formatPublicKeyToBase64Url(bobPair.publicKey);

  const trustedKeyset: Keyset = {
    "sre-alice": {
      public_key: alicePubB64,
      role: "operator",
      roles: ["lease_signer"],
      status: "active",
      max_ttl_seconds: 3600,
    },
    "revoker-bob": {
      public_key: bobPubB64,
      role: undefined,
      roles: ["key_revoker"], // Unauthorized to sign leases (requires lease_signer)
      status: "active",
      max_ttl_seconds: 3600,
    },
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-emergency-test-"));
    emergencyDir = path.join(tmpDir, "emergency-leases");
    fs.mkdirSync(emergencyDir, { recursive: true });

    leaseStore = new LeaseStore({ keyset: trustedKeyset });
  });

  afterEach(() => {
    if (scanner) {
      scanner.stop();
      scanner = undefined;
    }
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  const createSignedLeaseFile = (
    fileName: string,
    overrides?: Partial<LeasePayload>,
    privateKey = alicePair.privateKey,
  ) => {
    const payload: LeasePayload = {
      v: 1,
      lease_id: "01J9X57YTRPQ8A7F4E12345678",
      env: "prod",
      flag_key: "killswitch-checkout",
      value: true,
      reason: "Emergency circuit break",
      issued_at: new Date().toISOString(),
      ttl_seconds: 600,
      kid: "sre-alice",
      nonce: "nonce456",
      ...overrides,
    };
    const envelope = signLease(payload, privateKey);
    const filePath = path.join(emergencyDir, fileName);
    fs.writeFileSync(filePath, JSON.stringify(envelope, null, 2), "utf8");
    return envelope;
  };

  it("scans directory and ingests valid signed emergency leases into LeaseStore", async () => {
    createSignedLeaseFile("lease-01.json", {
      flag_key: "payment-v2",
      value: "emergency-on",
      lease_id: "01J9X57YTRPQ8A7F4E12345671",
    });

    createSignedLeaseFile("lease-02.json", {
      flag_key: "auth-rate-limit",
      value: false,
      lease_id: "01J9X57YTRPQ8A7F4E12345672",
    });

    scanner = new EmergencyScanner({
      emergencyDir,
      leaseStore,
      pollIntervalMs: 50,
    });

    const ingested = await scanner.scanOnce();
    expect(ingested).toBe(2);

    expect(leaseStore.getActiveLease("payment-v2")?.value).toBe("emergency-on");
    expect(leaseStore.getActiveLease("auth-rate-limit")?.value).toBe(false);
  });

  it("rejects files with invalid signatures or tampered content without crashing", async () => {
    // Write tampered file
    const envelope = signLease(
      {
        v: 1,
        lease_id: "01J9X57YTRPQ8A7F4E12345673",
        env: "prod",
        flag_key: "tampered-flag",
        value: true,
        reason: "Test",
        issued_at: new Date().toISOString(),
        ttl_seconds: 300,
        kid: "sre-alice",
        nonce: "tamper123",
      },
      alicePair.privateKey,
    );

    // Tamper with payload after signing
    (envelope.payload as { value: unknown }).value = false;
    fs.writeFileSync(
      path.join(emergencyDir, "tampered.json"),
      JSON.stringify(envelope, null, 2),
      "utf8",
    );

    scanner = new EmergencyScanner({
      emergencyDir,
      leaseStore,
    });

    const ingested = await scanner.scanOnce();
    expect(ingested).toBe(0);
    expect(leaseStore.getActiveLease("tampered-flag")).toBeUndefined();
  });

  it("rejects files signed by unauthorized key or key missing lease_signer role", async () => {
    // Signed by bob, who only has viewer role
    createSignedLeaseFile(
      "unauthorized-role.json",
      {
        flag_key: "unauth-flag",
        kid: "revoker-bob",
        lease_id: "01J9X57YTRPQ8A7F4E12345674",
      },
      bobPair.privateKey,
    );

    scanner = new EmergencyScanner({
      emergencyDir,
      leaseStore,
    });

    const ingested = await scanner.scanOnce();
    expect(ingested).toBe(0);
    expect(leaseStore.getActiveLease("unauth-flag")).toBeUndefined();
  });

  it("denies leases whose kid has been revoked via active key revocations", async () => {
    createSignedLeaseFile("alice-lease.json", {
      flag_key: "revoked-signer-flag",
      kid: "sre-alice",
      lease_id: "01J9X57YTRPQ8A7F4E12345675",
    });

    const activeKeyRevocations: KeyRevocationPayload[] = [
      {
        v: 1,
        kid: "sre-alice",
        revoked_at: new Date().toISOString(),
        revoked_by_kid: "admin-lead",
        reason: "Key compromised",
      },
    ];

    scanner = new EmergencyScanner({
      emergencyDir,
      leaseStore,
      getKeyRevocations: () => activeKeyRevocations,
    });

    const ingested = await scanner.scanOnce();
    expect(ingested).toBe(0);
    expect(leaseStore.getActiveLease("revoked-signer-flag")).toBeUndefined();
  });

  it("ignores corrupted JSON and non-json files gracefully", async () => {
    fs.writeFileSync(
      path.join(emergencyDir, "broken.json"),
      "invalid json {[[",
      "utf8",
    );
    fs.writeFileSync(
      path.join(emergencyDir, "notes.txt"),
      "some random text",
      "utf8",
    );

    scanner = new EmergencyScanner({
      emergencyDir,
      leaseStore,
    });

    const ingested = await scanner.scanOnce();
    expect(ingested).toBe(0);
  });

  it("handles missing emergency directory on startup without crashing", async () => {
    const nonExistentDir = path.join(tmpDir, "does-not-exist");
    scanner = new EmergencyScanner({
      emergencyDir: nonExistentDir,
      leaseStore,
    });

    const ingested = await scanner.scanOnce();
    expect(ingested).toBe(0);
  });

  it("starts periodic scanning and cleanly stops on stop()", async () => {
    scanner = new EmergencyScanner({
      emergencyDir,
      leaseStore,
      pollIntervalMs: 50,
    });

    await scanner.start();
    expect(scanner.isRunning()).toBe(true);

    scanner.stop();
    expect(scanner.isRunning()).toBe(false);
  });
});
