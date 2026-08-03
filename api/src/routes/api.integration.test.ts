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
      })
    );

    const detailResponse = await request(app)
      .get(`/v1/workspaces/${workspaceId}/documents/${documentId}`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .expect(200);

    expect(detailResponse.body.data.document.versions).toHaveLength(2);

    const downloadResponse = await request(app)
      .get(`/v1/workspaces/${workspaceId}/documents/${documentId}/versions/2/download`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .expect(200);

    expect(downloadResponse.text).toBe(v2.toString("utf8"));
    expect(downloadResponse.headers["content-type"]).toContain("text/plain");
  });
});
