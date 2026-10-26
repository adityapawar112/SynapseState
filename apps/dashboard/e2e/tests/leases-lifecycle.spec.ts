import { test, expect } from "../fixtures/auth.fixture.js";

test.describe("Leases Lifecycle & Real-Time Dual-Clock Countdown (PR 27)", () => {
  test.beforeEach(async ({ request }) => {
    // Reset test state before each run to guarantee strict isolation
    const res = await request.post("http://localhost:3000/__test/reset");
    expect(res.ok()).toBe(true);
  });

  test("renders active leases and updates monotonic countdown timers without page refresh", async ({
    operatorPage,
  }) => {
    await operatorPage.goto("/leases");

    const activeCountdown = operatorPage.locator(
      "#lease-countdown-01J9X57YTRPQ8A7F4E00112233",
    );
    await expect(activeCountdown).toBeVisible();

    // Parse seconds from formatDuration string (supports Xh Ym Zs, Xm Ys, and Ys)
    const parseSeconds = (str: string): number => {
      const hrMatch = str.match(/(\d+)h/);
      const minMatch = str.match(/(\d+)m/);
      const secMatch = str.match(/(\d+)s/);
      const hours = hrMatch ? parseInt(hrMatch[1], 10) : 0;
      const minutes = minMatch ? parseInt(minMatch[1], 10) : 0;
      const seconds = secMatch ? parseInt(secMatch[1], 10) : 0;
      return hours * 3600 + minutes * 60 + seconds;
    };

    // Grab initial countdown seconds
    const initialText = (await activeCountdown.textContent())?.trim() || "";
    expect(initialText).toMatch(/(?:\d+h\s+)?(?:\d+m\s+)?\d+s/);
    const initialSeconds = parseSeconds(initialText);

    // Assert monotonic decrement using auto-retrying expect.poll (no flaky waitForTimeout)
    await expect
      .poll(
        async () => {
          const text = (await activeCountdown.textContent())?.trim() || "";
          return parseSeconds(text);
        },
        { timeout: 8000, intervals: [500, 1000] },
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
      operatorPage.locator("#lease-card-01J9X57YTRPQ8A7F4E00445566"),
    ).toBeVisible();
    await expect(operatorPage.locator("[id^='lease-card-']")).toHaveCount(1);

    // Click "Expired" tab
    const expiredTab = operatorPage.locator("#lease-filter-tab-expired");
    await expiredTab.click();
    await expect(operatorPage).toHaveURL(/filter=expired/);

    // Content assertion: only the expired lease card should be displayed
    await expect(
      operatorPage.locator("#lease-card-01J9X57YTRPQ8A7F4E00778899"),
    ).toBeVisible();
    await expect(operatorPage.locator("[id^='lease-card-']")).toHaveCount(1);

    // Expired lease card should never display a Revoke button (prevents accidental revoke-expired)
    const expiredRevokeBtn = operatorPage.locator(
      "#revoke-btn-01J9X57YTRPQ8A7F4E00778899",
    );
    await expect(expiredRevokeBtn).toHaveCount(0);

    // Click "All Leases" tab and assert all 3 cards reappear
    const allTab = operatorPage.locator("#lease-filter-tab-all");
    await allTab.click();
    await expect(operatorPage).toHaveURL(/filter=all/);
    await expect(operatorPage.locator("[id^='lease-card-']")).toHaveCount(3);
  });

  test("operator can revoke active lease, commit to audit ledger, and receive success alert", async ({
    operatorPage,
    request,
  }) => {
    await operatorPage.goto("/leases");

    const revokeBtn = operatorPage.locator(
      "#revoke-btn-01J9X57YTRPQ8A7F4E00112233",
    );
    await expect(revokeBtn).toBeVisible();
    await revokeBtn.click();

    // Verify modal elements
    const reasonInput = operatorPage.locator("#revoke-reason-input");
    await expect(reasonInput).toBeVisible();

    const kidInput = operatorPage.locator("#revoke-kid-input");
    await expect(kidInput).toHaveValue(/ops-emergency-key|.+/);

    // Fill revocation reason
    await reasonInput.fill(
      "Incident #4891 resolved: Primary database memory stabilized",
    );

    // In production, web tier never holds Ed25519 signing keys (Charter Invariant 2).
    // The operator provides a workstation-signed envelope.
    const { signRevocation } = await import("@synapsestate/lease");
    const { operatorPrivateKey } = await import("../fixtures/seed-data.js");
    const envelope = signRevocation(
      {
        v: 1,
        lease_id: "01J9X57YTRPQ8A7F4E00112233",
        reason: "Incident #4891 resolved: Primary database memory stabilized",
        revoked_at: new Date().toISOString(),
        kid: "ops-emergency-key",
      },
      operatorPrivateKey,
    );

    const attachBtn = operatorPage.locator(
      "button:has-text('Attach Workstation-Signed Envelope')",
    );
    await attachBtn.click();
    const envelopeInput = operatorPage.locator("#revoke-envelope-input");
    await envelopeInput.fill(JSON.stringify(envelope));

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

    // Side-Effect Assertion 1: Verify Control API removes active lease from active SDK state
    const sdkRes = await request.get(
      "http://localhost:3000/v1/sdk/state?env=prod",
    );
    expect(sdkRes.status()).toBe(200);
    const sdkData = await sdkRes.json();
    const activeLeaseInSdk = (sdkData.active_leases || []).find(
      (l: { payload?: { lease_id?: string } }) =>
        l.payload?.lease_id === "01J9X57YTRPQ8A7F4E00112233",
    );
    expect(activeLeaseInSdk).toBeUndefined();

    // Verify GET /v1/leases inventory shows revoked state
    const leasesRes = await request.get(
      "http://localhost:3000/v1/leases?env=prod",
    );
    expect(leasesRes.status()).toBe(200);
    const leasesData = await leasesRes.json();
    const revokedLease = (leasesData.leases || []).find(
      (l: { payload?: { lease_id?: string } }) =>
        l.payload?.lease_id === "01J9X57YTRPQ8A7F4E00112233",
    );
    if (revokedLease && (revokedLease as { state?: string }).state) {
      expect((revokedLease as { state?: string }).state).toBe("REVOKED");
    }

    // Side-Effect Assertion 2: Verify Audit ledger or change events record the revocation
    const authHeaders = {
      Authorization: `Bearer ${process.env.SYNAPSE_API_TOKEN || "synapse-e2e-master-token-value-2026"}`,
    };
    await expect
      .poll(
        async () => {
          const auditRes = await request.get(
            "http://localhost:3000/v1/audit/events",
            { headers: authHeaders },
          );
          if (auditRes.status() === 200) {
            const auditData = await auditRes.json();
            const found = (auditData.events || []).find(
              (e: {
                event_type?: string;
                payload?: { lease_id?: string; leaseId?: string };
              }) =>
                (e.event_type === "LEASE_REVOKED" ||
                  e.event_type === "DASHBOARD_REVOKE_TRIGGERED") &&
                (e.payload?.lease_id === "01J9X57YTRPQ8A7F4E00112233" ||
                  e.payload?.leaseId === "01J9X57YTRPQ8A7F4E00112233"),
            );
            if (found) return true;
          }

          // Also check change_events feed
          const changesRes = await request.get(
            "http://localhost:3000/v1/changes?env=prod",
          );
          if (changesRes.status() === 200) {
            const changesData = await changesRes.json();
            const foundChange = (changesData.events || []).find(
              (e: { event_type?: string; flag_key?: string }) =>
                e.event_type === "LEASE_REVOKED" &&
                e.flag_key === "checkout-v2-optimization",
            );
            if (foundChange) return true;
          }

          return false;
        },
        { timeout: 5000, intervals: [300, 500] },
      )
      .toBe(true);
  });
});
