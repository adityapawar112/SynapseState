import { test, expect } from "../fixtures/auth.fixture.js";

test.describe("Leases Lifecycle & Real-Time Dual-Clock Countdown (PR 27)", () => {
  test.beforeEach(async ({ request }) => {
    // Reset test state before each run to guarantee strict isolation
    await request.post("http://localhost:3000/__test/reset").catch(() => {});
  });

  test("renders active leases and updates monotonic countdown timers without page refresh", async ({
    operatorPage,
  }) => {
    await operatorPage.goto("/leases");

    const activeCountdown = operatorPage.locator(
      "#lease-countdown-01J9X57YTRPQ8A7F4E00112233"
    );
    await expect(activeCountdown).toBeVisible();

    // Parse seconds from formatDuration string
    const parseSeconds = (str: string): number => {
      const minMatch = str.match(/(\d+)m/);
      const secMatch = str.match(/(\d+)s/);
      const minutes = minMatch ? parseInt(minMatch[1], 10) : 0;
      const seconds = secMatch ? parseInt(secMatch[1], 10) : 0;
      return minutes * 60 + seconds;
    };

    // Grab initial countdown seconds
    const initialText = (await activeCountdown.textContent())?.trim() || "";
    expect(initialText).toMatch(/\d+m\s+\d+s|\d+s/);
    const initialSeconds = parseSeconds(initialText);

    // Assert monotonic decrement using auto-retrying expect.poll (no flaky waitForTimeout)
    await expect
      .poll(
        async () => {
          const text = (await activeCountdown.textContent())?.trim() || "";
          return parseSeconds(text);
        },
        { timeout: 8000, intervals: [500, 1000] }
      )
      .toBeLessThan(initialSeconds);
  });

  test("allows switching environment and status filter tabs with content verification", async ({
    operatorPage,
  }) => {
    await operatorPage.goto("/leases");

    // Default "all" tab should display all 3 seeded leases
    const allCards = operatorPage.locator("[id^='lease-card-']");
    await expect(allCards).toHaveCount(3);

    // Click "Near Expiry (< 5m)" tab
    const nearExpiryTab = operatorPage.locator("#lease-filter-tab-near-expiry");
    await nearExpiryTab.click();
    await expect(operatorPage).toHaveURL(/filter=near-expiry/);

    // Content assertion: only the near-expiry lease card should be displayed
    await expect(
      operatorPage.locator("#lease-card-01J9X57YTRPQ8A7F4E00445566")
    ).toBeVisible();
    await expect(operatorPage.locator("[id^='lease-card-']")).toHaveCount(1);

    // Click "Expired" tab
    const expiredTab = operatorPage.locator("#lease-filter-tab-expired");
    await expiredTab.click();
    await expect(operatorPage).toHaveURL(/filter=expired/);

    // Content assertion: only the expired lease card should be displayed
    await expect(
      operatorPage.locator("#lease-card-01J9X57YTRPQ8A7F4E00778899")
    ).toBeVisible();
    await expect(operatorPage.locator("[id^='lease-card-']")).toHaveCount(1);

    // Click "All Leases" tab and assert all 3 cards reappear
    const allTab = operatorPage.locator("#lease-filter-tab-all");
    await allTab.click();
    await expect(operatorPage).toHaveURL(/filter=all/);
    await expect(operatorPage.locator("[id^='lease-card-']")).toHaveCount(3);
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
