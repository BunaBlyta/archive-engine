import { api } from "../../api/client";
import type { ArchiveDocument, DocumentDraft, DocumentTask, OnlyOfficeEditorConfig, ProposedChangeDetail, Workspace, WorkspaceMember } from "../../api/types";
import { EmptyState } from "../../components/EmptyState";
import { OnlyOfficeEditor } from "../../components/OnlyOfficeEditor";
import { Button } from "../../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "../../components/ui/dialog";
import { WORD_MIME } from "../../lib/constants";
import { errorMessage, isEditableTextMimeType, latestVersion } from "../../lib/format";
import type { DocumentViewMode, Notice } from "../../lib/types";
import { cn, displayName } from "../../lib/utils";
import { ProposedChangeDiffView } from "../review/ProposedChangeDiffView";
import { RequestChangesDialog } from "../review/RequestChangesDialog";
import { TasksPanel } from "../tasks/TasksPanel";
import { ArchiveDocumentDialog } from "./ArchiveDocumentDialog";
import { VersionPreviewContent } from "./VersionPreviewContent";
import { VersionRow } from "./VersionRow";
import { ArrowDownToLine, Eye, FileDown, FileText, History, Loader2, Pencil, Save, Shield, Trash2, Undo2, Upload, X } from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";

// Loaded on demand: tiptap is the largest chunk in the app and most sessions never open it.
const MarkdownWysiwygEditor = lazy(() => import("../../components/MarkdownWysiwygEditor"));

