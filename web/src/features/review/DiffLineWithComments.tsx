import { api } from "../../api/client";
import type { LineComment, LineDiffLine, Workspace } from "../../api/types";
import { Button } from "../../components/ui/button";
import { cn, displayName, formatRelativeDate } from "../../lib/utils";
import { Loader2, MessageSquare } from "lucide-react";
import { useState } from "react";
import type { FormEvent } from "react";

export function DiffLineWithComments({
  token,
  workspace,
  documentId,
  proposedChangeId,
  line,
  lineIndex,
  comments,
  isCommentFormOpen,
  canComment,
  onOpenCommentForm,
  onCloseCommentForm,
  onCommentPosted,
}: {
  token: string;
  workspace: Workspace;
  documentId: string;
  proposedChangeId: string;
  line: LineDiffLine;
  lineIndex: number;
  comments: LineComment[];
  isCommentFormOpen: boolean;
  canComment: boolean;
  onOpenCommentForm: () => void;
  onCloseCommentForm: () => void;
  onCommentPosted: () => void;
}) {
  const [commentBody, setCommentBody] = useState("");
  const [busy, setBusy] = useState(false);

  async function submitComment(e: React.FormEvent) {
    e.preventDefault();
    if (!commentBody.trim()) return;
    setBusy(true);
    try {
      await api.createLineComment(token, workspace.id, documentId, proposedChangeId, lineIndex, commentBody.trim());
      setCommentBody("");
      onCommentPosted();
    } finally {
      setBusy(false);
    }
  }

  const lineClass = line.type === "added"
    ? "bg-emerald-50 text-emerald-900"
    : line.type === "removed"
      ? "bg-red-50 text-red-900"
      : "text-neutral-700";
  const marker = line.type === "added" ? "+" : line.type === "removed" ? "-" : " ";

  return (
    <div>
      <div className={cn("group relative grid grid-cols-[3rem_3rem_1.5rem_minmax(0,1fr)_2rem] gap-2 px-3 py-1", lineClass)}>
        <span className="select-none text-right text-neutral-400">{line.oldLineNumber ?? ""}</span>
        <span className="select-none text-right text-neutral-400">{line.newLineNumber ?? ""}</span>
        <span className="select-none">{marker}</span>
        <span className="whitespace-pre-wrap break-words">{line.text || " "}</span>
        {canComment ? (
          <button
            type="button"
            onClick={onOpenCommentForm}
            className="flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
            title="Add comment"
          >
            <MessageSquare className="h-3.5 w-3.5 text-neutral-400 hover:text-blue-500" />
          </button>
        ) : <span />}
      </div>

      {comments.map((c) => (
        <div key={c.id} className="ml-[7.5rem] border-l-2 border-blue-200 bg-blue-50 px-3 py-2 text-xs">
          <span className="text-blue-800">{displayName(c.author)}</span>
          <span className="ml-2 text-neutral-500">{formatRelativeDate(c.createdAt)}</span>
          <p className="mt-1 whitespace-pre-wrap text-neutral-700">{c.body}</p>
        </div>
      ))}

      {isCommentFormOpen ? (
        <form onSubmit={(e) => void submitComment(e)} className="ml-[7.5rem] border-l-2 border-blue-300 bg-blue-50 px-3 py-2">
          <textarea
            autoFocus
            value={commentBody}
            onChange={(e) => setCommentBody(e.target.value)}
            placeholder="Leave a comment…"
            className="w-full resize-none rounded border border-neutral-100 bg-white px-2 py-1 text-xs outline-none focus:border-blue-400"
            rows={2}
          />
          <div className="mt-1.5 flex gap-2">
            <Button type="submit" size="sm" disabled={busy || !commentBody.trim()}>
              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
              Comment
            </Button>
            <Button type="button" size="sm" variant="secondary" onClick={onCloseCommentForm}>
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
