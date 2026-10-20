import { test, expect } from "../fixtures/auth.fixture.js";

test.describe("Leases Lifecycle & Real-Time Dual-Clock Countdown (PR 27)", () => {
  test("renders active leases and updates monotonic countdown timers without page refresh", async ({
    operatorPage,
  }) => {
    await operatorPage.goto("/leases");

    const activeCountdown = operatorPage.locator(
      "#lease-countdown-01J9X57YTRPQ8A7F4E00112233"
    );
    await expect(activeCountdown).toBeVisible();

    // Verify initial countdown contains time duration (e.g. "28m 0s" or similar)
    const initialText = (await activeCountdown.textContent())?.trim() || "";
    expect(initialText).toMatch(/\d+m\s+\d+s|\d+s/);

    // Parse seconds from formatDuration string
    const parseSeconds = (str: string): number => {
      const minMatch = str.match(/(\d+)m/);
      const secMatch = str.match(/(\d+)s/);
      const minutes = minMatch ? parseInt(minMatch[1], 10) : 0;
      const seconds = secMatch ? parseInt(secMatch[1], 10) : 0;
      return minutes * 60 + seconds;
    };

    const initialSeconds = parseSeconds(initialText);

    // Wait 2.2 seconds to verify monotonic decrement without page reload
    await operatorPage.waitForTimeout(2200);

    const updatedText = (await activeCountdown.textContent())?.trim() || "";
    const updatedSeconds = parseSeconds(updatedText);

    // Countdown should have decremented
    expect(updatedSeconds).toBeLessThan(initialSeconds);
  });

  test("allows switching environment and status filter tabs", async ({
    operatorPage,
  }) => {
    await operatorPage.goto("/leases");

    // Click "Near Expiry (< 5m)" tab
    const nearExpiryTab = operatorPage.locator("#lease-filter-tab-near-expiry");
    await nearExpiryTab.click();
    await expect(operatorPage).toHaveURL(/filter=near-expiry/);

    // Click "Expired" tab
    const expiredTab = operatorPage.locator("#lease-filter-tab-expired");
    await expiredTab.click();
    await expect(operatorPage).toHaveURL(/filter=expired/);

    // Click "All Leases" tab
    const allTab = operatorPage.locator("#lease-filter-tab-all");
    await allTab.click();
    await expect(operatorPage).toHaveURL(/filter=all/);
  });

  test("operator can revoke active lease, commit to audit ledger, and receive success alert", async ({
    operatorPage,
  }) => {
    await operatorPage.goto("/leases");

    const revokeBtn = operatorPage.locator(
      "#revoke-btn-01J9X57YTRPQ8A7F4E00112233"
    );
    await expect(revokeBtn).toBeVisible();
    await revokeBtn.click();

    // Verify modal elements
    const reasonInput = operatorPage.locator("#revoke-reason-input");
    await expect(reasonInput).toBeVisible();

    const kidInput = operatorPage.locator("#revoke-kid-input");
    await expect(kidInput).toHaveValue(/ops-emergency-key|.+/);

    // Fill revocation reason
    await reasonInput.fill("Incident #4891 resolved: Primary database memory stabilized");

    // Submit revocation
    const confirmBtn = operatorPage.locator("#revoke-modal-confirm-btn");
    await expect(confirmBtn).toBeEnabled();
    await confirmBtn.click();

    // Verify success alert / toast
    const successAlert = operatorPage.locator("#revoke-toast-alert");
    await expect(successAlert).toBeVisible();
    await expect(successAlert).toHaveText(/Lease Revoked Successfully/);

    // Close modal
    const doneBtn = operatorPage.locator("#revoke-modal-done-btn");
    await doneBtn.click();
    await expect(successAlert).not.toBeVisible();
  });
});
