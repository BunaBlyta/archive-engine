import { expect, type APIRequestContext, type Page } from "@playwright/test";

export const API_ORIGIN = "http://localhost:3000";
export const PASSWORD = "playwright-password";

export function uniqueEmail(prefix: string) {
  return `pw-${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`;
}

// Seeding through the API rather than the UI: these tests are about the flows under test, not
// about registration, and a spec that depends on pre-existing database rows breaks on a clean
// machine.
export async function registerUser(request: APIRequestContext, prefix: string) {
  const email = uniqueEmail(prefix);
  const response = await request.post(`${API_ORIGIN}/v1/auth/register`, {
    data: { email, password: PASSWORD, firstName: "Play", lastName: "Wright" },
  });

  expect(response.ok()).toBeTruthy();
  const body = (await response.json()) as { data: { accessToken: string; user: { id: string } } };

  return { email, accessToken: body.data.accessToken, userId: body.data.user.id };
}

export async function createWorkspace(request: APIRequestContext, accessToken: string, name: string) {
  const response = await request.post(`${API_ORIGIN}/v1/workspaces`, {
    data: { name },
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  expect(response.ok()).toBeTruthy();
  const body = (await response.json()) as { data: { workspace: { id: string } } };
  return body.data.workspace.id;
}

export async function addMember(
  request: APIRequestContext,
  accessToken: string,
  workspaceId: string,
  email: string
) {
  const response = await request.post(`${API_ORIGIN}/v1/workspaces/${workspaceId}/members`, {
    data: { email },
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  expect(response.ok()).toBeTruthy();
}

export async function uploadTextDocument(
  request: APIRequestContext,
  accessToken: string,
  workspaceId: string,
  title: string,
  body: string
) {
  const response = await request.post(`${API_ORIGIN}/v1/workspaces/${workspaceId}/documents`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    multipart: {
      title,
      file: { name: "fixture.txt", mimeType: "text/plain", buffer: Buffer.from(body, "utf8") },
    },
  });

  expect(response.ok()).toBeTruthy();
  const parsed = (await response.json()) as { data: { document: { id: string } } };
  return parsed.data.document.id;
}

export async function signIn(page: Page, email: string) {
  await page.goto("/");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page.getByRole("heading", { name: "Workspaces" })).toBeVisible();
}