export function DocumentFocusView({
  token,
  workspace,
  document,
  currentUserId,
  onChanged,
  onArchived,
  onError,
  onNotice,
}: {
  token: string;
  workspace: Workspace;
  document: ArchiveDocument | null;
  currentUserId: string | null;
  onChanged: () => Promise<void>;
  onArchived: () => void;
  onError: (message: string) => void;
  onNotice: (notice: Notice) => void;
}) {
  const [mode, setMode] = useState<DocumentViewMode>("versions");
  const [draft, setDraft] = useState<DocumentDraft | null>(null);
  const [content, setContent] = useState("");
  const [summary, setSummary] = useState("");
  const [detail, setDetail] = useState<ProposedChangeDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const [downloadBusy, setDownloadBusy] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const [editorConfig, setEditorConfig] = useState<OnlyOfficeEditorConfig | null>(null);
  const [discardProposalOpen, setDiscardProposalOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const [tasks, setTasks] = useState<DocumentTask[]>([]);
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [tasksLoading, setTasksLoading] = useState(false);

  useEffect(() => {
    setMode("versions");
    setDraft(null);
    setContent("");
    setSummary("");
    setDetail(null);
    setSelectedVersionId(null);
    setEditorConfig(null);
  }, [document?.id]);

  async function loadTasks(documentId: string) {
    setTasksLoading(true);
    try {
      const [taskData, memberData] = await Promise.all([
        api.listTasks(token, workspace.id, documentId),
        api.listMembers(token, workspace.id),
      ]);
      setTasks(taskData.tasks);
      setMembers(memberData.members);
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setTasksLoading(false);
    }
  }

  useEffect(() => {
    if (document?.id) void loadTasks(document.id);
  }, [document?.id]);

  async function createTask(title: string, assigneeId: string) {
    if (!document) return;
    await api.createTask(token, workspace.id, document.id, title, assigneeId);
    await loadTasks(document.id);
    onNotice({ title: "Task created" });
  }

  async function completeTask(taskId: string) {
    if (!document) return;
    try {
      await api.completeTask(token, workspace.id, document.id, taskId);
      await loadTasks(document.id);
    } catch (error) {
      onError(errorMessage(error));
    }
  }

  if (!document) {
    return (
      <div className="flex min-h-[20rem] items-center justify-center text-sm text-neutral-500">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        Loading document
      </div>
    );
  }

  // Capture after null guard so TypeScript knows doc is non-null in closures below
  const doc = document;
  const newestVersion = latestVersion(doc);
  const selectedVersion =
    doc.versions?.find((version) => version.id === selectedVersionId) ?? newestVersion;
  const openProposal = doc.openProposedChange;
  const activeDraft = doc.activeDraft ?? null;
  // The API lets only the draft's author (or an admin) resume or discard it, so offering those
  // actions to anyone else produces a button that always fails.
  const canEditActiveDraft =
    activeDraft !== null &&
    (activeDraft.createdById === currentUserId || workspace.role === "admin");
  const hasVersions = (doc.versions?.length ?? 0) > 0;
  const hasTasks = tasks.length > 0;
  const canEditCurrentVersion = newestVersion ? isEditableTextMimeType(newestVersion.mimeType) : false;
  const canPropose =
    Boolean(newestVersion) &&
    canEditCurrentVersion &&
    !openProposal;
  const isOwnProposal = Boolean(currentUserId) && detail?.proposedChange.openedById === currentUserId;
  const isPublished = detail?.proposedChange.status === "published";

  async function loadDraftForEditing(nextDraft: DocumentDraft) {
    setDraft(nextDraft);
    setContent(nextDraft.content);
    if (nextDraft.artifactMimeType === WORD_MIME) {
      const config = await api.getDraftEditorConfig(token, workspace.id, doc.id, nextDraft.id);
      setEditorConfig(config.editor);
    } else {
      setEditorConfig(null);
    }
    setMode("editing");
  }

  async function startDraft() {
    setBusy(true);
    setBusyLabel("Creating draft");
    try {
      const data = await api.createDraft(token, workspace.id, doc.id);
      await loadDraftForEditing(data.draft);
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setBusy(false);
      setBusyLabel(null);
    }
  }

  // An unproposed draft holds the document's one active slot, so it has to be reachable
  // again after a reload — otherwise it silently blocks every later attempt to edit.
  async function resumeDraft(draftId: string) {
    setBusy(true);
    setBusyLabel("Opening draft");
    try {
      const data = await api.getDraft(token, workspace.id, doc.id, draftId);
      await loadDraftForEditing(data.draft);
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setBusy(false);
      setBusyLabel(null);
    }
  }

  async function discardActiveDraft() {
    if (!activeDraft) return;
    setBusy(true);
    setBusyLabel("Discarding draft");
    try {
      await api.discardDraft(token, workspace.id, doc.id, activeDraft.id);
      setDraft(null);
      setContent("");
      setEditorConfig(null);
      setMode("versions");
      await onChanged();
      onNotice({ title: "Draft discarded" });
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setBusy(false);
      setBusyLabel(null);
    }
  }

  async function loadProposedChange(proposedChangeId: string) {
    const data = await api.getProposedChange(token, workspace.id, doc.id, proposedChangeId);
    setDetail(data);
    setMode("review");
  }

  async function saveDraft() {
    if (!draft || !content.trim()) return;
    setBusy(true);
    setBusyLabel("Saving");
    try {
      await saveCurrentDraft();
      onNotice({ title: "Draft saved" });
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setBusy(false);
      setBusyLabel(null);
    }
  }

  async function saveCurrentDraft() {
    if (!draft) throw new Error("Draft is not loaded");

    if (draft.artifactMimeType === WORD_MIME) {
      const previousUpdatedAt = draft.updatedAt;
      await api.forceSaveDraftEditor(token, workspace.id, doc.id, draft.id);

      for (let attempt = 0; attempt < 12; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 500));
        const latest = await api.getDraft(token, workspace.id, doc.id, draft.id);
        if (latest.draft.updatedAt !== previousUpdatedAt || latest.draft.artifactSha256 !== draft.artifactSha256) {
          setDraft(latest.draft);
          setContent(latest.draft.content);
          return latest.draft;
        }
      }

      throw new Error("ONLYOFFICE did not finish saving the DOCX draft. Try again.");
    }

    const updated = await api.updateDraftContent(token, workspace.id, doc.id, draft.id, content);
    setDraft(updated.draft);
    return updated.draft;
  }

  async function submitForReview(event: React.FormEvent) {
    event.preventDefault();
    if (!draft || !content.trim()) return;
    setBusy(true);
    setBusyLabel("Submitting");
    try {
      const updated = await saveCurrentDraft();
      if (updated.status === "draft") {
        const proposed = await api.proposeDraft(token, workspace.id, doc.id, updated.id, summary);
        await loadProposedChange(proposed.proposedChange.id);
        onNotice({ title: "Proposed change opened" });
      } else if (detail) {
        await loadProposedChange(detail.proposedChange.id);
        onNotice({ title: "Changes resubmitted" });
      }
      await onChanged();
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setBusy(false);
      setBusyLabel(null);
    }
  }

  async function approve() {
    if (!detail) return;
    setBusy(true);
    setBusyLabel("Approving and publishing");
    try {
      await api.createReview(token, workspace.id, doc.id, detail.proposedChange.id, "approved", "Approved");
      await loadProposedChange(detail.proposedChange.id);
      await onChanged();
      onNotice({ title: "Proposed change published" });
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setBusy(false);
      setBusyLabel(null);
    }
  }

  async function requestChanges(message: string) {
    if (!detail) return;
    setBusy(true);
    setBusyLabel("Requesting changes");
    try {
      await api.createReview(token, workspace.id, doc.id, detail.proposedChange.id, "changes_requested", message);
      await loadProposedChange(detail.proposedChange.id);
      await onChanged();
      onNotice({ title: "Changes requested" });
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setBusy(false);
      setBusyLabel(null);
    }
  }

  async function reviseRequestedChanges() {
    if (!detail) return;
    setBusy(true);
    setBusyLabel("Loading draft");
    try {
      const data = await api.getDraft(token, workspace.id, doc.id, detail.draft.id);
      await loadDraftForEditing(data.draft);
      setSummary(detail.proposedChange.summary ?? "");
      setMode("editing");
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setBusy(false);
      setBusyLabel(null);
    }
  }

  // The authorship counterpart to a reviewer's "request changes": back to an editable draft
  // with no review recorded. Distinct from abandon, which closes the proposal for good.
  async function returnToDraft() {
    if (!detail) return;
    setBusy(true);
    setBusyLabel("Withdrawing");
    try {
      const data = await api.withdrawProposedChange(token, workspace.id, doc.id, detail.proposedChange.id);
      setDetail(null);
      await onChanged();
      await loadDraftForEditing(data.draft);
      onNotice({ title: "Withdrawn to draft", description: "Edit and propose it again when you're ready." });
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setBusy(false);
      setBusyLabel(null);
    }
  }

  async function abandon() {
    if (!detail) return;
    setBusy(true);
    setBusyLabel("Discarding proposal");
    try {
      await api.abandonProposedChange(token, workspace.id, doc.id, detail.proposedChange.id);
      await onChanged();
      setDiscardProposalOpen(false);
      setMode("versions");
      setDetail(null);
      onNotice({ title: "Proposal discarded" });
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setBusy(false);
      setBusyLabel(null);
    }
  }

  // Word is excluded server-side: converting it faithfully needs a real converter, and the
  // ONLYOFFICE editor already exports to PDF itself.
  const canExportPdf =
    selectedVersion?.mimeType === "text/markdown" || selectedVersion?.mimeType === "text/plain";

  async function exportSelectedVersionAsPdf() {
    if (!selectedVersion) return;
    setExportBusy(true);
    try {
      const { blob, filename } = await api.exportVersionAsPdf(
        token,
        workspace.id,
        doc.id,
        selectedVersion.version
      );
      const url = URL.createObjectURL(blob);
      const link = window.document.createElement("a");
      link.href = url;
      link.download = filename;
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setExportBusy(false);
    }
  }

  async function downloadSelectedVersion() {
    if (!selectedVersion) return;
    setDownloadBusy(true);
    try {
      const { blob, filename } = await api.downloadVersion(token, workspace.id, doc.id, selectedVersion.version);
      const url = URL.createObjectURL(blob);
      const link = window.document.createElement("a");
      link.href = url;
      link.download = filename;
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setDownloadBusy(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {mode === "editing" && draft ? (
        <form onSubmit={submitForReview} className="grid min-h-0 flex-1 grid-rows-[auto_1fr] gap-3 xl:grid-cols-[minmax(0,1fr)_19rem]">
          <h4 className="shrink-0 text-base">Edit draft</h4>
          <h4 className="shrink-0 text-base">Summary</h4>
          <div className="min-h-0 min-w-0">
            <div className="flex h-full min-h-0 flex-col rounded-2xl bg-white p-5">
              {draft.artifactMimeType === WORD_MIME ? (
                editorConfig ? (
                  <OnlyOfficeEditor config={editorConfig} className="h-full min-h-[28rem] rounded-lg border border-neutral-100" />
                ) : (
                  <div className="flex h-full min-h-[28rem] items-center justify-center rounded-lg border border-neutral-100 bg-white text-sm text-neutral-500">
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Loading Word editor
                  </div>
                )
              ) : draft.contentFormat === "markdown" ? (
                <Suspense
                  fallback={
                    <div className="flex h-full min-h-[28rem] items-center justify-center rounded-lg border border-neutral-100 bg-white text-sm text-neutral-500">
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Loading editor
                    </div>
                  }
                >
                  <MarkdownWysiwygEditor key={draft.id} content={content} onChange={setContent} />
                </Suspense>
              ) : (
                <textarea
                  ref={textareaRef}
                  aria-label="Draft content"
                  value={content}
                  onChange={(event) => setContent(event.target.value)}
                  className="h-full min-h-[28rem] w-full resize-none rounded-lg border border-neutral-100 bg-white px-3 py-2 font-mono text-sm leading-6 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                  required
                />
              )}
            </div>
          </div>
          <div className="flex min-h-0 flex-col gap-3">
            <div className="flex min-h-0 flex-1 flex-col rounded-2xl bg-white py-3">
              <textarea
                aria-label="Change summary"
                value={summary}
                onChange={(event) => setSummary(event.target.value)}
                placeholder="Optional"
                className="min-h-0 w-full flex-1 resize-none rounded-lg border border-neutral-100 bg-white px-3 py-2 text-sm leading-6 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
              />
            </div>
            <div className="flex shrink-0 flex-col gap-2">
              <Button type="submit" size="sm" className="w-full" disabled={busy || !content.trim()}>
                {busy && busyLabel === "Submitting" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Shield className="h-4 w-4" />}
                Submit for review
              </Button>
              <div className="flex gap-2">
                <Button type="button" variant="secondary" size="sm" className="flex-1" onClick={() => setMode("versions")}>Cancel</Button>
                <Button type="button" variant="secondary" size="sm" className="flex-1" onClick={() => void saveDraft()} disabled={busy || !content.trim()}>
                  {busy && busyLabel === "Saving" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                  Save
                </Button>
              </div>
            </div>
          </div>
        </form>
      ) : (
        <div className="grid min-h-0 flex-1 gap-3 xl:grid-cols-[minmax(0,1fr)_19rem]">
          <div className="min-h-0 min-w-0">
            {mode === "review" && detail ? (
            <div className="flex h-full min-h-0 flex-col rounded-2xl bg-white p-5">
              <div className="mb-5 flex shrink-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <span className="text-base">Proposed change</span>
                  <p className="mt-1 text-sm text-neutral-500">Based on version {detail.baseVersion.version}</p>
                  {/* Neutral, and hidden once changes are requested: it is passive status, and
                      the flame accent belongs to the one thing asking the author to act. Showing
                      both put two oranges side by side competing for the same attention. */}
                  {isOwnProposal && detail.proposedChange.status !== "changes_requested" ? (
                    <p className="mt-1 text-sm text-neutral-500">
                      Someone else on the workspace needs to approve this change.
                    </p>
                  ) : null}
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  {isOwnProposal && detail.proposedChange.status === "changes_requested" ? (
                    <Button
                      type="button"
                      onClick={reviseRequestedChanges}
                      disabled={busy}
                      title="Reopen this draft for editing so you can address the requested changes and resubmit"
                    >
                      {busy && busyLabel === "Loading draft" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Pencil className="h-4 w-4" />}
                      Revise
                    </Button>
                  ) : null}
                  {isOwnProposal && !isPublished ? (
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => void returnToDraft()}
                      disabled={busy}
                      title="Take this back out of review so you can keep editing. Comments and reviews are kept, and you can propose it again."
                    >
                      {busy && busyLabel === "Withdrawing" ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Undo2 className="h-4 w-4" />
                      )}
                      Withdraw
                    </Button>
                  ) : null}
                  {!isOwnProposal && !isPublished ? (
                    <RequestChangesDialog
                      onSubmit={requestChanges}
                      busy={busy && busyLabel === "Requesting changes"}
                      disabled={busy || detail.proposedChange.status === "changes_requested"}
                      title={
                        detail.proposedChange.status === "changes_requested"
                          ? "Changes have already been requested — waiting on the author to revise"
                          : "Flag this proposal as needing revisions before it can be approved. The author will get a Revise button to reopen and resubmit it."
                      }
                    />
                  ) : null}
                  {!isOwnProposal ? (
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={approve}
                      disabled={busy || isPublished}
                      title="Approve this proposal and immediately publish it as the new version"
                    >
                      {busy && busyLabel === "Approving and publishing" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Shield className="h-4 w-4" />}
                      Approve and publish
                    </Button>
                  ) : null}
                  {!isPublished && (isOwnProposal || workspace.role === "admin") ? (
                    <Dialog open={discardProposalOpen} onOpenChange={setDiscardProposalOpen}>
                      <DialogTrigger asChild>
                        <Button type="button" variant="secondary" title="Discard this proposed change for good and release the edit lock. The draft and its edits cannot be recovered.">
                          <X className="h-4 w-4" />
                          Discard proposal
                        </Button>
                      </DialogTrigger>
                      <DialogContent>
                        <DialogHeader>
                          <DialogTitle>Discard proposed change</DialogTitle>
                          <DialogDescription>
                            This closes the proposal and discards the draft along with every edit in it. It cannot be undone. To keep your edits, use Withdraw instead.
                          </DialogDescription>
                        </DialogHeader>
                        <div className="mt-5 flex justify-end gap-2">
                          <Button type="button" variant="secondary" onClick={() => setDiscardProposalOpen(false)}>Cancel</Button>
                          <Button type="button" variant="danger" onClick={() => void abandon()} disabled={busy}>
                            {busy && busyLabel === "Discarding proposal" ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />}
                            Discard proposal
                          </Button>
                        </div>
                      </DialogContent>
                    </Dialog>
                  ) : null}
                </div>
              </div>
              {detail.proposedChange.status === "changes_requested" ? (
                (() => {
                  const latestRequest = [...detail.reviews].reverse().find((r) => r.state === "changes_requested");
                  return latestRequest ? (
                    // No card: a rule and some type. The reviewer's note is the only thing
                    // here worth weight, so it reads as ink and everything else recedes.
                    <div className="mb-4 shrink-0 border-l-2 border-accent-200 pl-3">
                      <p className="text-xs text-accent-600">
                        Changes requested by{" "}
                        {latestRequest.reviewer ? displayName(latestRequest.reviewer) : "a reviewer"}
                      </p>
                      {latestRequest.body ? (
                        <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-ink">
                          {latestRequest.body}
                        </p>
                      ) : null}
                    </div>
                  ) : null;
                })()
              ) : null}
              {detail.docxHiddenChanges.length > 0 ? (
                <p className="mb-3 shrink-0 text-xs text-neutral-500">
                  <span className="text-neutral-700">Also changed:</span>{" "}
                  {detail.docxHiddenChanges.join(", ")} — not shown in the redline. Open the document to review.
                </p>
              ) : null}
              <div className="min-h-0 flex-1">
                <ProposedChangeDiffView
                  token={token}
                  workspace={workspace}
                  documentId={doc.id}
                  detail={detail}
                  isPublished={isPublished}
                  onCommentPosted={() => loadProposedChange(detail.proposedChange.id)}
                />
              </div>
            </div>
          ) : (
            <div className="flex h-full min-h-0 flex-col rounded-2xl bg-white p-3">
              <div className="shrink-0 pb-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <Eye className="h-4 w-4 shrink-0 text-neutral-400" />
                    <div className="min-w-0">
                      <h4 className="text-base">Preview</h4>
                      {selectedVersion ? (
                        <p className="mt-0.5 truncate text-xs text-neutral-500">
                          Version {selectedVersion.version} · {selectedVersion.originalFilename ?? selectedVersion.mimeType}
                        </p>
                      ) : null}
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    {openProposal ? (
                      <Button variant="secondary" onClick={() => void loadProposedChange(openProposal.id)}>
                        <Eye className="h-4 w-4" />
                        View changes
                      </Button>
                    ) : null}
                    {activeDraft && canEditActiveDraft ? (
                      <Button variant="secondary" onClick={() => void discardActiveDraft()} disabled={busy}>
                        {busy && busyLabel === "Discarding draft" ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Trash2 className="h-4 w-4" />
                        )}
                        Discard draft
                      </Button>
                    ) : null}
                    <Button
                      onClick={() => void (activeDraft ? resumeDraft(activeDraft.id) : startDraft())}
                      disabled={busy || (activeDraft ? !canEditActiveDraft : !canPropose)}
                      title={
                        activeDraft && !canEditActiveDraft
                          ? "Someone else is drafting a change to this document"
                          : openProposal
                            ? "A proposed change is already awaiting review"
                            : newestVersion && !canEditCurrentVersion
                              ? "This document format cannot be edited here"
                              : undefined
                      }
                    >
                      {busy && (busyLabel === "Creating draft" || busyLabel === "Opening draft") ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Pencil className="h-4 w-4" />
                      )}
                      {activeDraft
                        ? canEditActiveDraft
                          ? "Resume draft"
                          : "Draft in progress"
                        : "Propose changes"}
                    </Button>
                    {selectedVersion ? (
                      <Button
                        variant="secondary"
                        size="icon"
                        onClick={() => void downloadSelectedVersion()}
                        disabled={downloadBusy}
                        aria-label={`Download version ${selectedVersion.version}`}
                        title="Download"
                      >
                        {downloadBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowDownToLine className="h-4 w-4" />}
                      </Button>
                    ) : null}
                    {selectedVersion && canExportPdf ? (
                      <Button
                        variant="secondary"
                        size="icon"
                        onClick={() => void exportSelectedVersionAsPdf()}
                        disabled={exportBusy}
                        aria-label={`Export version ${selectedVersion.version} as PDF`}
                        title="Export as PDF"
                      >
                        {exportBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileDown className="h-4 w-4" />}
                      </Button>
                    ) : null}
                  </div>
                </div>
                {!openProposal && newestVersion && !canEditCurrentVersion ? (
                  <p className="mt-2 text-right text-xs text-neutral-500">
                    {newestVersion.mimeType === WORD_MIME
                      ? "DOCX files open in the native Word editor."
                      : "This format can be viewed and downloaded, but not edited here."}
                  </p>
                ) : null}
              </div>
              <div className="min-h-0 flex-1 overflow-hidden rounded-lg border border-neutral-100 bg-white">
                {selectedVersion ? (
                  <VersionPreviewContent token={token} workspace={workspace} document={doc} version={selectedVersion} onError={onError} />
                ) : (
                  <EmptyState icon={<FileText className="h-5 w-5" />} title="No versions yet" text="Upload a file to create the first version." />
                )}
              </div>
            </div>
          )}
        </div>

        <div className="flex h-full min-h-0 flex-col gap-3">
          <div
            className={cn(
              "flex min-h-0 flex-col rounded-2xl bg-white p-3",
              hasVersions ? "max-h-64 shrink-0" : "shrink-0"
            )}
          >
            <div className="flex shrink-0 items-center gap-2.5 pb-3">
              <History className="h-4 w-4 shrink-0 text-neutral-400" />
              <h4 className="text-base">Version history</h4>
            </div>
            {!hasVersions ? (
              <EmptyState icon={<History className="h-5 w-5" />} title="No versions" text="Upload a file to create the first version." />
            ) : (
              <div className="flex min-h-0 flex-1 flex-col divide-y divide-neutral-200 overflow-y-auto">
                {[...(doc.versions ?? [])].reverse().map((version) => (
                  <VersionRow
                    key={version.id}
                    version={version}
                    onSelect={() => setSelectedVersionId(version.id)}
                  />
                ))}
              </div>
            )}
          </div>
          <TasksPanel
            tasks={tasks}
            loading={tasksLoading}
            onComplete={(taskId) => void completeTask(taskId)}
            currentUserId={currentUserId}
            isAdmin={workspace.role === "admin"}
            members={members}
            onAssignTask={createTask}
            className={cn("min-h-0", hasTasks ? "flex-1" : "shrink-0")}
          />
          <div className="flex shrink-0 flex-wrap gap-2">
            {mode === "versions" && workspace.role === "admin" ? (
              <ArchiveDocumentDialog
                token={token}
                workspace={workspace}
                document={doc}
                onArchived={() => {
                  onNotice({ title: "Document archived" });
                  onArchived();
                }}
                onError={onError}
              />
            ) : null}
          </div>
        </div>
      </div>
      )}
    </div>
  );
}
