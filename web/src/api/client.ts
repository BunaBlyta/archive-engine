import type {
  ApiEnvelope,
  ArchiveDocument,
  AuditLog,
  DocumentDraft,
  DocumentTask,
  DocumentVersion,
  LineComment,
  Pagination,
  ProposedChange,
  ProposedChangeDetail,
  OnlyOfficeEditorConfig,
  Review,
  SearchResult,
  User,
  Workspace,
  WorkspaceDashboardMember,
  WorkspaceMember,
} from "./types";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3000";

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public requestId?: string
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function parseResponse<T>(response: Response): Promise<T> {
  const body = (await response.json()) as ApiEnvelope<T>;

  if (!body.ok) {
    throw new ApiError(body.error.code, body.error.message, body.error.requestId);
  }

  return body.data;
}

async function apiRequest<T>(
  path: string,
  options: RequestInit = {},
  token?: string | null
) {
  const headers = new Headers(options.headers);

  if (!(options.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers,
    credentials: "include",
  });

  return parseResponse<T>(response);
}

export const api = {
  register(email: string, password: string, firstName: string, lastName: string) {
    return apiRequest<{ accessToken: string; user: User }>("/v1/auth/register", {
      method: "POST",
      body: JSON.stringify({ email, password, firstName, lastName }),
    });
  },

  login(email: string, password: string) {
    return apiRequest<{ accessToken: string; user: User }>("/v1/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
  },

  refresh() {
    return apiRequest<{ accessToken: string }>("/v1/auth/refresh", {
      method: "POST",
    });
  },

  logout() {
    return apiRequest<unknown>("/v1/auth/logout", {
      method: "POST",
    });
  },

  listWorkspaces(token: string) {
    return apiRequest<{ workspaces: Workspace[] }>("/v1/workspaces", {}, token);
  },

  createWorkspace(token: string, name: string) {
    return apiRequest<{ workspace: Workspace }>("/v1/workspaces", {
      method: "POST",
      body: JSON.stringify({ name }),
    }, token);
  },

  addMember(token: string, workspaceId: string, email: string, role: "admin" | "reviewer") {
    return apiRequest<{ member: { userId: string; email: string; role: string; createdAt: string } }>(
      `/v1/workspaces/${workspaceId}/members`,
      {
        method: "POST",
        body: JSON.stringify({ email, role }),
      },
      token
    );
  },

  listMembers(token: string, workspaceId: string) {
    return apiRequest<{ members: WorkspaceMember[] }>(
      `/v1/workspaces/${workspaceId}/members`,
      {},
      token
    );
  },

  listDocuments(token: string, workspaceId: string, offset = 0, limit = 25) {
    return apiRequest<{ pagination: Pagination; documents: ArchiveDocument[] }>(
      `/v1/workspaces/${workspaceId}/documents?limit=${limit}&offset=${offset}`,
      {},
      token
    );
  },

  getDocument(token: string, workspaceId: string, documentId: string) {
    return apiRequest<{ document: ArchiveDocument }>(
      `/v1/workspaces/${workspaceId}/documents/${documentId}`,
      {},
      token
    );
  },

  uploadDocument(token: string, workspaceId: string, title: string, file: File) {
    const form = new FormData();
    form.set("title", title);
    form.set("file", file);

    return apiRequest<{ document: ArchiveDocument }>(
      `/v1/workspaces/${workspaceId}/documents`,
      { method: "POST", body: form },
      token
    );
  },

  renameDocument(token: string, workspaceId: string, documentId: string, title: string) {
    return apiRequest<{ document: ArchiveDocument }>(
      `/v1/workspaces/${workspaceId}/documents/${documentId}`,
      {
        method: "PATCH",
        body: JSON.stringify({ title }),
      },
      token
    );
  },

  archiveDocument(token: string, workspaceId: string, documentId: string) {
    return apiRequest<{ document: { id: string; archivedAt: string } }>(
      `/v1/workspaces/${workspaceId}/documents/${documentId}`,
      { method: "DELETE" },
      token
    );
  },

  createDraft(token: string, workspaceId: string, documentId: string) {
    return apiRequest<{ draft: DocumentDraft }>(
      `/v1/workspaces/${workspaceId}/documents/${documentId}/drafts`,
      { method: "POST" },
      token
    );
  },

  getDraft(token: string, workspaceId: string, documentId: string, draftId: string) {
    return apiRequest<{ draft: DocumentDraft }>(
      `/v1/workspaces/${workspaceId}/documents/${documentId}/drafts/${draftId}`,
      {},
      token
    );
  },

  discardDraft(token: string, workspaceId: string, documentId: string, draftId: string) {
    return apiRequest<{ draft: DocumentDraft }>(
      `/v1/workspaces/${workspaceId}/documents/${documentId}/drafts/${draftId}/discard`,
      { method: "POST" },
      token
    );
  },

  updateDraftContent(token: string, workspaceId: string, documentId: string, draftId: string, content: string) {
    return apiRequest<{ draft: DocumentDraft }>(
      `/v1/workspaces/${workspaceId}/documents/${documentId}/drafts/${draftId}`,
      {
        method: "PATCH",
        body: JSON.stringify({ content }),
      },
      token
    );
  },

  getDraftEditorConfig(token: string, workspaceId: string, documentId: string, draftId: string) {
    return apiRequest<{ editor: OnlyOfficeEditorConfig }>(
      `/v1/workspaces/${workspaceId}/documents/${documentId}/drafts/${draftId}/editor-config`,
      {},
      token
    );
  },

  forceSaveDraftEditor(token: string, workspaceId: string, documentId: string, draftId: string) {
    return apiRequest<{ requested: boolean }>(
      `/v1/workspaces/${workspaceId}/documents/${documentId}/drafts/${draftId}/editor/force-save`,
      { method: "POST" },
      token
    );
  },

  proposeDraft(token: string, workspaceId: string, documentId: string, draftId: string, summary?: string) {
    return apiRequest<{ proposedChange: ProposedChange }>(
      `/v1/workspaces/${workspaceId}/documents/${documentId}/drafts/${draftId}/propose`,
      {
        method: "POST",
        body: JSON.stringify(summary?.trim() ? { summary: summary.trim() } : {}),
      },
      token
    );
  },

  getProposedChange(token: string, workspaceId: string, documentId: string, proposedChangeId: string) {
    return apiRequest<ProposedChangeDetail>(
      `/v1/workspaces/${workspaceId}/documents/${documentId}/proposed-changes/${proposedChangeId}`,
      {},
      token
    );
  },

  createReview(
    token: string,
    workspaceId: string,
    documentId: string,
    proposedChangeId: string,
    state: "approved" | "changes_requested" | "commented",
    body?: string
  ) {
    return apiRequest<{ review: Review; proposedChangeStatus: string; version: DocumentVersion | null }>(
      `/v1/workspaces/${workspaceId}/documents/${documentId}/proposed-changes/${proposedChangeId}/reviews`,
      {
        method: "POST",
        body: JSON.stringify({ state, ...(body ? { body } : {}) }),
      },
      token
    );
  },

  createLineComment(
    token: string,
    workspaceId: string,
    documentId: string,
    proposedChangeId: string,
    diffLineIndex: number,
    body: string
  ) {
    return apiRequest<{ comment: LineComment }>(
      `/v1/workspaces/${workspaceId}/documents/${documentId}/proposed-changes/${proposedChangeId}/comments`,
      { method: "POST", body: JSON.stringify({ diffLineIndex, body }) },
      token
    );
  },

  abandonProposedChange(token: string, workspaceId: string, documentId: string, proposedChangeId: string) {
    return apiRequest<{ proposedChange: ProposedChange }>(
      `/v1/workspaces/${workspaceId}/documents/${documentId}/proposed-changes/${proposedChangeId}/abandon`,
      { method: "POST" },
      token
    );
  },

  searchDocuments(token: string, workspaceId: string, query: string, offset = 0, limit = 25) {
    const params = new URLSearchParams({
      q: query,
      limit: String(limit),
      offset: String(offset),
    });

    return apiRequest<{ pagination: Pagination; results: SearchResult[] }>(
      `/v1/workspaces/${workspaceId}/documents/search?${params}`,
      {},
      token
    );
  },

  listTasks(token: string, workspaceId: string, documentId: string) {
    return apiRequest<{ tasks: DocumentTask[] }>(
      `/v1/workspaces/${workspaceId}/documents/${documentId}/tasks`,
      {},
      token
    );
  },

  createTask(token: string, workspaceId: string, documentId: string, title: string, assigneeId: string) {
    return apiRequest<{ task: DocumentTask }>(
      `/v1/workspaces/${workspaceId}/documents/${documentId}/tasks`,
      { method: "POST", body: JSON.stringify({ title, assigneeId }) },
      token
    );
  },

  completeTask(token: string, workspaceId: string, documentId: string, taskId: string) {
    return apiRequest<{ task: DocumentTask }>(
      `/v1/workspaces/${workspaceId}/documents/${documentId}/tasks/${taskId}`,
      { method: "PATCH", body: JSON.stringify({ status: "done" }) },
      token
    );
  },

  getDashboard(token: string, workspaceId: string) {
    return apiRequest<{ members: WorkspaceDashboardMember[] }>(
      `/v1/workspaces/${workspaceId}/dashboard`,
      {},
      token
    );
  },

  listAuditLogs(token: string, workspaceId: string, offset = 0, limit = 25) {
    return apiRequest<{ pagination: Pagination; auditLogs: AuditLog[] }>(
      `/v1/workspaces/${workspaceId}/audit-logs?limit=${limit}&offset=${offset}`,
      {},
      token
    );
  },

  downloadUrl(workspaceId: string, documentId: string, version: number) {
    return `${API_BASE_URL}/v1/workspaces/${workspaceId}/documents/${documentId}/versions/${version}/download`;
  },

  previewUrl(workspaceId: string, documentId: string, version: number) {
    return `${API_BASE_URL}/v1/workspaces/${workspaceId}/documents/${documentId}/versions/${version}/preview`;
  },

  async getVersionEditorConfig(token: string, workspaceId: string, documentId: string, version: number) {
    return apiRequest<{ editor: OnlyOfficeEditorConfig }>(
      `/v1/workspaces/${workspaceId}/documents/${documentId}/versions/${version}/editor-config`,
      {},
      token
    );
  },

  async exportVersionAsPdf(token: string, workspaceId: string, documentId: string, version: number) {
    const response = await fetch(
      `${API_BASE_URL}/v1/workspaces/${workspaceId}/documents/${documentId}/versions/${version}/export-pdf`,
      { headers: { Authorization: `Bearer ${token}` }, credentials: "include" }
    );

    if (!response.ok) {
      await parseResponse<never>(response);
    }

    const disposition = response.headers.get("Content-Disposition") ?? "";
    const filename = disposition.match(/filename="([^"]+)"/)?.[1] ?? `document-v${version}.pdf`;
    const blob = await response.blob();

    return { blob, filename };
  },

  async downloadVersion(token: string, workspaceId: string, documentId: string, version: number) {
    const response = await fetch(api.downloadUrl(workspaceId, documentId, version), {
      headers: {
        Authorization: `Bearer ${token}`,
      },
      credentials: "include",
    });

    if (!response.ok) {
      await parseResponse<never>(response);
    }

    const disposition = response.headers.get("Content-Disposition") ?? "";
    const filename = disposition.match(/filename="([^"]+)"/)?.[1] ?? `document-v${version}`;
    const blob = await response.blob();

    return { blob, filename };
  },

  async previewVersion(token: string, workspaceId: string, documentId: string, version: number) {
    const response = await fetch(api.previewUrl(workspaceId, documentId, version), {
      headers: {
        Authorization: `Bearer ${token}`,
      },
      credentials: "include",
    });

    if (!response.ok) {
      await parseResponse<never>(response);
    }

    const disposition = response.headers.get("Content-Disposition") ?? "";
    const filename = disposition.match(/filename="([^"]+)"/)?.[1] ?? `document-v${version}`;
    const blob = await response.blob();

    return { blob, filename };
  },
};
