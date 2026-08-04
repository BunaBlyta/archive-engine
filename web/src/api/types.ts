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

export type WorkspaceMember = {
  userId: string;
  email: string;
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

export type DocumentDraft = {
  id: string;
  workspaceId: string;
  documentId: string;
  baseVersionId: string;
  title: string;
  content: string;
  status: "draft" | "proposed" | "published" | "abandoned" | string;
  createdById: string | null;
  createdAt: string;
  updatedAt: string;
};

export type DocumentDraftMetadata = Omit<DocumentDraft, "content">;

export type ProposedChange = {
  id: string;
  workspaceId: string;
  documentId: string;
  draftId: string;
  status: "open" | "approved" | "changes_requested" | "published" | "closed" | string;
  summary: string | null;
  openedById: string | null;
  openedAt: string;
  closedAt: string | null;
};

export type Review = {
  id: string;
  workspaceId: string;
  proposedChangeId: string;
  reviewerId: string | null;
  state: "approved" | "changes_requested" | "commented" | string;
  body: string | null;
  createdAt: string;
};

export type LineDiffLine = {
  type: "unchanged" | "added" | "removed";
  oldLineNumber: number | null;
  newLineNumber: number | null;
  text: string;
};

export type ProposedChangeDiff =
  | { type: "line"; lines: LineDiffLine[] }
  | { type: "too_large" };

export type ProposedChangeDetail = {
  proposedChange: ProposedChange;
  draft: DocumentDraftMetadata;
  baseVersion: DocumentVersion;
  baseContent: string;
  draftContent: string;
  diff: ProposedChangeDiff;
  reviews: Review[];
};

export type ArchiveDocument = {
  id: string;
  workspaceId: string;
  title: string;
  createdAt: string;
  archivedAt?: string | null;
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
