import { expect, test } from "@playwright/test";
import { createWorkspace, registerUser, signIn, uploadTextDocument } from "./helpers";

test("signed out, the app shows the sign-in form", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByLabel("Email")).toBeVisible();
  await expect(page.getByLabel("Password")).toBeVisible();
  await expect(page.getByRole("button", { name: /sign in/i })).toBeVisible();
});

test("a wrong password is rejected and does not sign the user in", async ({ page, request }) => {
  const user = await registerUser(request, "wrongpass");

  await page.goto("/");
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill("not-the-password");
  await page.getByRole("button", { name: /sign in/i }).click();

  // .first(): Radix Toast renders the message twice — once visibly and once into an aria-live
  // region for screen readers — so an unscoped match trips strict mode.
  await expect(page.getByText(/invalid email or password/i).first()).toBeVisible();
  await expect(page.getByLabel("Email")).toBeVisible();
});

test("signing in lists the user's workspaces and their documents", async ({ page, request }) => {
  const user = await registerUser(request, "smoke");
  const workspaceName = `Smoke Workspace ${Date.now()}`;
  const workspaceId = await createWorkspace(request, user.accessToken, workspaceName);
  const title = `Smoke Document ${Date.now()}`;
  await uploadTextDocument(request, user.accessToken, workspaceId, title, "Baseline body.\n");

  await signIn(page, user.email);

  await page.getByText(workspaceName).click();
  await expect(page.getByText(title)).toBeVisible();
});
