import { ApiError } from "../api/client";
import type { ArchiveDocument } from "../api/types";
import { SUPPORTED_UPLOAD_ACCEPT, WORD_MIME } from "./constants";

// Every action the API writes has a label here. Four did not, so the audit log showed raw
// strings like "proposed_change.revised" beside readable ones. The scheme is "<Thing> <verbed>",
// and the verbs match the buttons that cause them — a log that calls something "discarded" when
// the button said "Discard" is one you can actually follow. api/src/routes/auditActions.test.ts
// fails if the two lists drift apart.
const AUDIT_ACTION_LABELS: Record<string, string> = {
  "document.created": "Document created",
  "document.renamed": "Document renamed",
  "document.archived": "Document archived",
  "document_version.downloaded": "Version downloaded",
  "document_version.exported": "Version exported",
  "document_draft.created": "Draft created",
  "document_draft.updated": "Draft edited",
  "document_draft.docx_saved": "Draft saved",
  "document_draft.discarded": "Draft discarded",
  "proposed_change.opened": "Change proposed",
  "proposed_change.commented": "Change commented",
  "proposed_change.reviewed": "Change reviewed",
  "proposed_change.revised": "Change revised",
  "proposed_change.published": "Change published",
  "proposed_change.withdrawn": "Change withdrawn to draft",
  "proposed_change.abandoned": "Change discarded",
  "document_task.created": "Task created",
  "document_task.completed": "Task completed",
  "membership.created": "Member added",
};

export function errorMessage(error: unknown) {
  if (error instanceof ApiError) {
    return error.requestId ? `${error.message} (${error.requestId})` : error.message;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return "Something went wrong";
}

export function statusTone(status?: string | null): "neutral" | "green" | "amber" | "red" | "blue" {
  if (status === "indexed") return "green";
  if (status === "failed") return "red";
  if (status === "pending") return "amber";
  if (status === "processing") return "blue";
  return "neutral";
}

export function searchStatusLabel(status?: string | null) {
  if (status === "indexed") return "searchable";
  if (status === "failed") return "index failed";
  if (status === "pending") return "index pending";
  if (status === "processing") return "indexing";
  if (status === "unsupported") return "not searchable";
  return "not indexed";
}

export function auditActionLabel(action: string) {
  return AUDIT_ACTION_LABELS[action] ?? action;
}

export function proposalStatusLabel(status?: string | null) {
  if (status === "open") return "Proposed change: awaiting review";
  if (status === "changes_requested") return "Changes requested";
  if (status === "approved") return "Approved";
  if (status === "published") return "Published";
  return status ?? "Unknown";
}

export function isTextPreview(mimeType: string) {
  return (
    mimeType.startsWith("text/") ||
    mimeType === "application/json" ||
    mimeType.endsWith("+json") ||
    mimeType === "application/xml" ||
    mimeType.endsWith("+xml")
  );
}

export function isEditableTextMimeType(mimeType: string) {
  const normalized = mimeType.toLowerCase();
  return normalized === "text/plain" || normalized === "text/markdown" || normalized === WORD_MIME;
}

export function isSupportedUploadFile(file: File) {
  const name = file.name.toLowerCase();
  const type = file.type.toLowerCase();
  const dot = name.lastIndexOf(".");
  const extension = dot === -1 ? "" : name.slice(dot);

  if (extension) {
    return extension === ".txt" || extension === ".md" || extension === ".markdown" || extension === ".docx";
  }

  return (
    type === "text/plain" ||
    type === "text/markdown" ||
    type === WORD_MIME
  );
}

export function previewKind(mimeType: string): "text" | "html" | "unsupported" {
  if (isTextPreview(mimeType)) return "text";
  if (mimeType.toLowerCase() === WORD_MIME) return "html";
  return "unsupported";
}

export function latestVersion(document: ArchiveDocument) {
  return document.latestVersion ?? document.versions?.[document.versions.length - 1] ?? null;
}
