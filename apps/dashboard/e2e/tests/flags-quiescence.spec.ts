import { test, expect } from "../fixtures/auth.fixture.js";

test.describe("Flag Inventory, Variant Quiescence & Purger Candidates (PR 27)", () => {
  test("displays 30-day evaluation tables, variant distribution, and identifies stale purger candidates", async ({
    operatorPage,
  }) => {
    await operatorPage.goto("/flags");

    // Assert Page Heading & Summary Cards
    const heading = operatorPage.locator("h1");
    await expect(heading).toHaveText("Flag Inventory & Telemetry");

    // Assert Quiescent Purger Candidate Flag
    const candidateRow = operatorPage.locator(
      "#flag-row-recommendations-model-v2"
    );
    await expect(candidateRow).toBeVisible();

    // Verify "Purger Candidate" badge is present
    const purgerBadge = candidateRow.locator("text=Purger Candidate");
    await expect(purgerBadge).toBeVisible();

    // Verify dominant variant is identified
    const dominantVariant = candidateRow.locator("text=Dominant Variant:");
    await expect(dominantVariant).toBeVisible();
    await expect(candidateRow.locator("text=v2").first()).toBeVisible();

    // Verify evaluation volume count is rendered
    await expect(candidateRow).toContainText("evaluations recorded");

    // Assert Active Override Badge on Flag with Active Lease
    const activeOverrideRow = operatorPage.locator(
      "#flag-row-checkout-v2-optimization"
    );
    await expect(activeOverrideRow).toBeVisible();
    const emergencyBadge = activeOverrideRow.locator(
      "text=Emergency Lease Active"
    );
    await expect(emergencyBadge).toBeVisible();

    // Assert Environment Selector Navigation
    const stagingTab = operatorPage.locator("#flag-env-select-staging");
    await stagingTab.click();
    await expect(operatorPage).toHaveURL(/env=staging/);
  });
});
