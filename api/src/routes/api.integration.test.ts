import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@archive/db";
import { createApp } from "../app";

process.env.JWT_ACCESS_SECRET ??= "test-access-secret";
process.env.JWT_REFRESH_SECRET ??= "test-refresh-secret";

const app = createApp();

const runId = `it-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const password = "password123";

const createdUserEmails: string[] = [];
const createdWorkspaceIds: string[] = [];
const createdBlobHashes: string[] = [];

async function registerUser(email: string) {
  createdUserEmails.push(email);

  const response = await request(app)
    .post("/v1/auth/register")
    .send({ email, password })
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
    await prisma.blob.deleteMany({
      where: { sha256: { in: createdBlobHashes } },
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
        role: "member",
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

  it("uploads, versions, and downloads a text document", async () => {
    const owner = await registerUser(`${runId}-docs-owner@example.com`);
    const workspaceId = await createWorkspace(owner.accessToken, `${runId} Docs Workspace`);

    const v1 = Buffer.from(`${runId} integration version one\n`);
    const uploadResponse = await request(app)
      .post(`/v1/workspaces/${workspaceId}/documents`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .field("title", "Integration Document")
      .attach("file", v1, {
        filename: "integration-v1.txt",
        contentType: "text/plain",
      })
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

    const v2 = Buffer.from(`${runId} integration version two\n`);
    const versionResponse = await request(app)
      .post(`/v1/workspaces/${workspaceId}/documents/${documentId}/versions`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .attach("file", v2, {
        filename: "integration-v2.txt",
        contentType: "text/plain",
      })
      .expect(201);

    createdBlobHashes.push(versionResponse.body.data.version.sha256 as string);

    expect(versionResponse.body.data.version).toEqual(
      expect.objectContaining({
        version: 2,
        sizeBytes: v2.length,
        mimeType: "text/plain",
        originalFilename: "integration-v2.txt",
      })
    );

    const detailResponse = await request(app)
      .get(`/v1/workspaces/${workspaceId}/documents/${documentId}`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .expect(200);

    expect(detailResponse.body.data.document.versions).toHaveLength(2);
    expect(detailResponse.body.data.document.versions[1]).toEqual(
      expect.objectContaining({
        originalFilename: "integration-v2.txt",
      })
    );

    const listResponse = await request(app)
      .get(`/v1/workspaces/${workspaceId}/documents`)
      .query({ limit: 1, offset: 0 })
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .expect(200);

    expect(listResponse.body.data.pagination).toEqual(
      expect.objectContaining({
        limit: 1,
        offset: 0,
      })
    );
    expect(listResponse.body.data.documents).toHaveLength(1);

    const downloadResponse = await request(app)
      .get(`/v1/workspaces/${workspaceId}/documents/${documentId}/versions/2/download`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .expect(200);

    expect(downloadResponse.text).toBe(v2.toString("utf8"));
    expect(downloadResponse.headers["content-type"]).toContain("text/plain");
    expect(downloadResponse.headers["content-disposition"]).toContain(
      "integration-v2.txt"
    );

    const auditLogs = await prisma.auditLog.findMany({
      where: {
        workspaceId,
        entityId: {
          in: [
            documentId,
            uploadResponse.body.data.version.id as string,
            versionResponse.body.data.version.id as string,
          ],
        },
      },
      select: { action: true },
    });

    expect(auditLogs.map((log) => log.action)).toEqual(
      expect.arrayContaining([
        "document.created",
        "document_version.created",
        "document_version.downloaded",
      ])
    );

    const auditResponse = await request(app)
      .get(`/v1/workspaces/${workspaceId}/audit-logs`)
      .query({ limit: 10, offset: 0 })
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .expect(200);

    expect(auditResponse.body.data.pagination).toEqual(
      expect.objectContaining({
        limit: 10,
        offset: 0,
      })
    );
    expect(auditResponse.body.data.auditLogs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "document_version.downloaded",
          actorEmail: `${runId}-docs-owner@example.com`,
        }),
      ])
    );
  });

  it("supports the full plain-text proposed change workflow", async () => {
    const owner = await registerUser(`${runId}-governance-owner@example.com`);
    const workspaceId = await createWorkspace(owner.accessToken, `${runId} Governance Workspace`);
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

    await request(app)
      .post(`/v1/workspaces/${workspaceId}/documents/${documentId}/proposed-changes/${proposedChangeId}/publish`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .expect(400);

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

    await request(app)
      .post(`/v1/workspaces/${workspaceId}/documents/${documentId}/proposed-changes/${proposedChangeId}/publish`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .expect(400);

    const reviewResponse = await request(app)
      .post(`/v1/workspaces/${workspaceId}/documents/${documentId}/proposed-changes/${proposedChangeId}/reviews`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .send({
        state: "approved",
        body: "Approved for publishing.",
      })
      .expect(201);

    expect(reviewResponse.body.data).toEqual(
      expect.objectContaining({
        proposedChangeStatus: "approved",
        review: expect.objectContaining({
          state: "approved",
          body: "Approved for publishing.",
        }),
      })
    );

    const publishResponse = await request(app)
      .post(`/v1/workspaces/${workspaceId}/documents/${documentId}/proposed-changes/${proposedChangeId}/publish`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .expect(201);

    const publishedVersion = publishResponse.body.data.version;
    createdBlobHashes.push(publishedVersion.sha256 as string);
    expect(publishedVersion).toEqual(
      expect.objectContaining({
        version: 2,
        mimeType: "text/plain",
        originalFilename: "policy-document-v2.txt",
      })
    );

    await request(app)
      .post(`/v1/workspaces/${workspaceId}/documents/${documentId}/proposed-changes/${proposedChangeId}/publish`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .expect(400);

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

    expect(downloadResponse.text).toBe(approvedText);
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
      "Binary Document",
      Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00]),
      "binary.pdf",
      "application/pdf"
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
});
