import { test, expect } from "../fixtures/auth.fixture.js";

test.describe("Promotion Flow & Git Reconciliation Diff Preview (PR 27)", () => {
  test.beforeEach(async ({ request }) => {
    const res = await request.post("http://localhost:3000/__test/reset");
    expect(res.ok()).toBe(true);
  });

  test("displays generated YAML diff preview, submits Draft PR, and renders success toast with PR link", async ({
    operatorPage,
    request,
  }) => {
    await operatorPage.goto("/leases");

    const promoteBtn = operatorPage.locator(
      "#promote-btn-01J9X57YTRPQ8A7F4E00112233",
    );
    await expect(promoteBtn).toBeVisible();
    await promoteBtn.click();

    // Verify Promote modal header and Dual-Control notice
    const modalTitle = operatorPage.locator("#promote-modal-title");
    await expect(modalTitle).toBeVisible();
    await expect(modalTitle).toHaveText("Promote Override to Git");

    // Verify generated YAML reconciliation diff preview
    const diffPreview = operatorPage.locator("#promote-diff-preview");
    await expect(diffPreview).toBeVisible();

    const diffText = await diffPreview.textContent();
    expect(diffText).toContain("flags/prod/checkout-v2-optimization.yaml");
    expect(diffText).toContain(
      "Illustrative preview; actual diff created in Draft PR",
    );
    expect(diffText).toContain("-defaultVariant: off");
    expect(diffText).toContain("+defaultVariant: pipeline-b");

    // Submit Draft PR
    const submitBtn = operatorPage.locator("#submit-promote-btn");
    await expect(submitBtn).toBeEnabled();
    await submitBtn.click();

    // Assert success banner/toast alert
    const successBanner = operatorPage.locator("#promote-success-banner");
    await expect(successBanner).toBeVisible();
    await expect(successBanner).toHaveAttribute("role", "alert");
    await expect(successBanner).toHaveText(
      /Draft Pull Request Created Successfully/,
    );

    // Assert PR link is present and targets a GitHub PR URL
    const prLink = operatorPage.locator("#view-pr-link");
    await expect(prLink).toBeVisible();
    const href = await prLink.getAttribute("href");
    expect(href).toMatch(/github\.com\/.*\/pull\/.+/);

    // Side-Effect Assertion: Verify promotion was recorded in audit trail
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
                (e.event_type === "LEASE_PROMOTED" ||
                  e.event_type === "DASHBOARD_PROMOTE_TRIGGERED") &&
                (e.payload?.lease_id === "01J9X57YTRPQ8A7F4E00112233" ||
                  e.payload?.leaseId === "01J9X57YTRPQ8A7F4E00112233"),
            );
            if (found) return true;
          }
          return false;
        },
        { timeout: 5000, intervals: [300, 500] },
      )
      .toBe(true);
  });

  test("negative test: prevents duplicate promotion with conflict error", async ({
    request,
  }) => {
    const authHeaders = {
      Authorization: `Bearer ${process.env.SYNAPSE_API_TOKEN || "synapse-e2e-master-token-value-2026"}`,
    };
    // Attempting a second promotion on the same lease returns 409 STALE_PR_CONFLICT
    const firstPromote = await request.post(
      "http://localhost:3000/v1/leases/01J9X57YTRPQ8A7F4E00445566/promote",
      { headers: authHeaders },
    );
    if (firstPromote.status() === 503) {
      // Live Control API without GitHub token configured returns 503 GITHUB_NOT_CONFIGURED
      const errData = await firstPromote.json();
      expect(errData.error).toBe("GITHUB_NOT_CONFIGURED");
    } else {
      expect(firstPromote.status()).toBe(202);

      const duplicatePromote = await request.post(
        "http://localhost:3000/v1/leases/01J9X57YTRPQ8A7F4E00445566/promote",
        { headers: authHeaders },
      );
      expect(duplicatePromote.status()).toBe(409);
      const dupData = await duplicatePromote.json();
      expect(dupData.error).toBe("STALE_PR_CONFLICT");
    }
  });
});
