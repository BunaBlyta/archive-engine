import { createPortal } from "react-dom";
import { api } from "../../api/client";
import type { ArchiveDocument, Pagination, SearchResult, Workspace } from "../../api/types";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { PAGE_SIZE } from "../../lib/constants";
import { errorMessage } from "../../lib/format";
import type { Notice, WorkspaceNavState } from "../../lib/types";
import { cn } from "../../lib/utils";
import { DocumentFocusView } from "../documents/DocumentFocusView";
import { DocumentQuickPreview } from "../documents/DocumentQuickPreview";
import { DocumentsListPanel } from "../documents/DocumentsListPanel";
import { RenameDocumentDialog } from "../documents/RenameDocumentDialog";
import { ActivityLogPage } from "./ActivityLogPage";
import { DashboardPanel } from "./DashboardPanel";
import { Activity, Search, X } from "lucide-react";
import { useEffect, useState } from "react";

export function WorkspaceView({
  token,
  workspace,
  currentUserId,
  onError,
  onNotice,
  headerSlot,
  searchRightOffset,
  documentId: selectedDocumentId,
  focused,
  activityLogOpen,
  onNavigate,
}: {
  token: string;
  workspace: Workspace;
  currentUserId: string | null;
  onError: (message: string) => void;
  onNotice: (notice: Notice) => void;
  headerSlot: HTMLDivElement | null;
  searchRightOffset: number | null;
  documentId: string | null;
  focused: boolean;
  activityLogOpen: boolean;
  onNavigate: (patch: Partial<WorkspaceNavState>) => void;
}) {
  const [documents, setDocuments] = useState<ArchiveDocument[]>([]);
  const [pagination, setPagination] = useState<Pagination | null>(null);
  const [offset, setOffset] = useState(0);
  const [listBusy, setListBusy] = useState(false);

  const [queryInput, setQueryInput] = useState("");
  const [searchActive, setSearchActive] = useState(false);
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchPagination, setSearchPagination] = useState<Pagination | null>(null);
  const [searchOffset, setSearchOffset] = useState(0);
  const [searchBusy, setSearchBusy] = useState(false);

  const [selectedDocument, setSelectedDocument] = useState<ArchiveDocument | null>(null);

  async function loadDocuments(nextOffset = 0) {
    setListBusy(true);
    try {
      const data = await api.listDocuments(token, workspace.id, nextOffset, PAGE_SIZE);
      setDocuments(data.documents);
      setPagination(data.pagination);
      setOffset(nextOffset);
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setListBusy(false);
    }
  }

  async function runSearch(nextOffset = 0) {
    if (!queryInput.trim()) return;
    setSearchBusy(true);
    try {
      const data = await api.searchDocuments(token, workspace.id, queryInput, nextOffset, PAGE_SIZE);
      setSearchResults(data.results);
      setSearchPagination(data.pagination);
      setSearchOffset(nextOffset);
      setSearchActive(true);
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setSearchBusy(false);
    }
  }

  function clearSearch() {
    setQueryInput("");
    setSearchActive(false);
    setSearchResults([]);
    setSearchPagination(null);
    setSearchOffset(0);
  }

  function selectDocument(documentId: string, focusNow: boolean) {
    onNavigate({ documentId, focused: focusNow });
  }

  function closeDocument() {
    onNavigate({ documentId: null, focused: false });
  }

  async function refreshSelectedDocument() {
    if (!selectedDocumentId) return;
    try {
      const data = await api.getDocument(token, workspace.id, selectedDocumentId);
      setSelectedDocument(data.document);
    } catch (error) {
      onError(errorMessage(error));
    }
  }

  useEffect(() => {
    if (!selectedDocumentId) {
      setSelectedDocument(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const data = await api.getDocument(token, workspace.id, selectedDocumentId);
        if (!cancelled) setSelectedDocument(data.document);
      } catch (error) {
        if (!cancelled) onError(errorMessage(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedDocumentId, workspace.id]);

  useEffect(() => {
    clearSearch();
    setOffset(0);
    void loadDocuments(0);
  }, [workspace.id]);

  return (
    <div className="flex h-[calc(100vh-3rem)] flex-col overflow-hidden">
      {headerSlot
        ? createPortal(
            <>
              <h2 className="min-w-0 truncate font-display text-base font-medium">
                {workspace.name}
                {activityLogOpen ? (
                  <>
                    <span className="text-neutral-400"> / </span>
                    Activity log
                  </>
                ) : focused && selectedDocument ? (
                  <>
                    <span className="text-neutral-400"> / </span>
                    {selectedDocument.title}
                  </>
                ) : null}
              </h2>
              {focused && selectedDocument ? (
                <RenameDocumentDialog
                  token={token}
                  workspace={workspace}
                  document={selectedDocument}
                  iconOnly
                  onRenamed={async () => {
                    await refreshSelectedDocument();
                    onNotice({ title: "Document renamed" });
                  }}
                  onError={onError}
                />
              ) : null}
              {activityLogOpen ? (
                <div className="min-w-0 flex-1" />
              ) : !focused ? (
                <>
                  <div className="min-w-0 flex-1" />
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      void runSearch(0);
                    }}
                    className="absolute top-1/2 flex w-full max-w-xs -translate-y-1/2 gap-2"
                    style={{ right: searchRightOffset != null ? `${searchRightOffset}px` : undefined }}
                  >
                    <div className="relative flex-1">
                      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-400" />
                      <Input
                        value={queryInput}
                        onChange={(event) => setQueryInput(event.target.value)}
                        placeholder="Search documents"
                        className="h-8 border-transparent bg-white pl-9 shadow-sm"
                      />
                    </div>
                    {searchActive ? (
                      <Button type="button" variant="ghost" size="icon" onClick={clearSearch} aria-label="Clear search">
                        <X className="h-4 w-4" />
                      </Button>
                    ) : null}
                  </form>
                </>
              ) : (
                <div className="min-w-0 flex-1" />
              )}
            </>,
            headerSlot
          )
        : null}
      <div className="min-h-0 flex-1 p-4">
        {activityLogOpen ? (
          <ActivityLogPage token={token} workspace={workspace} onError={onError} />
        ) : focused && selectedDocumentId ? (
          <DocumentFocusView
            token={token}
            workspace={workspace}
            document={selectedDocument}
            currentUserId={currentUserId}
            onChanged={refreshSelectedDocument}
            onArchived={() => {
              closeDocument();
              void loadDocuments(0);
            }}
            onError={onError}
            onNotice={onNotice}
          />
        ) : (
          <div
            className={cn(
              "grid h-full gap-3",
              selectedDocumentId ? "xl:grid-cols-[20rem_minmax(0,1fr)]" : "xl:grid-cols-[minmax(0,1fr)_26rem]"
            )}
          >
            <DocumentsListPanel
              token={token}
              workspace={workspace}
              documents={documents}
              pagination={pagination}
              busy={listBusy}
              onPage={loadDocuments}
              onUploaded={async () => {
                await loadDocuments(0);
                onNotice({ title: "Document uploaded" });
              }}
              searchActive={searchActive}
              searchResults={searchResults}
              searchPagination={searchPagination}
              searchOffset={searchOffset}
              searchBusy={searchBusy}
              onSearchPage={runSearch}
              selectedDocumentId={selectedDocumentId}
              onSelect={(id) => {
                if (id === selectedDocumentId) {
                  closeDocument();
                  void loadDocuments(offset);
                } else {
                  void selectDocument(id, false);
                }
              }}
              onFocus={(id) => void selectDocument(id, true)}
              onError={onError}
            />
            {selectedDocumentId ? (
              <DocumentQuickPreview
                token={token}
                workspace={workspace}
                document={selectedDocument}
                onFocus={() => onNavigate({ focused: true })}
                onError={onError}
              />
            ) : (
              <DashboardPanel
                token={token}
                workspace={workspace}
                onError={onError}
                onNotice={onNotice}
                onOpenActivityLog={() => onNavigate({ activityLogOpen: true })}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
