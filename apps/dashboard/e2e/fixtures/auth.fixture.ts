import { test as base, expect, type Page, type BrowserContext } from "@playwright/test";
import {
  createSessionToken,
  generateCsrfToken,
  getDevSessionUser,
} from "../../src/lib/auth";
import type { UserRole } from "../../src/lib/types";

export interface AuthFixtures {
  viewerContext: BrowserContext;
  operatorContext: BrowserContext;
  adminContext: BrowserContext;
  viewerPage: Page;
  operatorPage: Page;
  adminPage: Page;
  createRolePage: (role: UserRole) => Promise<Page>;
}

export const TEST_SESSION_SECRET =
  process.env.SESSION_SECRET || "development-only-session-secret-min-32-chars-long";

/**
 * Injects signed session and CSRF cookies directly onto the Playwright browser context.
 * Enables zero-redirect testing across viewer, operator, and admin personas.
 */
export async function authenticateContext(
  context: BrowserContext,
  role: UserRole
): Promise<{ token: string; csrfToken: string }> {
  const user = getDevSessionUser(role);
  const token = await createSessionToken(user, TEST_SESSION_SECRET);
  const csrfToken = await generateCsrfToken(user.id, TEST_SESSION_SECRET);

  // Playwright requires either url or domain+path (mutually exclusive)
  // httpOnly: true for session cookie, false for csrf cookie readable by client
  await context.addCookies([
    {
      name: "synapse_session",
      value: token,
      domain: "localhost",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
    {
      name: "synapse_csrf",
      value: csrfToken,
      domain: "localhost",
      path: "/",
      httpOnly: false,
      sameSite: "Lax",
    },
  ]);

  return { token, csrfToken };
}

export const test = base.extend<AuthFixtures>({
  viewerContext: async ({ browser }, use) => {
    const context = await browser.newContext();
    await authenticateContext(context, "viewer");
    await use(context);
    await context.close();
  },

  operatorContext: async ({ browser }, use) => {
    const context = await browser.newContext();
    await authenticateContext(context, "operator");
    await use(context);
    await context.close();
  },

  adminContext: async ({ browser }, use) => {
    const context = await browser.newContext();
    await authenticateContext(context, "admin");
    await use(context);
    await context.close();
  },

  viewerPage: async ({ viewerContext }, use) => {
    const page = await viewerContext.newPage();
    await use(page);
  },

  operatorPage: async ({ operatorContext }, use) => {
    const page = await operatorContext.newPage();
    await use(page);
  },

  adminPage: async ({ adminContext }, use) => {
    const page = await adminContext.newPage();
    await use(page);
  },

  createRolePage: async ({ browser }, use) => {
    const contexts: BrowserContext[] = [];
    await use(async (role: UserRole) => {
      const context = await browser.newContext();
      contexts.push(context);
      await authenticateContext(context, role);
      return context.newPage();
    });
    for (const ctx of contexts) {
      await ctx.close();
    }
  },
});

export { expect };
