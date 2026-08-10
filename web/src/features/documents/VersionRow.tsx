import type { DocumentVersion } from "../../api/types";
import { Badge } from "../../components/ui/badge";
import { searchStatusLabel, statusTone } from "../../lib/format";
import { displayName, formatRelativeDate } from "../../lib/utils";

export function VersionRow({
  version,
  onSelect,
}: {
  version: DocumentVersion;
  onSelect: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
      className="cursor-pointer px-1 py-3.5 text-left transition-colors hover:bg-neutral-100/60"
    >
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-sm">Version {version.version}</span>
          {version.search && (version.search.status === "pending" || version.search.status === "failed") ? (
            <Badge tone={statusTone(version.search.status)}>{searchStatusLabel(version.search.status)}</Badge>
          ) : null}
        </div>
        <div className="mt-1 text-xs text-neutral-400">
          {displayName(version.createdBy)} · {formatRelativeDate(version.createdAt)}
        </div>
      </div>
    </div>
  );
}
