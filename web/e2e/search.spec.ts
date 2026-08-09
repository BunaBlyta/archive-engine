import { expect, test } from "@playwright/test";
import { createWorkspace, registerUser, signIn, uploadTextDocument } from "./helpers";

// The API returns match markers as private-use sentinels rather than HTML. If the frontend does
// not translate them, users see control characters in every search result — which is exactly
// what happened when the full-text search work landed without its frontend.
test("search highlights the matched term and shows no marker characters", async ({
  page,
  request,
}) => {
  test.setTimeout(90_000);

  const stamp = Date.now();
  const term = `zubelium${stamp}`;
  const user = await registerUser(request, "search");
  const workspaceName = `Search Workspace ${stamp}`;
  const workspaceId = await createWorkspace(request, user.accessToken, workspaceName);
  await uploadTextDocument(
    request,
    user.accessToken,
    workspaceId,
    `Search Document ${stamp}`,
    `Policy body mentioning ${term} once.\n`
  );

  await signIn(page, user.email);
  await page.getByText(workspaceName).click();

  // Indexing is asynchronous, so retry the search until the worker has caught up.
  await expect(async () => {
    await page.getByPlaceholder(/search documents/i).fill(term);
    await page.getByPlaceholder(/search documents/i).press("Enter");
    await expect(page.getByRole("heading", { name: "Search results" })).toBeVisible();
    await expect(page.locator("mark").filter({ hasText: term }).first()).toBeVisible();
  }).toPass({ timeout: 60_000 });

  // The sentinels are private-use characters; none may survive into the rendered page.
  const body = await page.locator("body").innerText();
  expect(body).not.toContain("ARCHIVE_ENGINE_SEARCH_START");
  expect(body).not.toContain("");
});
