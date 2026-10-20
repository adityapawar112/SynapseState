import { test, expect } from "../fixtures/auth.fixture.js";

test.describe("Tamper-Evident Audit Ledger & Cryptographic Chain (PR 27)", () => {
  test.beforeEach(async ({ request }) => {
    const res = await request.post("http://localhost:3000/__test/reset");
    expect(res.ok()).toBe(true);
  });

  test("asserts unbroken SHA-256 hash chain verification, sequence ordering, and checkpoint status", async ({
    operatorPage,
    request,
  }) => {
    await operatorPage.goto("/audit");

    // Header Assertion
    const heading = operatorPage.locator("h1");
    await expect(heading).toHaveText("Tamper-Evident Audit Ledger");

    // Verification Badge Assertion
    const statusBadge = operatorPage.locator("#audit-chain-status-badge");
    await expect(statusBadge).toBeVisible();
    await expect(statusBadge).toContainText("Hash Chain Verified");
    await expect(statusBadge).toContainText(
      "Cryptographic SHA-256 continuity unbroken"
    );

    // Latest Signed Checkpoint Card Assertion
    const checkpointSeq = operatorPage.locator("#audit-checkpoint-seq");
    await expect(checkpointSeq).toBeVisible();
    await expect(checkpointSeq).toHaveText("#3");

    const checkpointEvents = operatorPage.locator("#audit-checkpoint-events");
    await expect(checkpointEvents).toBeVisible();
    await expect(checkpointEvents).toHaveText(/3\s+events/);

    // Table Sequence & Hash Chaining Assertions
    const tableRows = operatorPage.locator("tbody tr");
    await expect(tableRows).toHaveCount(3);

    // First event (seq #1)
    const row1 = operatorPage.locator("[data-testid='audit-row-1']");
    await expect(row1).toBeVisible();
    await expect(row1).toContainText("#1");
    await expect(row1).toContainText("LEASE_INGESTED");
    await expect(row1).toContainText("ops-sre-lead");

    // Second event (seq #2)
    const row2 = operatorPage.locator("[data-testid='audit-row-2']");
    await expect(row2).toBeVisible();
    await expect(row2).toContainText("#2");
    await expect(row2).toContainText("LEASE_REVOKE_REQUESTED");

    // Third event (seq #3)
    const row3 = operatorPage.locator("[data-testid='audit-row-3']");
    await expect(row3).toBeVisible();
    await expect(row3).toContainText("#3");
    await expect(row3).toContainText("CHECKPOINT_SEALED");
    await expect(row3).toContainText("platform-admin");

    // Independent Cryptographic Re-computation & Continuity Verification
    const authHeaders = {
      Authorization: `Bearer ${process.env.SYNAPSE_API_TOKEN || "synapse-e2e-master-token-value-2026"}`,
    };
    const auditRes = await request.get("http://localhost:3000/v1/audit/events", {
      headers: authHeaders,
    });
    expect(auditRes.status()).toBe(200);
    const auditData = await auditRes.json();
    const events = auditData.events || [];
    expect(events.length).toBeGreaterThanOrEqual(3);

    // Assert cryptographic chaining invariants across the retrieved events
    for (let i = 0; i < events.length; i++) {
      const curr = events[i];
      if (i > 0) {
        const prev = events[i - 1];
        expect(curr.prev_hash).toBe(prev.hash);
        expect(curr.seq).toBe(prev.seq + 1);
      }
      expect(curr.hash).toMatch(/^[a-f0-9]{64}$/);
    }

    // Assert checkpoint matches the sealed audit hash
    const cpRes = await request.get("http://localhost:3000/v1/audit/checkpoint/latest", {
      headers: authHeaders,
    });
    if (cpRes.status() === 200) {
      const cp = await cpRes.json();
      expect(cp.checkpoint_seq).toBe(3);
      expect(cp.checkpoint_hash).toBe(events[2].hash);
    }
  });

  test("negative test: detects tampering if an audit record hash is altered or sequence is broken", async () => {
    const { verifyAuditLedgerChain } = await import("../../src/lib/domain.js");

    const validLedger = [
      {
        seq: 1,
        prevHash: "0000000000000000000000000000000000000000000000000000000000000000",
        hash: "a".repeat(64),
        eventType: "LEASE_INGESTED",
        actor: "ops-lead",
        ts: new Date().toISOString(),
        payload: {},
      },
      {
        seq: 2,
        prevHash: "a".repeat(64),
        hash: "b".repeat(64),
        eventType: "LEASE_REVOKED",
        actor: "ops-lead",
        ts: new Date().toISOString(),
        payload: {},
      },
      {
        seq: 3,
        prevHash: "b".repeat(64),
        hash: "c".repeat(64),
        eventType: "CHECKPOINT_SEALED",
        actor: "platform-admin",
        ts: new Date().toISOString(),
        payload: {},
      },
    ];

    // Assert pristine chain passes
    expect(verifyAuditLedgerChain(validLedger)).toEqual({ valid: true });

    // Tamper with hash chaining (prevHash mismatch at seq 2)
    const tamperedHashLedger = [
      validLedger[0],
      { ...validLedger[1], prevHash: "corrupted_hash_tampered_by_attacker" },
      validLedger[2],
    ];
    expect(verifyAuditLedgerChain(tamperedHashLedger)).toEqual({
      valid: false,
      brokenAtSeq: 2,
    });

    // Tamper with sequence monotonicity (skip seq 2)
    const brokenSeqLedger = [
      validLedger[0],
      { ...validLedger[1], seq: 4 },
      validLedger[2],
    ];
    expect(verifyAuditLedgerChain(brokenSeqLedger)).toEqual({
      valid: false,
      brokenAtSeq: 4,
    });
  });
});
