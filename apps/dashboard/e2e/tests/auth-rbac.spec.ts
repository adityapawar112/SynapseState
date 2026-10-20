import { test, expect } from "../fixtures/auth.fixture.js";

test.describe("RBAC Permissions and Route Guard Enforcement (PR 25 & PR 27)", () => {
  test("unauthenticated visitor is redirected to /login when visiting protected pages", async ({
    page,
  }) => {
    // Attempt visiting leases page
    await page.goto("/leases");
    await expect(page).toHaveURL(/\/login\?from=%2Fleases/);

    // Attempt visiting flags inventory
    await page.goto("/flags");
    await expect(page).toHaveURL(/\/login\?from=%2Fflags/);

    // Attempt visiting audit ledger
    await page.goto("/audit");
    await expect(page).toHaveURL(/\/login\?from=%2Faudit/);
  });

  test("viewer role has read-only access and cannot see Revoke or Promote buttons", async ({
    viewerPage,
  }) => {
    await viewerPage.goto("/leases");
    await expect(viewerPage).toHaveURL(/\/leases/);

    // Verify page rendered lease cards
    const leaseCard = viewerPage.locator("#lease-card-01J9X57YTRPQ8A7F4E00112233");
    await expect(leaseCard).toBeVisible();

    // Verify viewer CANNOT see Revoke or Promote buttons
    const revokeBtn = viewerPage.locator("#revoke-btn-01J9X57YTRPQ8A7F4E00112233");
    await expect(revokeBtn).toHaveCount(0);

    const promoteBtn = viewerPage.locator("#promote-btn-01J9X57YTRPQ8A7F4E00112233");
    await expect(promoteBtn).toHaveCount(0);
  });

  test("operator role can view active leases, open Revoke modal, and open Promote modal", async ({
    operatorPage,
  }) => {
    await operatorPage.goto("/leases");
    await expect(operatorPage).toHaveURL(/\/leases/);

    const leaseCard = operatorPage.locator("#lease-card-01J9X57YTRPQ8A7F4E00112233");
    await expect(leaseCard).toBeVisible();

    // Verify operator CAN see Revoke and Promote buttons
    const revokeBtn = operatorPage.locator("#revoke-btn-01J9X57YTRPQ8A7F4E00112233");
    await expect(revokeBtn).toBeVisible();

    const promoteBtn = operatorPage.locator("#promote-btn-01J9X57YTRPQ8A7F4E00112233");
    await expect(promoteBtn).toBeVisible();

    // Open Revoke modal
    await revokeBtn.click();
    const revokeModalTitle = operatorPage.locator("#revoke-modal-title");
    await expect(revokeModalTitle).toBeVisible();
    await expect(revokeModalTitle).toHaveText("Revoke Emergency Break-Glass Lease");

    // Close modal
    await operatorPage.locator("#revoke-modal-close-btn").click();
    await expect(revokeModalTitle).not.toBeVisible();

    // Open Promote modal
    await promoteBtn.click();
    const promoteModalTitle = operatorPage.locator("#promote-modal-title");
    await expect(promoteModalTitle).toBeVisible();
    await expect(promoteModalTitle).toHaveText("Promote Override to Git");

    // Close modal
    await operatorPage.locator("#close-promote-modal-btn").click();
    await expect(promoteModalTitle).not.toBeVisible();
  });

  test("API route guards strictly reject mutations from unauthenticated and viewer personas", async ({
    request,
    viewerContext,
  }) => {
    // 1. Unauthenticated request to /api/actions/revoke returns 401
    const unauthRevoke = await request.post("/api/actions/revoke", {
      data: { leaseId: "01J9X57YTRPQ8A7F4E00112233", env: "prod", reason: "unauthorized" },
    });
    expect(unauthRevoke.status()).toBe(401);

    // 2. Unauthenticated request to /api/actions/promote returns 401
    const unauthPromote = await request.post("/api/actions/promote", {
      data: { leaseId: "01J9X57YTRPQ8A7F4E00112233", env: "prod" },
    });
    expect(unauthPromote.status()).toBe(401);

    // 3. Viewer authenticated context mutation returns 403 Forbidden
    const viewerCookies = await viewerContext.cookies();
    const cookieHeader = viewerCookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const csrfCookie = viewerCookies.find((c) => c.name === "synapse_csrf")?.value;

    const viewerRevoke = await request.post("/api/actions/revoke", {
      headers: {
        cookie: cookieHeader,
        "x-synapse-csrf": csrfCookie || "",
      },
      data: { leaseId: "01J9X57YTRPQ8A7F4E00112233", env: "prod", reason: "forbidden test" },
    });
    expect(viewerRevoke.status()).toBe(403);

    const viewerPromote = await request.post("/api/actions/promote", {
      headers: {
        cookie: cookieHeader,
        "x-synapse-csrf": csrfCookie || "",
      },
      data: { leaseId: "01J9X57YTRPQ8A7F4E00112233", env: "prod" },
    });
    expect(viewerPromote.status()).toBe(403);
  });

  test("API route guards strictly reject mutations with missing or invalid CSRF header", async ({
    request,
    operatorContext,
  }) => {
    const operatorCookies = await operatorContext.cookies();
    const cookieHeader = operatorCookies.map((c) => `${c.name}=${c.value}`).join("; ");

    // Valid operator session, but omitting x-synapse-csrf header
    const noCsrfRevoke = await request.post("/api/actions/revoke", {
      headers: {
        cookie: cookieHeader,
      },
      data: { leaseId: "01J9X57YTRPQ8A7F4E00112233", env: "prod", reason: "missing csrf" },
    });
    expect(noCsrfRevoke.status()).toBe(403);
    const revokeData = await noCsrfRevoke.json();
    expect(revokeData.error).toBe("CSRF_FORBIDDEN");

    const noCsrfPromote = await request.post("/api/actions/promote", {
      headers: {
        cookie: cookieHeader,
      },
      data: { leaseId: "01J9X57YTRPQ8A7F4E00112233", env: "prod" },
    });
    expect(noCsrfPromote.status()).toBe(403);
    const promoteData = await noCsrfPromote.json();
    expect(promoteData.error).toBe("CSRF_FORBIDDEN");
  });

  test("Control API audit staging endpoint accepts POST /v1/audit/events with 202 without route shadowing", async ({
    request,
  }) => {
    const token =
      process.env.SYNAPSE_API_TOKEN || "synapse-e2e-master-token-value-2026";
    const res = await request.post("http://localhost:3000/v1/audit/events", {
      headers: {
        Authorization: `Bearer ${token}`,
      },
      data: {
        actor: "e2e-operator",
        event_type: "DASHBOARD_LOGIN",
        payload: { test: true },
      },
    });
    expect(res.status()).toBe(202);
    const body = await res.json();
    expect(body.staged || body.status === "staged").toBeTruthy();
  });
});
