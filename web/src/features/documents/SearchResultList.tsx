import type { SearchResult } from "../../api/types";
import { EmptyState } from "../../components/EmptyState";
import { SearchSnippet } from "../../components/SearchSnippet";
import { cn, formatRelativeDate } from "../../lib/utils";
import { Search } from "lucide-react";

export function SearchResultList({
  results,
  busy,
  onSelect,
  onFocus,
  selectedDocumentId,
  compact,
}: {
  results: SearchResult[];
  busy: boolean;
  onSelect: (id: string) => void;
  onFocus: (id: string) => void;
  selectedDocumentId: string | null;
  compact?: boolean;
}) {
  if (!busy && results.length === 0) {
    return <EmptyState icon={<Search className="h-5 w-5" />} title="No search results" text="Try a different query, or check that the document has been indexed." />;
  }

  return (
    <div className="flex flex-col gap-2">
      {results.map((result) => (
        <div
          key={`${result.document.id}-${result.version.id}`}
          onClick={() => onSelect(result.document.id)}
          onDoubleClick={() => onFocus(result.document.id)}
          className={cn(
            "flex cursor-pointer rounded-lg border border-neutral-200 bg-neutral-50 transition-all hover:-translate-y-0.5 hover:border-neutral-300",
            compact ? "flex-col gap-1 p-2.5" : "items-start justify-between gap-3 p-3.5",
            selectedDocumentId === result.document.id && "bg-accent-50 hover:bg-accent-50"
          )}
        >
          <div className="min-w-0">
            <h4 className="truncate text-sm">{result.document.title}</h4>
            <p className={cn("mt-1 text-sm text-neutral-500", compact ? "line-clamp-1" : "line-clamp-2")}>
              {result.search.snippet ? (
                <SearchSnippet snippet={result.search.snippet} />
              ) : (
                "Matched indexed content"
              )}
            </p>
            <p className="mt-1 truncate text-xs text-neutral-400">{result.version.originalFilename ?? result.version.mimeType} · v{result.version.version}</p>
          </div>
          <span className="shrink-0 text-xs text-neutral-400">{formatRelativeDate(result.search.indexedAt)}</span>
        </div>
      ))}
    </div>
  );
}
