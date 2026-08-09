import { expect, test } from "@playwright/test";
import {
  addMember,
  createWorkspace,
  registerUser,
  signIn,
  uploadTextDocument,
} from "./helpers";

// The whole product in one test: an author edits a document, proposes the change, a second person
// reviews the diff and approves, and a new version appears. If this passes, the governance loop
// works end to end.
test("an author proposes a change and a reviewer approves it into a new version", async ({
  browser,
  request,
}) => {
  // Two browser contexts, two sign-ins, an editor and a publish — well past the 30s default.
  test.setTimeout(120_000);
  const stamp = Date.now();
  const author = await registerUser(request, "author");
  const reviewer = await registerUser(request, "reviewer");
  const workspaceName = `Governance Workspace ${stamp}`;
  const workspaceId = await createWorkspace(request, author.accessToken, workspaceName);
  await addMember(request, author.accessToken, workspaceId, reviewer.email);

  const title = `Governance Document ${stamp}`;
  await uploadTextDocument(
    request,
    author.accessToken,
    workspaceId,
    title,
    "First rule\nSecond rule\n"
  );

  // --- Author proposes ---
  const authorContext = await browser.newContext();
  const authorPage = await authorContext.newPage();
  await signIn(authorPage, author.email);
  await authorPage.getByText(workspaceName).click();
  await authorPage.getByText(title).dblclick();

  await authorPage.getByRole("button", { name: /propose changes/i }).click();
  await expect(authorPage.getByRole("heading", { name: "Edit draft" })).toBeVisible();

  // A text/plain draft edits in a plain textarea; Markdown drafts get the rich editor and Word
  // drafts get ONLYOFFICE. The fixture is .txt, so this is the textarea path.
  const editor = authorPage.getByLabel("Draft content");
  await editor.fill("First rule\nSecond rule revised\n");

  await authorPage.getByLabel("Change summary").fill("Revise the second rule.");
  await authorPage.getByRole("button", { name: /submit for review/i }).click();

  // Assert on a control that only exists once a proposal is open. Matching the changed text
  // instead would also match the editor the author just typed into, hiding a failed submit.
  await expect(authorPage.getByRole("button", { name: /withdraw/i })).toBeVisible();
  await authorContext.close();

  // --- Reviewer approves ---
  const reviewerContext = await browser.newContext();
  const reviewerPage = await reviewerContext.newPage();
  await signIn(reviewerPage, reviewer.email);
  await reviewerPage.getByText(workspaceName).click();
  await reviewerPage.getByText(title).dblclick();

  await reviewerPage.getByRole("button", { name: /view changes/i }).click();
  await expect(reviewerPage.getByText(/second rule revised/i).first()).toBeVisible();

  await reviewerPage.getByRole("button", { name: /approve and publish/i }).click();

  // Version 2 is the proof: approval published the draft as a new immutable version.
  await expect(reviewerPage.getByText(/version 2/i).first()).toBeVisible({ timeout: 20_000 });
  await reviewerContext.close();
});
