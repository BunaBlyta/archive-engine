import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@archive/db";
import { createApp } from "../app";

process.env.JWT_ACCESS_SECRET ??= "test-access-secret";
process.env.JWT_REFRESH_SECRET ??= "test-refresh-secret";

const app = createApp();

const runId = `it-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const password = "password123";
const docxFixture = readFileSync(resolve(__dirname, "../../../test-upload-docs/07-upload-test.docx"));

const createdUserEmails: string[] = [];
const createdWorkspaceIds: string[] = [];
const createdBlobHashes: string[] = [];

async function registerUser(email: string) {
  createdUserEmails.push(email);

  const response = await request(app)
    .post("/v1/auth/register")
    .send({ email, password, firstName: "Test", lastName: "User" })
    .expect(201);

  return {
    userId: response.body.data.user.id as string,
    accessToken: response.body.data.accessToken as string,
  };
}

async function createWorkspace(accessToken: string, name: string) {
  const response = await request(app)
    .post("/v1/workspaces")
    .set("Authorization", `Bearer ${accessToken}`)
    .send({ name })
    .expect(201);

  const workspaceId = response.body.data.workspace.id as string;
  createdWorkspaceIds.push(workspaceId);
  return workspaceId;
}

async function uploadDocument(
  accessToken: string,
  workspaceId: string,
  title: string,
  content: Buffer,
  filename: string,
  contentType: string
) {
  const response = await request(app)
    .post(`/v1/workspaces/${workspaceId}/documents`)
    .set("Authorization", `Bearer ${accessToken}`)
    .field("title", title)
    .attach("file", content, {
      filename,
      contentType,
    })
    .expect(201);

  createdBlobHashes.push(response.body.data.version.sha256 as string);
  return response.body.data as {
    document: { id: string; title: string };
    version: { id: string; version: number; sha256: string };
  };
}

afterAll(async () => {
  if (createdWorkspaceIds.length > 0) {
    await prisma.workspace.deleteMany({
      where: { id: { in: createdWorkspaceIds } },
    });
  }

  if (createdUserEmails.length > 0) {
    await prisma.user.deleteMany({
      where: { email: { in: createdUserEmails } },
    });
  }

  if (createdBlobHashes.length > 0) {
    // Blobs are content-addressed, so a test fixture's bytes can hash to the same Blob row as
    // unrelated dev data. The workspace/user deletes above already cascaded away every
    // DocumentVersion these tests created, so any of createdBlobHashes still referenced by a
    // DocumentVersion at this point belongs to data the tests don't own — leave it alone.
    await prisma.blob.deleteMany({
      where: {
        sha256: { in: createdBlobHashes },
        versions: { none: {} },
      },
    });
  }
});

beforeAll(async () => {
  await prisma.$queryRaw`SELECT 1`;
});

describe("API integration", () => {
  it("logs in, refreshes with cookie, logs out, and rejects wrong passwords", async () => {
    const email = `${runId}-auth-flow@example.com`;
    await registerUser(email);

    const wrongPasswordResponse = await request(app)
      .post("/v1/auth/login")
      .send({ email, password: "wrong-password" })
      .expect(401);

    expect(wrongPasswordResponse.body.error.code).toBe("UNAUTHORIZED");

    const agent = request.agent(app);

    const loginResponse = await agent
      .post("/v1/auth/login")
      .send({ email, password })
      .expect(200);

    expect(loginResponse.body.data.accessToken).toEqual(expect.any(String));

    const refreshResponse = await agent
      .post("/v1/auth/refresh")
      .expect(200);

    expect(refreshResponse.body.data.accessToken).toEqual(expect.any(String));

    await agent
      .post("/v1/auth/logout")
      .expect(200);

    const refreshAfterLogoutResponse = await agent
      .post("/v1/auth/refresh")
      .expect(401);

    expect(refreshAfterLogoutResponse.body.error.code).toBe("UNAUTHORIZED");
  });

  it("registers a user and creates a workspace", async () => {
    const email = `${runId}-owner@example.com`;
    const owner = await registerUser(email);

    const workspaceId = await createWorkspace(owner.accessToken, `${runId} Workspace`);

    const listResponse = await request(app)
      .get("/v1/workspaces")
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .expect(200);

    expect(listResponse.body.data.workspaces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: workspaceId,
          name: `${runId} Workspace`,
          role: "admin",
        }),
      ])
    );
  });

  it("prevents a non-member from accessing workspace documents", async () => {
    const owner = await registerUser(`${runId}-owner-2@example.com`);
    const outsider = await registerUser(`${runId}-outsider@example.com`);
    const workspaceId = await createWorkspace(owner.accessToken, `${runId} Private Workspace`);

    const response = await request(app)
      .get(`/v1/workspaces/${workspaceId}/documents`)
      .set("Authorization", `Bearer ${outsider.accessToken}`)
      .expect(403);

    expect(response.body.error.code).toBe("FORBIDDEN");
  });

  it("allows admins to add members and rejects member-only invitations", async () => {
    const owner = await registerUser(`${runId}-member-owner@example.com`);
    const memberEmail = `${runId}-member@example.com`;
    const thirdUserEmail = `${runId}-third-user@example.com`;
    const member = await registerUser(memberEmail);
    await registerUser(thirdUserEmail);
    const workspaceId = await createWorkspace(owner.accessToken, `${runId} Member Workspace`);

    const addMemberResponse = await request(app)
      .post(`/v1/workspaces/${workspaceId}/members`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .send({ email: memberEmail })
      .expect(201);

    expect(addMemberResponse.body.data.member).toEqual(
      expect.objectContaining({
        email: memberEmail,
        role: "reviewer",
      })
    );

    const duplicateResponse = await request(app)
      .post(`/v1/workspaces/${workspaceId}/members`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .send({ email: memberEmail })
      .expect(409);

    expect(duplicateResponse.body.error.code).toBe("CONFLICT");

    const forbiddenResponse = await request(app)
      .post(`/v1/workspaces/${workspaceId}/members`)
      .set("Authorization", `Bearer ${member.accessToken}`)
      .send({ email: thirdUserEmail })
      .expect(403);

    expect(forbiddenResponse.body.error.code).toBe("FORBIDDEN");
  });

  it("uploads and downloads a text document, with a second version added through the governance loop", async () => {
    const ownerEmail = `${runId}-docs-owner@example.com`;
    const reviewerEmail = `${runId}-docs-reviewer@example.com`;
    const owner = await registerUser(ownerEmail);
    const reviewer = await registerUser(reviewerEmail);
    const workspaceId = await createWorkspace(owner.accessToken, `${runId} Docs Workspace`);
    await request(app)
      .post(`/v1/workspaces/${workspaceId}/members`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .send({ email: reviewerEmail })
      .expect(201);

    const v1 = Buffer.from(`${runId} integration version one\n`);
    const uploadResponse = await request(app)
      .post(`/v1/workspaces/${workspaceId}/documents`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .field("title", "Integration Document")
      .attach("file", v1, { filename: "integration-v1.txt", contentType: "text/plain" })
      .expect(201);

    const documentId = uploadResponse.body.data.document.id as string;
    createdBlobHashes.push(uploadResponse.body.data.version.sha256 as string);

    expect(uploadResponse.body.data.version).toEqual(
      expect.objectContaining({
        version: 1,
        sizeBytes: v1.length,
        mimeType: "text/plain",
        originalFilename: "integration-v1.txt",
      })
    );

    // The old POST /:documentId/versions bypass is gone; version 2 goes through the governed loop
    await request(app)
      .post(`/v1/workspaces/${workspaceId}/documents/${documentId}/versions`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .expect(404);

    const v2Content = `${runId} integration version two\n`;
    const draftResponse = await request(app)
      .post(`/v1/workspaces/${workspaceId}/documents/${documentId}/drafts`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .expect(201);
    const draftId = draftResponse.body.data.draft.id as string;

    await request(app)
      .patch(`/v1/workspaces/${workspaceId}/documents/${documentId}/drafts/${draftId}`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .send({ content: v2Content })
      .expect(200);

    const proposeResponse = await request(app)
      .post(`/v1/workspaces/${workspaceId}/documents/${documentId}/drafts/${draftId}/propose`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .send({ summary: "Version two content" })
      .expect(201);
    const proposedChangeId = proposeResponse.body.data.proposedChange.id as string;

    const reviewResponse = await request(app)
      .post(`/v1/workspaces/${workspaceId}/documents/${documentId}/proposed-changes/${proposedChangeId}/reviews`)
      .set("Authorization", `Bearer ${reviewer.accessToken}`)
      .send({ state: "approved", body: "Approved" })
      .expect(201);

    createdBlobHashes.push(reviewResponse.body.data.version.sha256 as string);
    expect(reviewResponse.body.data.proposedChangeStatus).toBe("published");
    expect(reviewResponse.body.data.version).toEqual(
      expect.objectContaining({ version: 2, mimeType: "text/plain" })
    );

    const detailResponse = await request(app)
      .get(`/v1/workspaces/${workspaceId}/documents/${documentId}`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .expect(200);

    expect(detailResponse.body.data.document.versions).toHaveLength(2);
    expect(detailResponse.body.data.document.versions[0]).toEqual(
      expect.objectContaining({
        version: 1,
        createdBy: expect.objectContaining({ email: ownerEmail }),
      })
    );
    expect(detailResponse.body.data.document.versions[1]).toEqual(
      expect.objectContaining({
        version: 2,
        createdBy: expect.objectContaining({ email: reviewerEmail }),
      })
    );

    const listResponse = await request(app)
      .get(`/v1/workspaces/${workspaceId}/documents`)
      .query({ limit: 1, offset: 0 })
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .expect(200);

    expect(listResponse.body.data.pagination).toEqual(expect.objectContaining({ limit: 1, offset: 0 }));
    expect(listResponse.body.data.documents).toHaveLength(1);

    const previewResponse = await request(app)
      .get(`/v1/workspaces/${workspaceId}/documents/${documentId}/versions/2/preview`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .expect(200);

    expect(previewResponse.text).toBe(v2Content);
    expect(previewResponse.headers["content-disposition"]).toContain("inline");

    const auditCountBeforeDownload = await prisma.auditLog.count({
      where: { workspaceId, action: "document_version.downloaded" },
    });
    expect(auditCountBeforeDownload).toBe(0);

    const downloadResponse = await request(app)
      .get(`/v1/workspaces/${workspaceId}/documents/${documentId}/versions/2/download`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .expect(200);

    expect(downloadResponse.text).toBe(v2Content);
    expect(downloadResponse.headers["content-type"]).toContain("text/plain");

    const auditLogs = await prisma.auditLog.findMany({
      where: {
        workspaceId,
        entityId: {
          in: [
            documentId,
            uploadResponse.body.data.version.id as string,
            reviewResponse.body.data.version.id as string,
          ],
        },
      },
      select: { action: true },
    });

    expect(auditLogs.map((log) => log.action)).toEqual(
      expect.arrayContaining([
        "document.created",
        "document_version.downloaded",
      ])
    );

    const auditResponse = await request(app)
      .get(`/v1/workspaces/${workspaceId}/audit-logs`)
      .query({ limit: 10, offset: 0 })
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .expect(200);

    expect(auditResponse.body.data.auditLogs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "document_version.downloaded",
          actorEmail: ownerEmail,
        }),
      ])
    );
  });

  it("enforces admin-only archive and returns per-workspace roles", async () => {
    const ownerEmail = `${runId}-arch-owner@example.com`;
    const memberEmail = `${runId}-arch-member@example.com`;
    const owner = await registerUser(ownerEmail);
    const member = await registerUser(memberEmail);
    const wsA = await createWorkspace(owner.accessToken, `${runId} WsA`);
    const wsB = await createWorkspace(member.accessToken, `${runId} WsB`);

    await request(app)
      .post(`/v1/workspaces/${wsA}/members`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .send({ email: memberEmail, role: "reviewer" })
      .expect(201);

    // member is admin in wsB and member in wsA — verify per-workspace roles
    const listResponse = await request(app)
      .get("/v1/workspaces")
      .set("Authorization", `Bearer ${member.accessToken}`)
      .expect(200);

    expect(listResponse.body.data.workspaces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: wsA, role: "reviewer" }),
        expect.objectContaining({ id: wsB, role: "admin" }),
      ])
    );

    const upload = await uploadDocument(
      owner.accessToken,
      wsA,
      "Archivable Document",
      Buffer.from(`${runId} archivable\n`),
      "archivable.txt",
      "text/plain"
    );
    const documentId = upload.document.id;

    // non-admin member cannot archive
    await request(app)
      .delete(`/v1/workspaces/${wsA}/documents/${documentId}`)
      .set("Authorization", `Bearer ${member.accessToken}`)
      .expect(403);

    // admin can archive
    const archiveResponse = await request(app)
      .delete(`/v1/workspaces/${wsA}/documents/${documentId}`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .expect(200);

    expect(archiveResponse.body.data.document.archivedAt).toEqual(expect.any(String));
  });

  it("enforces the edit lock and releases it via abandon or publish", async () => {
    const ownerEmail = `${runId}-lock-owner@example.com`;
    const memberEmail = `${runId}-lock-member@example.com`;
    const owner = await registerUser(ownerEmail);
    const member = await registerUser(memberEmail);
    const workspaceId = await createWorkspace(owner.accessToken, `${runId} Lock Workspace`);
    await request(app)
      .post(`/v1/workspaces/${workspaceId}/members`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .send({ email: memberEmail, role: "reviewer" })
      .expect(201);

    const upload = await uploadDocument(
      owner.accessToken,
      workspaceId,
      "Lock Document",
      Buffer.from(`${runId} lock base\n`),
      "lock.txt",
      "text/plain"
    );
    const documentId = upload.document.id;

    // Open a proposed change
    const d1 = await request(app)
      .post(`/v1/workspaces/${workspaceId}/documents/${documentId}/drafts`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .expect(201);
    const draftId1 = d1.body.data.draft.id as string;

    // A second unproposed draft is also rejected; the lock starts at draft creation.
    const duplicateDraftResponse = await request(app)
      .post(`/v1/workspaces/${workspaceId}/documents/${documentId}/drafts`)
      .set("Authorization", `Bearer ${member.accessToken}`)
      .expect(409);
    expect(duplicateDraftResponse.body.error.message).toMatch(/draft is already in progress/i);

    await request(app)
      .patch(`/v1/workspaces/${workspaceId}/documents/${documentId}/drafts/${draftId1}`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .send({ content: `${runId} lock proposed\n` })
      .expect(200);

    const p1 = await request(app)
      .post(`/v1/workspaces/${workspaceId}/documents/${documentId}/drafts/${draftId1}/propose`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .send({ summary: "First proposal" })
      .expect(201);
    const proposedChangeId1 = p1.body.data.proposedChange.id as string;

    // A second draft is rejected while the proposal is open
    const lockResponse = await request(app)
      .post(`/v1/workspaces/${workspaceId}/documents/${documentId}/drafts`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .expect(400);
    expect(lockResponse.body.error.message).toMatch(/already awaiting review/i);

    // A non-proposer non-admin member cannot abandon
    await request(app)
      .post(`/v1/workspaces/${workspaceId}/documents/${documentId}/proposed-changes/${proposedChangeId1}/abandon`)
      .set("Authorization", `Bearer ${member.accessToken}`)
      .expect(403);

    // The proposer can abandon
    const abandonResponse = await request(app)
      .post(`/v1/workspaces/${workspaceId}/documents/${documentId}/proposed-changes/${proposedChangeId1}/abandon`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .expect(200);
    expect(abandonResponse.body.data.proposedChange.status).toBe("closed");

    // Lock is released — new draft can be created
    const d2 = await request(app)
      .post(`/v1/workspaces/${workspaceId}/documents/${documentId}/drafts`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .expect(201);
    const draftId2 = d2.body.data.draft.id as string;

    await request(app)
      .patch(`/v1/workspaces/${workspaceId}/documents/${documentId}/drafts/${draftId2}`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .send({ content: `${runId} lock v2\n` })
      .expect(200);

    const p2 = await request(app)
      .post(`/v1/workspaces/${workspaceId}/documents/${documentId}/drafts/${draftId2}/propose`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .send({ summary: "Second proposal" })
      .expect(201);
    const proposedChangeId2 = p2.body.data.proposedChange.id as string;

    // Publish releases the lock too — verify lock is active first
    await request(app)
      .post(`/v1/workspaces/${workspaceId}/documents/${documentId}/drafts`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .expect(400);

    const reviewResponse = await request(app)
      .post(`/v1/workspaces/${workspaceId}/documents/${documentId}/proposed-changes/${proposedChangeId2}/reviews`)
      .set("Authorization", `Bearer ${member.accessToken}`)
      .send({ state: "approved" })
      .expect(201);
    createdBlobHashes.push(reviewResponse.body.data.version.sha256 as string);

    // Lock released by approval/publish — new draft succeeds
    const d3 = await request(app)
      .post(`/v1/workspaces/${workspaceId}/documents/${documentId}/drafts`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .expect(201);
    expect(d3.body.data.draft.id).toEqual(expect.any(String));

    const auditActions = await prisma.auditLog.findMany({
      where: { workspaceId, action: "proposed_change.abandoned" },
      select: { action: true },
    });
    expect(auditActions).toHaveLength(1);
  });

  it("returns dashboard members with contribution counts", async () => {
    const ownerEmail = `${runId}-dash-owner@example.com`;
    const memberEmail = `${runId}-dash-member@example.com`;
    const owner = await registerUser(ownerEmail);
    const member = await registerUser(memberEmail);
    const workspaceId = await createWorkspace(owner.accessToken, `${runId} Dashboard Workspace`);
    await request(app)
      .post(`/v1/workspaces/${workspaceId}/members`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .send({ email: memberEmail, role: "reviewer" })
      .expect(201);

    // owner opens 2 proposed changes (on separate documents), member opens 1
    const uploadA = await uploadDocument(
      owner.accessToken, workspaceId, "Doc A",
      Buffer.from(`${runId} doc a\n`), "a.txt", "text/plain"
    );
    const uploadB = await uploadDocument(
      owner.accessToken, workspaceId, "Doc B",
      Buffer.from(`${runId} doc b\n`), "b.txt", "text/plain"
    );

    for (const docId of [uploadA.document.id, uploadB.document.id]) {
      const dr = await request(app)
        .post(`/v1/workspaces/${workspaceId}/documents/${docId}/drafts`)
        .set("Authorization", `Bearer ${owner.accessToken}`)
        .expect(201);
      await request(app)
        .patch(`/v1/workspaces/${workspaceId}/documents/${docId}/drafts/${dr.body.data.draft.id}`)
        .set("Authorization", `Bearer ${owner.accessToken}`)
        .send({ content: `${runId} edited\n` })
        .expect(200);
      await request(app)
        .post(`/v1/workspaces/${workspaceId}/documents/${docId}/drafts/${dr.body.data.draft.id}/propose`)
        .set("Authorization", `Bearer ${owner.accessToken}`)
        .send({ summary: "owner proposal" })
        .expect(201);
    }

    // member opens their own doc and proposes
    const uploadD = await uploadDocument(
      owner.accessToken, workspaceId, "Doc D",
      Buffer.from(`${runId} doc d\n`), "d.txt", "text/plain"
    );
    const drD = await request(app)
      .post(`/v1/workspaces/${workspaceId}/documents/${uploadD.document.id}/drafts`)
      .set("Authorization", `Bearer ${member.accessToken}`)
      .expect(201);
    await request(app)
      .patch(`/v1/workspaces/${workspaceId}/documents/${uploadD.document.id}/drafts/${drD.body.data.draft.id}`)
      .set("Authorization", `Bearer ${member.accessToken}`)
      .send({ content: `${runId} d edited\n` })
      .expect(200);
    await request(app)
      .post(`/v1/workspaces/${workspaceId}/documents/${uploadD.document.id}/drafts/${drD.body.data.draft.id}/propose`)
      .set("Authorization", `Bearer ${member.accessToken}`)
      .send({ summary: "member proposal" })
      .expect(201);

    const dashResponse = await request(app)
      .get(`/v1/workspaces/${workspaceId}/dashboard`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .expect(200);

    const members = dashResponse.body.data.members as Array<{
      email: string;
      contributionCount: number;
    }>;

    const ownerEntry = members.find((m) => m.email === ownerEmail);
    const memberEntry = members.find((m) => m.email === memberEmail);
    expect(ownerEntry?.contributionCount).toBe(2);
    expect(memberEntry?.contributionCount).toBe(1);
  });

  it("supports the full plain-text proposed change workflow", async () => {
    const owner = await registerUser(`${runId}-governance-owner@example.com`);
    const reviewerEmail = `${runId}-governance-reviewer@example.com`;
    const reviewer = await registerUser(reviewerEmail);
    const workspaceId = await createWorkspace(owner.accessToken, `${runId} Governance Workspace`);
    await request(app)
      .post(`/v1/workspaces/${workspaceId}/members`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .send({ email: reviewerEmail })
      .expect(201);
    const baseText = `${runId} Policy\nFirst rule\nSecond rule\n`;
    const approvedText = `${runId} Policy\nFirst rule\nSecond rule revised\nThird rule\n`;

    const upload = await uploadDocument(
      owner.accessToken,
      workspaceId,
      "Policy Document",
      Buffer.from(baseText),
      "policy.txt",
      "text/plain"
    );
    const documentId = upload.document.id;

    const draftResponse = await request(app)
      .post(`/v1/workspaces/${workspaceId}/documents/${documentId}/drafts`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .expect(201);

    const draftId = draftResponse.body.data.draft.id as string;
    expect(draftResponse.body.data.draft).toEqual(
      expect.objectContaining({
        documentId,
        baseVersionId: upload.version.id,
        title: "Policy Document",
        content: baseText,
        status: "draft",
      })
    );

    const updatedDraftResponse = await request(app)
      .patch(`/v1/workspaces/${workspaceId}/documents/${documentId}/drafts/${draftId}`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .send({
        content: approvedText,
      })
      .expect(200);

    expect(updatedDraftResponse.body.data.draft.content).toBe(approvedText);

    await request(app)
      .patch(`/v1/workspaces/${workspaceId}/documents/${documentId}/drafts/${draftId}`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .send({
        title: "Renamed Draft",
        content: approvedText,
      })
      .expect(400);

    const proposeResponse = await request(app)
      .post(`/v1/workspaces/${workspaceId}/documents/${documentId}/drafts/${draftId}/propose`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .send({ summary: "Revise the second rule and add a third." })
      .expect(201);

    const proposedChangeId = proposeResponse.body.data.proposedChange.id as string;
    expect(proposeResponse.body.data.proposedChange).toEqual(
      expect.objectContaining({
        documentId,
        draftId,
        status: "open",
      })
    );

    await request(app)
      .patch(`/v1/workspaces/${workspaceId}/documents/${documentId}/drafts/${draftId}`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .send({
        content: `${approvedText}Late edit\n`,
      })
      .expect(400);

    const proposedDetailResponse = await request(app)
      .get(`/v1/workspaces/${workspaceId}/documents/${documentId}/proposed-changes/${proposedChangeId}`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .expect(200);

    expect(proposedDetailResponse.body.data.baseContent).toBe(baseText);
    expect(proposedDetailResponse.body.data.draftContent).toBe(approvedText);
    expect(proposedDetailResponse.body.data.baseVersion).toEqual(
      expect.objectContaining({
        id: upload.version.id,
        version: 1,
      })
    );
    expect(proposedDetailResponse.body.data.diff.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "removed", text: "Second rule" }),
        expect.objectContaining({ type: "added", text: "Second rule revised" }),
        expect.objectContaining({ type: "added", text: "Third rule" }),
      ])
    );

    const commentedReviewResponse = await request(app)
      .post(`/v1/workspaces/${workspaceId}/documents/${documentId}/proposed-changes/${proposedChangeId}/reviews`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .send({
        state: "commented",
        body: "Leaving context without changing the decision.",
      })
      .expect(201);

    expect(commentedReviewResponse.body.data).toEqual(
      expect.objectContaining({
        proposedChangeStatus: "open",
        review: expect.objectContaining({
          state: "commented",
        }),
      })
    );

    const changesRequestedReviewResponse = await request(app)
      .post(`/v1/workspaces/${workspaceId}/documents/${documentId}/proposed-changes/${proposedChangeId}/reviews`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .send({
        state: "changes_requested",
        body: "Please verify the new third rule.",
      })
      .expect(201);

    expect(changesRequestedReviewResponse.body.data).toEqual(
      expect.objectContaining({
        proposedChangeStatus: "changes_requested",
        review: expect.objectContaining({
          state: "changes_requested",
        }),
      })
    );

    const revisedText = `${runId} Policy\nFirst rule\nSecond rule revised\nThird rule verified\n`;
    const revisionResponse = await request(app)
      .patch(`/v1/workspaces/${workspaceId}/documents/${documentId}/drafts/${draftId}`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .send({
        content: revisedText,
      })
      .expect(200);

    expect(revisionResponse.body.data.draft.content).toBe(revisedText);

    const revisedDetailResponse = await request(app)
      .get(`/v1/workspaces/${workspaceId}/documents/${documentId}/proposed-changes/${proposedChangeId}`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .expect(200);

    expect(revisedDetailResponse.body.data.proposedChange.status).toBe("open");
    expect(revisedDetailResponse.body.data.draftContent).toBe(revisedText);

    const selfApprovalResponse = await request(app)
      .post(`/v1/workspaces/${workspaceId}/documents/${documentId}/proposed-changes/${proposedChangeId}/reviews`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .send({
        state: "approved",
        body: "Approving my own change.",
      })
      .expect(400);

    expect(selfApprovalResponse.body.error.message).toMatch(/cannot approve your own/i);

    const reviewResponse = await request(app)
      .post(`/v1/workspaces/${workspaceId}/documents/${documentId}/proposed-changes/${proposedChangeId}/reviews`)
      .set("Authorization", `Bearer ${reviewer.accessToken}`)
      .send({
        state: "approved",
        body: "Approved for publishing.",
      })
      .expect(201);

    expect(reviewResponse.body.data).toEqual(
      expect.objectContaining({
        proposedChangeStatus: "published",
        version: expect.objectContaining({
          version: 2,
          mimeType: "text/plain",
          originalFilename: "policy-document-v2.txt",
        }),
        review: expect.objectContaining({
          state: "approved",
          body: "Approved for publishing.",
        }),
      })
    );

    const publishedVersion = reviewResponse.body.data.version;
    createdBlobHashes.push(publishedVersion.sha256 as string);

    const detailResponse = await request(app)
      .get(`/v1/workspaces/${workspaceId}/documents/${documentId}`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .expect(200);

    expect(detailResponse.body.data.document.versions).toHaveLength(2);
    expect(detailResponse.body.data.document.versions[1]).toEqual(
      expect.objectContaining({
        id: publishedVersion.id,
        version: 2,
      })
    );
    expect(detailResponse.body.data.document.title).toBe("Policy Document");

    const downloadResponse = await request(app)
      .get(`/v1/workspaces/${workspaceId}/documents/${documentId}/versions/2/download`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .expect(200);

    expect(downloadResponse.text).toBe(revisedText);
    expect(downloadResponse.headers["content-type"]).toContain("text/plain");

    const auditLogs = await prisma.auditLog.findMany({
      where: {
        workspaceId,
        action: {
          in: [
            "document_draft.created",
            "proposed_change.opened",
            "proposed_change.reviewed",
            "proposed_change.published",
          ],
        },
      },
      select: { action: true },
    });

    expect(auditLogs.map((log) => log.action)).toEqual(
      expect.arrayContaining([
        "document_draft.created",
        "proposed_change.opened",
        "proposed_change.reviewed",
        "proposed_change.published",
      ])
    );
  });

  it("rejects draft creation from a non-text latest version", async () => {
    const owner = await registerUser(`${runId}-binary-owner@example.com`);
    const workspaceId = await createWorkspace(owner.accessToken, `${runId} Binary Workspace`);
    const upload = await uploadDocument(
      owner.accessToken,
      workspaceId,
      "DOCX Document",
      Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]),
      "binary.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );

    const response = await request(app)
      .post(`/v1/workspaces/${workspaceId}/documents/${upload.document.id}/drafts`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .expect(400);

    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("prevents non-members from accessing drafts and proposed changes", async () => {
    const owner = await registerUser(`${runId}-access-owner@example.com`);
    const outsider = await registerUser(`${runId}-access-outsider@example.com`);
    const workspaceId = await createWorkspace(owner.accessToken, `${runId} Access Workspace`);
    const upload = await uploadDocument(
      owner.accessToken,
      workspaceId,
      "Access Document",
      Buffer.from(`${runId} member-only text\n`),
      "access.txt",
      "text/plain"
    );
    const documentId = upload.document.id;

    const draftResponse = await request(app)
      .post(`/v1/workspaces/${workspaceId}/documents/${documentId}/drafts`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .expect(201);
    const draftId = draftResponse.body.data.draft.id as string;

    await request(app)
      .patch(`/v1/workspaces/${workspaceId}/documents/${documentId}/drafts/${draftId}`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .send({ content: `${runId} member-only text, edited\n` })
      .expect(200);

    const proposeResponse = await request(app)
      .post(`/v1/workspaces/${workspaceId}/documents/${documentId}/drafts/${draftId}/propose`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .send({ summary: "Member-only proposal" })
      .expect(201);
    const proposedChangeId = proposeResponse.body.data.proposedChange.id as string;

    await request(app)
      .get(`/v1/workspaces/${workspaceId}/documents/${documentId}/drafts/${draftId}`)
      .set("Authorization", `Bearer ${outsider.accessToken}`)
      .expect(403);

    await request(app)
      .get(`/v1/workspaces/${workspaceId}/documents/${documentId}/proposed-changes/${proposedChangeId}`)
      .set("Authorization", `Bearer ${outsider.accessToken}`)
      .expect(403);
  });

  it("returns metadata when a proposed change is too large for inline diff", async () => {
    const owner = await registerUser(`${runId}-large-diff-owner@example.com`);
    const workspaceId = await createWorkspace(owner.accessToken, `${runId} Large Diff Workspace`);
    const baseText = Array.from({ length: 1100 }, (_, index) => `base line ${index}`).join("\n");
    const draftText = Array.from({ length: 1100 }, (_, index) => `draft line ${index}`).join("\n");
    const upload = await uploadDocument(
      owner.accessToken,
      workspaceId,
      "Large Review Document",
      Buffer.from(baseText),
      "large-review.txt",
      "text/plain"
    );
    const documentId = upload.document.id;

    const draftResponse = await request(app)
      .post(`/v1/workspaces/${workspaceId}/documents/${documentId}/drafts`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .expect(201);
    const draftId = draftResponse.body.data.draft.id as string;

    await request(app)
      .patch(`/v1/workspaces/${workspaceId}/documents/${documentId}/drafts/${draftId}`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .send({ content: draftText })
      .expect(200);

    const proposeResponse = await request(app)
      .post(`/v1/workspaces/${workspaceId}/documents/${documentId}/drafts/${draftId}/propose`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .send({ summary: "Large review fallback" })
      .expect(201);
    const proposedChangeId = proposeResponse.body.data.proposedChange.id as string;

    const proposedDetailResponse = await request(app)
      .get(`/v1/workspaces/${workspaceId}/documents/${documentId}/proposed-changes/${proposedChangeId}`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .expect(200);

    expect(proposedDetailResponse.body.data.diff).toEqual({
      type: "too_large",
      baseLineCount: 1100,
      draftLineCount: 1100,
      maxCellCount: 1_000_000,
      cellCount: 1_212_201,
      message: "This proposed change is too large for inline line-by-line review.",
    });
  });

  it("creates, lists, and completes tasks on a document", async () => {
    const ownerEmail = `${runId}-task-owner@example.com`;
    const memberEmail = `${runId}-task-member@example.com`;
    const outsiderEmail = `${runId}-task-outsider@example.com`;
    const owner = await registerUser(ownerEmail);
    const member = await registerUser(memberEmail);
    const outsider = await registerUser(outsiderEmail);
    const workspaceId = await createWorkspace(owner.accessToken, `${runId} Task Workspace`);
    await request(app)
      .post(`/v1/workspaces/${workspaceId}/members`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .send({ email: memberEmail, role: "reviewer" })
      .expect(201);

    const upload = await uploadDocument(
      owner.accessToken,
      workspaceId,
      "Task Document",
      Buffer.from(`${runId} task doc\n`),
      "task.txt",
      "text/plain"
    );
    const documentId = upload.document.id;

    // Reject creation if assignee is not a workspace member
    await request(app)
      .post(`/v1/workspaces/${workspaceId}/documents/${documentId}/tasks`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .send({ title: "Review this", assigneeId: outsider.userId })
      .expect(400);

    // Any member can create a task assigned to any other member
    const createResponse = await request(app)
      .post(`/v1/workspaces/${workspaceId}/documents/${documentId}/tasks`)
      .set("Authorization", `Bearer ${member.accessToken}`)
      .send({ title: "Add new terms", assigneeId: owner.userId })
      .expect(201);

    const taskId = createResponse.body.data.task.id as string;
    expect(createResponse.body.data.task).toEqual(
      expect.objectContaining({
        title: "Add new terms",
        status: "open",
        assignee: expect.objectContaining({ email: ownerEmail }),
        createdBy: expect.objectContaining({ email: memberEmail }),
      })
    );

    // Task is visible to all members
    const listResponse = await request(app)
      .get(`/v1/workspaces/${workspaceId}/documents/${documentId}/tasks`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .expect(200);

    expect(listResponse.body.data.tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: taskId, status: "open" }),
      ])
    );

    // Any member can mark it done
    const completeResponse = await request(app)
      .patch(`/v1/workspaces/${workspaceId}/documents/${documentId}/tasks/${taskId}`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .expect(200);

    expect(completeResponse.body.data.task).toEqual(
      expect.objectContaining({
        status: "done",
        completedAt: expect.any(String),
        assignee: expect.objectContaining({ email: ownerEmail }),
        createdBy: expect.objectContaining({ email: memberEmail }),
      })
    );

    // Completing an already-done task is rejected
    await request(app)
      .patch(`/v1/workspaces/${workspaceId}/documents/${documentId}/tasks/${taskId}`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .expect(400);

    // Audit log has both task events
    const auditLogs = await prisma.auditLog.findMany({
      where: { workspaceId, entityId: taskId },
      select: { action: true },
    });
    expect(auditLogs.map((l) => l.action)).toEqual(
      expect.arrayContaining(["document_task.created", "document_task.completed"])
    );
  });

  it("searches indexed document text and returns snippets", async () => {
    const owner = await registerUser(`${runId}-search-owner@example.com`);
    const workspaceId = await createWorkspace(owner.accessToken, `${runId} Search Workspace`);

    const file = Buffer.from(`${runId} searchable alpha banana gamma\n`);
    const uploadResponse = await request(app)
      .post(`/v1/workspaces/${workspaceId}/documents`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .field("title", "Searchable Integration Document")
      .attach("file", file, {
        filename: "searchable.txt",
        contentType: "text/plain",
      })
      .expect(201);

    const versionId = uploadResponse.body.data.version.id as string;
    createdBlobHashes.push(uploadResponse.body.data.version.sha256 as string);

    await prisma.documentSearch.update({
      where: { versionId },
      data: {
        status: "indexed",
        plainText: file.toString("utf8"),
        error: null,
      },
    });

    const searchResponse = await request(app)
      .get(`/v1/workspaces/${workspaceId}/documents/search`)
      .query({ q: "banana", limit: 5, offset: 0 })
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .expect(200);

    expect(searchResponse.body.data.pagination).toEqual(
      expect.objectContaining({
        limit: 5,
        offset: 0,
      })
    );

    expect(searchResponse.body.data.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          document: expect.objectContaining({
            title: "Searchable Integration Document",
          }),
          version: expect.objectContaining({
            id: versionId,
            originalFilename: "searchable.txt",
            search: expect.objectContaining({
              status: "indexed",
              error: null,
            }),
          }),
          search: expect.objectContaining({
            status: "indexed",
            snippet: expect.stringContaining("banana"),
          }),
        }),
      ])
    );
  });

  it("rejects PDF uploads and initializes native DOCX preview and editing", async () => {
    const owner = await registerUser(`${runId}-m4-owner@example.com`);
    const workspaceId = await createWorkspace(owner.accessToken, `${runId} M4 Workspace`);

    const pdfResponse = await request(app)
      .post(`/v1/workspaces/${workspaceId}/documents`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .field("title", "PDF Document")
      .attach("file", Buffer.from("%PDF-1.4 fake pdf content"), {
        filename: "structured.pdf",
        contentType: "application/pdf",
      })
      .expect(400);

    expect(pdfResponse.body.error.message).toMatch(/pdf editing is not supported/i);

    const docxUpload = await uploadDocument(
      owner.accessToken,
      workspaceId,
      "DOCX Document",
      docxFixture,
      "structured.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );

    const previewResponse = await request(app)
      .get(`/v1/workspaces/${workspaceId}/documents/${docxUpload.document.id}/versions/1/preview`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .expect(200);

    expect(previewResponse.headers["content-type"]).toMatch(/text\/html/);
    expect(previewResponse.text).toContain("UPLOAD TEST DOCUMENT");

    const draftResponse = await request(app)
      .post(`/v1/workspaces/${workspaceId}/documents/${docxUpload.document.id}/drafts`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .expect(201);

    expect(draftResponse.body.data.draft.contentFormat).toBe("markdown");
    expect(draftResponse.body.data.draft.content).toContain("UPLOAD TEST DOCUMENT");
    expect(draftResponse.body.data.draft.artifactMimeType).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );
    expect(draftResponse.body.data.draft.editorKey).toEqual(expect.any(String));

    const draftId = draftResponse.body.data.draft.id as string;
    const draftEditorResponse = await request(app)
      .get(`/v1/workspaces/${workspaceId}/documents/${docxUpload.document.id}/drafts/${draftId}/editor-config`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .expect(200);

    expect(draftEditorResponse.body.data.editor.document.fileType).toBe("docx");
    expect(draftEditorResponse.body.data.editor.documentType).toBe("word");
    expect(draftEditorResponse.body.data.editor.editorConfig.mode).toBe("edit");
    expect(draftEditorResponse.body.data.editor.token).toEqual(expect.any(String));

    const draftFileUrl = new URL(draftEditorResponse.body.data.editor.document.url);
    const draftFileResponse = await request(app)
      .get(`${draftFileUrl.pathname}${draftFileUrl.search}`)
      .expect(200);
    expect(draftFileResponse.headers["content-type"]).toMatch(/application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document/);
    expect(Number(draftFileResponse.headers["content-length"])).toBeGreaterThan(0);

    const versionEditorResponse = await request(app)
      .get(`/v1/workspaces/${workspaceId}/documents/${docxUpload.document.id}/versions/1/editor-config`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .expect(200);

    expect(versionEditorResponse.body.data.editor.editorConfig.mode).toBe("view");

    // Word drafts are edited through the native ONLYOFFICE editor, not the content-patch route
    // — publish uses the untouched artifact blob, so a text patch here would silently never ship.
    const rejectedPatchResponse = await request(app)
      .patch(`/v1/workspaces/${workspaceId}/documents/${docxUpload.document.id}/drafts/${draftId}`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .send({ content: "# Edited DOCX content\n\nThis change was made in the browser editor." })
      .expect(400);

    expect(rejectedPatchResponse.body.error.message).toMatch(/native editor/i);
  });

  it("exports a text/markdown version as PDF and rejects plain-text versions", async () => {
    const owner = await registerUser(`${runId}-m5-owner@example.com`);
    const reviewer = await registerUser(`${runId}-m5-reviewer@example.com`);
    const workspaceId = await createWorkspace(owner.accessToken, `${runId} M5 Workspace`);
    await request(app)
      .post(`/v1/workspaces/${workspaceId}/members`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .send({ email: `${runId}-m5-reviewer@example.com`, role: "reviewer" })
      .expect(201);

    // Publish a markdown version through the governed loop
    const upload = await uploadDocument(
      owner.accessToken, workspaceId, "M5 Document",
      Buffer.from(`${runId} m5 base content\n`), "m5.txt", "text/plain"
    );
    const documentId = upload.document.id;

    const dr = await request(app)
      .post(`/v1/workspaces/${workspaceId}/documents/${documentId}/drafts`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .expect(201);
    const draftId = dr.body.data.draft.id as string;

    // Simulate a markdown draft by patching contentFormat directly in the DB
    await prisma.documentDraft.update({
      where: { id: draftId },
      data: { contentFormat: "markdown", content: "## Heading\n\nParagraph text.\n\n- Item one\n- Item two\n" },
    });

    const proposeRes = await request(app)
      .post(`/v1/workspaces/${workspaceId}/documents/${documentId}/drafts/${draftId}/propose`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .send({ summary: "Markdown version" })
      .expect(201);
    const proposedChangeId = proposeRes.body.data.proposedChange.id as string;

    const reviewResponse = await request(app)
      .post(`/v1/workspaces/${workspaceId}/documents/${documentId}/proposed-changes/${proposedChangeId}/reviews`)
      .set("Authorization", `Bearer ${reviewer.accessToken}`)
      .send({ state: "approved" })
      .expect(201);
    createdBlobHashes.push(reviewResponse.body.data.version.sha256 as string);

    const markdownVersion = reviewResponse.body.data.version.version as number;
    expect(reviewResponse.body.data.version.mimeType).toBe("text/markdown");

    // Export as PDF succeeds and returns a valid PDF
    const exportRes = await request(app)
      .get(`/v1/workspaces/${workspaceId}/documents/${documentId}/versions/${markdownVersion}/export-pdf`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .expect(200);

    expect(exportRes.headers["content-type"]).toContain("application/pdf");
    expect(exportRes.body.slice(0, 4).toString()).toBe("%PDF");

    // Audit log records the export
    const auditLogs = await prisma.auditLog.findMany({
      where: { workspaceId, action: "document_version.exported" },
      select: { action: true },
    });
    expect(auditLogs).toHaveLength(1);

    // Exporting a plain-text version returns 400
    await request(app)
      .get(`/v1/workspaces/${workspaceId}/documents/${documentId}/versions/1/export-pdf`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .expect(400);
  });

  it("supports line comments on a proposed change", async () => {
    const owner = await registerUser(`${runId}-lc-owner@example.com`);
    const reviewer = await registerUser(`${runId}-lc-reviewer@example.com`);
    const workspaceId = await createWorkspace(owner.accessToken, `${runId}-lc-ws`);

    await request(app)
      .post(`/v1/workspaces/${workspaceId}/members`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .send({ email: `${runId}-lc-reviewer@example.com`, role: "reviewer" })
      .expect(201);

    const { document } = await uploadDocument(
      owner.accessToken,
      workspaceId,
      "Line Comment Doc",
      Buffer.from("line one\nline two\nline three"),
      "doc.txt",
      "text/plain"
    );
    const documentId = document.id;

    const draftRes = await request(app)
      .post(`/v1/workspaces/${workspaceId}/documents/${documentId}/drafts`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .expect(201);
    const draftId = draftRes.body.data.draft.id as string;

    await request(app)
      .patch(`/v1/workspaces/${workspaceId}/documents/${documentId}/drafts/${draftId}`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .send({ content: "line one\nline two updated\nline three" })
      .expect(200);

    const proposeRes = await request(app)
      .post(`/v1/workspaces/${workspaceId}/documents/${documentId}/drafts/${draftId}/propose`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .send({ summary: "Update line two" })
      .expect(201);
    const proposedChangeId = proposeRes.body.data.proposedChange.id as string;

    // Post a line comment
    const commentRes = await request(app)
      .post(`/v1/workspaces/${workspaceId}/documents/${documentId}/proposed-changes/${proposedChangeId}/comments`)
      .set("Authorization", `Bearer ${reviewer.accessToken}`)
      .send({ diffLineIndex: 1, body: "This change looks good" })
      .expect(201);

    expect(commentRes.body.data.comment.body).toBe("This change looks good");
    expect(commentRes.body.data.comment.diffLineIndex).toBe(1);
    expect(commentRes.body.data.comment.author.email).toContain("lc-reviewer");

    // Comments must point at an actual generated diff line.
    await request(app)
      .post(`/v1/workspaces/${workspaceId}/documents/${documentId}/proposed-changes/${proposedChangeId}/comments`)
      .set("Authorization", `Bearer ${reviewer.accessToken}`)
      .send({ diffLineIndex: 99, body: "Invalid anchor" })
      .expect(400);

    // Comment appears in GET proposed-changes/:id
    const detailRes = await request(app)
      .get(`/v1/workspaces/${workspaceId}/documents/${documentId}/proposed-changes/${proposedChangeId}`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .expect(200);

    expect(detailRes.body.data.comments).toHaveLength(1);
    expect(detailRes.body.data.comments[0].body).toBe("This change looks good");
    expect(detailRes.body.data.comments[0].diffLineIndex).toBe(1);

    // Audit log records the comment
    const auditLogs = await prisma.auditLog.findMany({
      where: { workspaceId, action: "proposed_change.commented" },
      select: { action: true },
    });
    expect(auditLogs).toHaveLength(1);

    // Cannot comment on a closed/abandoned proposed change
    await request(app)
      .post(`/v1/workspaces/${workspaceId}/documents/${documentId}/proposed-changes/${proposedChangeId}/abandon`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .expect(200);

    await request(app)
      .post(`/v1/workspaces/${workspaceId}/documents/${documentId}/proposed-changes/${proposedChangeId}/comments`)
      .set("Authorization", `Bearer ${reviewer.accessToken}`)
      .send({ diffLineIndex: 0, body: "Too late" })
      .expect(400);
  });
});
