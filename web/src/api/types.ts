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
  firstName: string | null;
  lastName: string | null;
};

export type UserRef = {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
};

export type Workspace = {
  id: string;
  name: string;
  role: "admin" | "reviewer";
  createdAt: string;
};

export type WorkspaceMember = {
  userId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  role: "admin" | "reviewer";
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
  createdBy: UserRef | null;
  search: SearchStatus;
};

export type DocumentDraft = {
  id: string;
  workspaceId: string;
  documentId: string;
  baseVersionId: string;
  title: string;
  content: string;
  contentFormat: "plain" | "markdown" | string;
  status: "draft" | "proposed" | "published" | "abandoned" | string;
  editorKey: string | null;
  artifactSha256: string | null;
  artifactSizeBytes: number | null;
  artifactMimeType: string | null;
  artifactOriginalFilename: string | null;
  createdById: string | null;
  createdAt: string;
  updatedAt: string;
};

export type DocumentDraftMetadata = Omit<DocumentDraft, "content">;

export type OnlyOfficeEditorConfig = {
  documentServerUrl: string;
  document: {
    fileType: "docx";
    key: string;
    title: string;
    url: string;
    permissions: { edit: boolean; download: boolean; review: boolean };
  };
  documentType: "word";
  editorConfig: {
    mode: "edit" | "view";
    callbackUrl?: string;
    user?: { id: string; name: string };
    customization: { compactHeader: boolean };
  };
  token: string;
};

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
  reviewer: UserRef | null;
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

export type LineComment = {
  id: string;
  diffLineIndex: number;
  body: string;
  createdAt: string;
  author: UserRef | null;
};

export type ProposedChangeDetail = {
  proposedChange: ProposedChange;
  draft: DocumentDraftMetadata;
  baseVersion: DocumentVersion;
  baseContent: string;
  draftContent: string;
  diff: ProposedChangeDiff;
  docxHiddenChanges: string[];
  reviews: Review[];
  comments: LineComment[];
};

export type ArchiveDocument = {
  id: string;
  workspaceId: string;
  title: string;
  createdAt: string;
  archivedAt?: string | null;
  latestVersion?: DocumentVersion | null;
  versions?: DocumentVersion[];
  openProposedChange?: { id: string; status: string } | null;
  activeDraft?: { id: string; createdById: string | null; updatedAt: string } | null;
};

export type DocumentTask = {
  id: string;
  documentId: string;
  title: string;
  status: "open" | "done" | string;
  createdAt: string;
  completedAt: string | null;
  assignee: UserRef | null;
  createdBy: UserRef | null;
};

export type WorkspaceDashboardMember = {
  userId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  role: "admin" | "reviewer";
  createdAt: string;
  contributionCount: number;
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
  actorFirstName: string | null;
  actorLastName: string | null;
  ip: string | null;
  userAgent: string | null;
  metadata: unknown;
  createdAt: string;
};
