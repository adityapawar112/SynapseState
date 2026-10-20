import { test, expect } from "../fixtures/auth.fixture.js";

test.describe("Tamper-Evident Audit Ledger & Cryptographic Chain (PR 27)", () => {
  test.beforeEach(async ({ request }) => {
    await request.post("http://localhost:3000/__test/reset").catch(() => {});
  });

  test("asserts unbroken SHA-256 hash chain verification, sequence ordering, and checkpoint status", async ({
    operatorPage,
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
  });
});
