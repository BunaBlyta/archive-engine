import type { LineComment, LineDiffLine, ProposedChangeDetail, Workspace } from "../../api/types";
import { cn } from "../../lib/utils";
import { DiffLineWithComments } from "./DiffLineWithComments";
import { buildDiffSegments } from "./diffSegments";
import { ChevronsUpDown, Pencil } from "lucide-react";
import { useMemo, useState } from "react";

export function ProposedChangeDiffView({
  token,
  workspace,
  documentId,
  detail,
  isPublished,
  onCommentPosted,
}: {
  token: string;
  workspace: Workspace;
  documentId: string;
  detail: ProposedChangeDetail;
  isPublished: boolean;
  onCommentPosted: () => void;
}) {
  const [activeCommentLine, setActiveCommentLine] = useState<number | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  const commentsByLine = useMemo(() => {
    const map = new Map<number, LineComment[]>();
    for (const c of detail.comments) {
      const list = map.get(c.diffLineIndex) ?? [];
      list.push(c);
      map.set(c.diffLineIndex, list);
    }
    return map;
  }, [detail.comments]);

  const segments = useMemo(
    () => (detail.diff.type === "line" ? buildDiffSegments(detail.diff.lines) : []),
    [detail.diff]
  );

  function renderLine(line: LineDiffLine, index: number) {
    return (
      <DiffLineWithComments
        key={`${line.type}-${line.oldLineNumber ?? "x"}-${line.newLineNumber ?? "x"}-${index}`}
        token={token}
        workspace={workspace}
        documentId={documentId}
        proposedChangeId={detail.proposedChange.id}
        line={line}
        lineIndex={index}
        comments={commentsByLine.get(index) ?? []}
        isCommentFormOpen={activeCommentLine === index}
        canComment={!isPublished}
        onOpenCommentForm={() => setActiveCommentLine(index)}
        onCloseCommentForm={() => setActiveCommentLine(null)}
        onCommentPosted={() => { setActiveCommentLine(null); onCommentPosted(); }}
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col rounded-2xl bg-white p-3">
      <div className="flex shrink-0 items-center gap-2.5 pb-3">
        <Pencil className="h-4 w-4 shrink-0 text-neutral-400" />
        <h4 className="text-base">Changes</h4>
      </div>
      {detail.diff.type === "too_large" ? (
        <div className="rounded-lg border border-neutral-100 bg-white p-4 text-sm text-neutral-600">This change is too large to display as a line diff.</div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-neutral-100 bg-white font-mono text-xs">
          {segments.map((segment, segmentIndex) => {
            if (segment.kind === "line") {
              return renderLine(segment.line, segment.index);
            }

            if (expandedGroups.has(segment.id)) {
              return detail.diff.type === "line"
                ? detail.diff.lines
                    .slice(segment.startIndex, segment.endIndex)
                    .map((line, offset) => renderLine(line, segment.startIndex + offset))
                : null;
            }

            const isTrailing = segmentIndex === segments.length - 1;

            return (
              <button
                key={segment.id}
                type="button"
                onClick={() => setExpandedGroups((prev) => new Set(prev).add(segment.id))}
                className={cn(
                  "sticky z-10 flex w-full items-center gap-2 border-y border-neutral-100 bg-neutral-50 px-3 py-1 font-sans text-neutral-500 hover:bg-neutral-100",
                  isTrailing ? "bottom-0" : "top-0"
                )}
              >
                <ChevronsUpDown className="h-3.5 w-3.5" />
                Show {segment.count} unchanged line{segment.count === 1 ? "" : "s"}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
