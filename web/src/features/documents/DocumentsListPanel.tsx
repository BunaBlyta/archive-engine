import type { ArchiveDocument, Pagination, SearchResult, Workspace } from "../../api/types";
import { Pager } from "../../components/Pager";
import { DocumentTable } from "./DocumentTable";
import { SearchResultList } from "./SearchResultList";
import { UploadDocumentDialog } from "./UploadDocumentDialog";
import { FileText, Search, Upload } from "lucide-react";

export function DocumentsListPanel({
  token,
  workspace,
  documents,
  pagination,
  busy,
  onPage,
  onUploaded,
  searchActive,
  searchResults,
  searchPagination,
  searchOffset,
  searchBusy,
  onSearchPage,
  selectedDocumentId,
  onSelect,
  onFocus,
  onError,
}: {
  token: string;
  workspace: Workspace;
  documents: ArchiveDocument[];
  pagination: Pagination | null;
  busy: boolean;
  onPage: (offset: number) => void | Promise<void>;
  onUploaded: () => Promise<void>;
  searchActive: boolean;
  searchResults: SearchResult[];
  searchPagination: Pagination | null;
  searchOffset: number;
  searchBusy: boolean;
  onSearchPage: (offset: number) => void | Promise<void>;
  selectedDocumentId: string | null;
  onSelect: (id: string) => void;
  onFocus: (id: string) => void;
  onError: (message: string) => void;
}) {
  const compact = Boolean(selectedDocumentId);

  return (
    <section className="flex h-full min-h-0 flex-col rounded-2xl bg-white p-3">
      <div className="shrink-0 pb-2">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            {searchActive ? <Search className="h-4 w-4 shrink-0 text-neutral-400" /> : <FileText className="h-4 w-4 shrink-0 text-neutral-400" />}
            <h3 className="text-base">{searchActive ? "Search results" : "Documents"}</h3>
          </div>
          <div className="-mr-1 flex shrink-0 gap-1">
            <UploadDocumentDialog token={token} workspace={workspace} onUploaded={onUploaded} onError={onError} compact />
          </div>
        </div>
        <p className="mt-2 text-sm text-neutral-500">
          {searchActive ? "Matches from titles and indexed content." : "Upload files and propose changes to keep an official version."}
        </p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pt-1">
        {searchActive ? (
          <SearchResultList
            results={searchResults}
            busy={searchBusy}
            onSelect={onSelect}
            onFocus={onFocus}
            selectedDocumentId={selectedDocumentId}
            compact={compact}
          />
        ) : (
          <DocumentTable
            documents={documents}
            busy={busy}
            onSelect={onSelect}
            onFocus={onFocus}
            selectedDocumentId={selectedDocumentId}
            compact={compact}
          />
        )}
      </div>
      {(searchActive ? searchPagination : pagination) ? (
        <div className="-mx-3 -mb-3 mt-3 shrink-0 rounded-b-2xl border-t border-neutral-100 bg-white px-2">
          {searchActive ? (
            <Pager
              pagination={searchPagination ? { ...searchPagination, offset: searchOffset } : null}
              count={searchResults.length}
              onPage={onSearchPage}
            />
          ) : (
            <Pager pagination={pagination} count={documents.length} onPage={onPage} />
          )}
        </div>
      ) : null}
    </section>
  );
}
