import { test, expect } from "../fixtures/auth.fixture.js";

test.describe("Promotion Flow & Git Reconciliation Diff Preview (PR 27)", () => {
  test.beforeEach(async ({ request }) => {
    await request.post("http://localhost:3000/__test/reset").catch(() => {});
  });

  test("displays generated YAML diff preview, submits Draft PR, and renders success toast with PR link", async ({
    operatorPage,
  }) => {
    await operatorPage.goto("/leases");

    const promoteBtn = operatorPage.locator(
      "#promote-btn-01J9X57YTRPQ8A7F4E00112233"
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
    expect(diffText).toContain("Illustrative preview; actual diff created in Draft PR");
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
      /Draft Pull Request Created Successfully/
    );

    // Assert PR link is present and targets a GitHub PR URL
    const prLink = operatorPage.locator("#view-pr-link");
    await expect(prLink).toBeVisible();
    const href = await prLink.getAttribute("href");
    expect(href).toMatch(/github\.com\/.*\/pull\/.+/);
  });
});
