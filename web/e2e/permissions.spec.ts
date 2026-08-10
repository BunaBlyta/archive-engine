import { expect, test } from "@playwright/test";
import {
  API_ORIGIN,
  addMember,
  createWorkspace,
  registerUser,
  signIn,
  uploadTextDocument,
} from "./helpers";

// The API refuses these actions to anyone but the draft's author or an admin. Showing the
// buttons anyway produces controls that always fail — which is exactly what happened: a second
// member saw "Resume draft" and "Discard draft" on someone else's draft, clicked, and got
// "Only the draft author or an admin can edit this draft".
test("a member does not get draft controls for someone else's draft", async ({
  browser,
  request,
}) => {
  test.setTimeout(90_000);

  const stamp = Date.now();
  const author = await registerUser(request, "draft-author");
  const other = await registerUser(request, "draft-other");
  const workspaceName = `Permissions Workspace ${stamp}`;
  const workspaceId = await createWorkspace(request, author.accessToken, workspaceName);
  await addMember(request, author.accessToken, workspaceId, other.email);

  const title = `Permissions Document ${stamp}`;
  const documentId = await uploadTextDocument(
    request,
    author.accessToken,
    workspaceId,
    title,
    "First rule\n"
  );

  // The author starts a draft but does not propose it, so the document sits with an active draft
  // owned by someone other than the viewer below.
  const draftResponse = await request.post(
    `${API_ORIGIN}/v1/workspaces/${workspaceId}/documents/${documentId}/drafts`,
    { headers: { Authorization: `Bearer ${author.accessToken}` } }
  );
  expect(draftResponse.ok()).toBeTruthy();

  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, other.email);
  await page.getByText(workspaceName).click();
  await page.getByText(title).dblclick();

  // Told what is happening, but given no control that would be refused.
  await expect(page.getByRole("button", { name: "Draft in progress" })).toBeVisible();
  await expect(page.getByRole("button", { name: /resume draft/i })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /discard draft/i })).toHaveCount(0);

  await context.close();
});
