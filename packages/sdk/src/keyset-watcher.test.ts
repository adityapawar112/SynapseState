import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { formatPublicKeyToBase64Url, type Keyset } from "@synapsestate/lease";
import { KeysetWatcher } from "./keyset-watcher.js";

describe("KeysetWatcher", () => {
  let tmpDir: string;
  let keysetPath: string;
  let watcher: KeysetWatcher | undefined;

  const alicePair = crypto.generateKeyPairSync("ed25519");
  const alicePubB64 = formatPublicKeyToBase64Url(alicePair.publicKey);

  const bobPair = crypto.generateKeyPairSync("ed25519");
  const bobPubB64 = formatPublicKeyToBase64Url(bobPair.publicKey);

  const sampleKeyset = {
    "sre-alice": {
      public_key: alicePubB64,
      roles: ["lease_signer"],
      status: "active",
      max_ttl_seconds: 3600,
    },
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-keyset-test-"));
    keysetPath = path.join(tmpDir, "keyset.json");
    fs.writeFileSync(keysetPath, JSON.stringify(sampleKeyset, null, 2), "utf8");
  });

  afterEach(() => {
    if (watcher) {
      watcher.stop();
      watcher = undefined;
    }
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("loads keyset on startup via SHA-256 file-hash polling", async () => {
    let updateCount = 0;
    watcher = new KeysetWatcher({
      keysetPath,
      pollIntervalMs: 50,
      onKeysetUpdate: () => {
        updateCount++;
      },
    });

    await watcher.start();

    expect(watcher.isRunning()).toBe(true);
    expect(watcher.getStatus().state).toBe("ready");
    expect(watcher.getKeyset()["sre-alice"]).toBeDefined();
    expect(updateCount).toBe(1);
  });

  it("detects keyset modifications via file hash and triggers onKeysetUpdate", async () => {
    const updates: Array<Record<string, unknown>> = [];
    watcher = new KeysetWatcher({
      keysetPath,
      pollIntervalMs: 50,
      onKeysetUpdate: (k: Keyset) => {
        updates.push({ ...k });
      },
    });

    await watcher.start();
    expect(updates.length).toBe(1);

    // Modify file with new key (bob)
    const updatedKeyset = {
      ...sampleKeyset,
      "sre-bob": {
        public_key: bobPubB64,
        roles: ["lease_signer"],
        status: "active",
        max_ttl_seconds: 3600,
      },
    };
    fs.writeFileSync(
      keysetPath,
      JSON.stringify(updatedKeyset, null, 2),
      "utf8",
    );

    // Manually trigger poll or wait for interval
    await watcher.pollOnce();

    expect(updates.length).toBe(2);
    expect(watcher.getKeyset()["sre-bob"]).toBeDefined();

    // Polling with unchanged file must NOT trigger update
    await watcher.pollOnce();
    expect(updates.length).toBe(2);
  });

  it("treats authoritative empty keyset {} as revoke-all command", async () => {
    let latestKeyset: Record<string, unknown> = {};
    watcher = new KeysetWatcher({
      keysetPath,
      pollIntervalMs: 50,
      onKeysetUpdate: (k: Keyset) => {
        latestKeyset = { ...k };
      },
    });

    await watcher.start();
    expect(Object.keys(latestKeyset).length).toBe(1);

    // Write authoritative empty JSON {}
    fs.writeFileSync(keysetPath, "{}", "utf8");
    await watcher.pollOnce();

    expect(Object.keys(latestKeyset).length).toBe(0);
    expect(watcher.getStatus().state).toBe("ready");
  });

  it("retains cached keyset during transient read failures within staleness ceiling", async () => {
    watcher = new KeysetWatcher({
      keysetPath,
      pollIntervalMs: 50,
      maxStaleMs: 500, // 500ms max stale for test
    });

    await watcher.start();
    expect(watcher.getStatus().state).toBe("ready");
    expect(watcher.getKeyset()["sre-alice"]).toBeDefined();

    // Remove file to simulate Kubernetes symlink swap turbulence / ENOENT
    fs.unlinkSync(keysetPath);
    await watcher.pollOnce();

    // Within maxStaleMs: must retain cached keyset and report state "stale"
    expect(watcher.getStatus().state).toBe("stale");
    expect(watcher.getKeyset()["sre-alice"]).toBeDefined();

    // Wait past maxStaleMs: must fail-static and purge keyset
    await new Promise((resolve) => setTimeout(resolve, 600));
    await watcher.pollOnce();

    expect(watcher.getStatus().state).toBe("unreadable");
    expect(Object.keys(watcher.getKeyset()).length).toBe(0);
  });

  it("handles cold-start with missing keyset gracefully without crashing", async () => {
    const nonExistentPath = path.join(tmpDir, "missing-keyset.json");
    watcher = new KeysetWatcher({
      keysetPath: nonExistentPath,
      pollIntervalMs: 50,
    });

    await watcher.start();

    expect(watcher.getStatus().state).toBe("unreadable");
    expect(Object.keys(watcher.getKeyset()).length).toBe(0);
  });

  it("retains last valid keyset on malformed JSON write", async () => {
    watcher = new KeysetWatcher({
      keysetPath,
      pollIntervalMs: 50,
    });

    await watcher.start();
    expect(watcher.getKeyset()["sre-alice"]).toBeDefined();

    // Corrupt file with syntax error
    fs.writeFileSync(keysetPath, "{ invalid-json: ", "utf8");
    await watcher.pollOnce();

    // Must not crash, retains last valid keyset
    expect(watcher.getKeyset()["sre-alice"]).toBeDefined();
    expect(watcher.getStatus().state).toBe("stale");
  });

  it("stops polling cleanly on stop()", async () => {
    watcher = new KeysetWatcher({
      keysetPath,
      pollIntervalMs: 50,
    });

    await watcher.start();
    expect(watcher.isRunning()).toBe(true);

    watcher.stop();
    expect(watcher.isRunning()).toBe(false);
  });
});
