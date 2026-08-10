import type { ArchiveDocument } from "../../api/types";
import { EmptyState } from "../../components/EmptyState";
import { latestVersion } from "../../lib/format";
import { cn, formatBytes, formatRelativeDate } from "../../lib/utils";
import { FilePlus2, Upload } from "lucide-react";

export function DocumentTable({
  documents,
  busy,
  onSelect,
  onFocus,
  selectedDocumentId,
  compact,
}: {
  documents: ArchiveDocument[];
  busy: boolean;
  onSelect: (id: string) => void;
  onFocus: (id: string) => void;
  selectedDocumentId: string | null;
  compact?: boolean;
}) {
  if (!busy && documents.length === 0) {
    return <EmptyState icon={<FilePlus2 className="h-5 w-5" />} title="No documents yet" text="Upload the first file for this workspace." />;
  }

  return (
    <div className="flex flex-col gap-2">
      {documents.map((document) => {
        const version = latestVersion(document);
        return (
          <div
            key={document.id}
            onClick={() => onSelect(document.id)}
            onDoubleClick={() => onFocus(document.id)}
            className={cn(
              "flex cursor-pointer rounded-lg border border-neutral-200 bg-neutral-50 transition-all hover:-translate-y-0.5 hover:border-neutral-300",
              compact ? "flex-col gap-0.5 p-2.5" : "items-center justify-between gap-3 p-3.5",
              selectedDocumentId === document.id && "bg-accent-50 hover:bg-accent-50"
            )}
            title="Click to preview, double-click to open"
          >
            <div className="min-w-0">
              <h4 className="truncate text-sm">{document.title}</h4>
              <p className="mt-1 truncate text-xs text-neutral-400">
                {version ? `v${version.version} · ${formatBytes(version.sizeBytes)}` : "No versions"}
              </p>
            </div>
            <span className={cn("shrink-0 text-xs text-neutral-400", compact && "mt-1")}>{formatRelativeDate(document.createdAt)}</span>
          </div>
        );
      })}
    </div>
  );
}
