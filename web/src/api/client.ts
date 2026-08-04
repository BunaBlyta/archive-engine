import type {
  ApiEnvelope,
  ArchiveDocument,
  AuditLog,
  Pagination,
  SearchResult,
  User,
  Workspace,
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
  register(email: string, password: string) {
    return apiRequest<{ accessToken: string; user: User }>("/v1/auth/register", {
      method: "POST",
      body: JSON.stringify({ email, password }),
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

  addMember(token: string, workspaceId: string, email: string, role: "admin" | "member") {
    return apiRequest<{ member: { userId: string; email: string; role: string; createdAt: string } }>(
      `/v1/workspaces/${workspaceId}/members`,
      {
        method: "POST",
        body: JSON.stringify({ email, role }),
      },
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

  uploadVersion(token: string, workspaceId: string, documentId: string, file: File) {
    const form = new FormData();
    form.set("file", file);

    return apiRequest<{ document: ArchiveDocument }>(
      `/v1/workspaces/${workspaceId}/documents/${documentId}/versions`,
      { method: "POST", body: form },
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
};
