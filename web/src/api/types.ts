export type ApiEnvelope<T> = {
  ok: true;
  data: T;
} | {
  ok: false;
  error: {
    code: string;
    message: string;
    requestId?: string;
  };
};

export type User = {
  id: string;
  email: string;
};

export type Workspace = {
  id: string;
  name: string;
  role: "admin" | "member";
  createdAt: string;
};

export type SearchStatus = {
  status: string;
  indexedAt: string;
  error: string | null;
} | null;

export type DocumentVersion = {
  id: string;
  version: number;
  sha256: string;
  sizeBytes: number;
  mimeType: string;
  originalFilename: string | null;
  createdAt: string;
  search: SearchStatus;
};

export type ArchiveDocument = {
  id: string;
  workspaceId: string;
  title: string;
  createdAt: string;
  latestVersion?: DocumentVersion | null;
  versions?: DocumentVersion[];
};

export type Pagination = {
  limit: number;
  offset: number;
  nextOffset: number | null;
};

export type SearchResult = {
  document: ArchiveDocument;
  version: DocumentVersion;
  search: {
    status: string;
    indexedAt: string;
    snippet: string | null;
  };
};

export type AuditLog = {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  actorId: string | null;
  actorEmail: string | null;
  ip: string | null;
  userAgent: string | null;
  metadata: unknown;
  createdAt: string;
};
