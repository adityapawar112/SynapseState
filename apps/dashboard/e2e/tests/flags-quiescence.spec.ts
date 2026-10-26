import { test, expect } from "../fixtures/auth.fixture.js";

test.describe("Flag Inventory, Variant Quiescence & Purger Candidates (PR 27)", () => {
  test.beforeEach(async ({ request }) => {
    const res = await request.post("http://localhost:3000/__test/reset");
    expect(res.ok()).toBe(true);
  });

  test("displays 30-day evaluation tables, variant distribution, and identifies stale purger candidates", async ({
    operatorPage,
  }) => {
    await operatorPage.goto("/flags");

    // Assert Page Heading & Summary Cards
    const heading = operatorPage.locator("h1");
    await expect(heading).toHaveText("Flag Inventory & Telemetry");

    // Assert Quiescent Purger Candidate Flag
    const candidateRow = operatorPage.locator(
      "#flag-row-recommendations-model-v2",
    );
    await expect(candidateRow).toBeVisible();

    // Verify "Purger Candidate" badge is present with exact text matching
    const purgerBadge = candidateRow.getByText("Purger Candidate", {
      exact: true,
    });
    await expect(purgerBadge).toBeVisible();

    // Verify dominant variant is identified
    const dominantVariant = candidateRow.getByText("Dominant Variant:", {
      exact: false,
    });
    await expect(dominantVariant).toBeVisible();
    await expect(
      candidateRow.getByText("v2", { exact: true }).first(),
    ).toBeVisible();

    // Verify evaluation volume count is rendered
    await expect(candidateRow).toContainText("evaluations recorded");

    // Assert Active Override Badge on Flag with Active Lease
    const activeOverrideRow = operatorPage.locator(
      "#flag-row-checkout-v2-optimization",
    );
    await expect(activeOverrideRow).toBeVisible();
    const emergencyBadge = activeOverrideRow.getByText(
      "Emergency Lease Active",
      { exact: true },
    );
    await expect(emergencyBadge).toBeVisible();

    // Assert Environment Selector Navigation and empty state content
    const stagingTab = operatorPage.locator("#flag-env-select-staging");
    await stagingTab.click();
    await expect(operatorPage).toHaveURL(/env=staging/);
    await expect(
      operatorPage.getByText("No flags found matching query in STAGING", {
        exact: false,
      }),
    ).toBeVisible();
  });
});
