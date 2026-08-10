import { cloneElement, lazy, Suspense, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Archive,
  Activity,
  ArrowDownToLine,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  FileDown,
  CheckSquare,
  Maximize2,
  Pencil,
  Trash2,
  Undo2,
  FilePlus2,
  FileText,
  History,
  Eye,
  Loader2,
  LogOut,
  MessageSquare,
  Plus,
  Save,
  Search,
  Shield,
  Upload,
  Users,
  X,
} from "lucide-react";
import logoIcon from "./assets/logo-icon.png";
import { api, ApiError, setAuthHandlers } from "./api/client";
import type {
  ArchiveDocument,
  LineComment,
  AuditLog,
  DocumentDraft,
  DocumentTask,
  DocumentVersion,
  LineDiffLine,
  OnlyOfficeEditorConfig,
  Pagination,
  ProposedChangeDetail,
  SearchResult,
  UserRef,
  Workspace,
  WorkspaceDashboardMember,
  WorkspaceMember,
} from "./api/types";
import { useAppStore } from "./store/appStore";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./components/ui/dialog";
import { Input } from "./components/ui/input";
import { Label } from "./components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./components/ui/select";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./components/ui/dropdown-menu";
import { Tabs, TabsList, TabsTrigger } from "./components/ui/tabs";
import { Toast, ToastDescription, ToastProvider, ToastTitle, ToastViewport } from "./components/ui/toast";
import { cn, displayName, formatBytes, formatRelativeDate, initials } from "./lib/utils";
import {
  ACCESS_TOKEN_RENEW_MS,
  PAGE_SIZE,
  SEARCH_HIGHLIGHT_END,
  SEARCH_HIGHLIGHT_START,
  SUPPORTED_UPLOAD_ACCEPT,
  WORD_MIME,
} from "./lib/constants";
import {
  auditActionLabel,
  errorMessage,
  isEditableTextMimeType,
  isSupportedUploadFile,
  isTextPreview,
  latestVersion,
  previewKind,
  proposalStatusLabel,
  searchStatusLabel,
  statusTone,
} from "./lib/format";
import type { Notice, WorkspaceNavState } from "./lib/types";
import { EmptyState } from "./components/EmptyState";
import { Field } from "./components/Field";
import { Pager } from "./components/Pager";
import { SearchSnippet } from "./components/SearchSnippet";
import { DocumentFocusView } from "./features/documents/DocumentFocusView";
import { WorkspaceView } from "./features/workspaces/WorkspaceView";
import { DiffLineWithComments } from "./features/review/DiffLineWithComments";
import { ProposedChangeDiffView } from "./features/review/ProposedChangeDiffView";
import { DocumentQuickPreview } from "./features/documents/DocumentQuickPreview";
import { DocumentsListPanel } from "./features/documents/DocumentsListPanel";
import { WorkspacesLanding } from "./features/workspaces/WorkspacesLanding";
import { AppHeader } from "./components/AppHeader";
import { AuthScreen } from "./features/auth/AuthScreen";
import { VersionRow } from "./features/documents/VersionRow";
import { DocumentTable } from "./features/documents/DocumentTable";
import { SearchResultList } from "./features/documents/SearchResultList";
import { VersionPreviewContent } from "./features/documents/VersionPreviewContent";
import { ActivityLogPage } from "./features/workspaces/ActivityLogPage";
import { DashboardPanel } from "./features/workspaces/DashboardPanel";
import { TasksPanel } from "./features/tasks/TasksPanel";
import { AddMemberDialog } from "./features/workspaces/AddMemberDialog";
import { UploadDocumentDialog } from "./features/documents/UploadDocumentDialog";
import { RenameDocumentDialog } from "./features/documents/RenameDocumentDialog";
import { ArchiveDocumentDialog } from "./features/documents/ArchiveDocumentDialog";
import { AssignTaskDialog } from "./features/tasks/AssignTaskDialog";
import { RequestChangesDialog } from "./features/review/RequestChangesDialog";
import { OnlyOfficeEditor } from "./components/OnlyOfficeEditor";









// Tiptap/ProseMirror is a large dependency — only load it once someone actually
// starts editing a markdown draft, instead of bundling it into the main chunk.









const ROOT_NAV_STATE: WorkspaceNavState = { workspaceId: null, documentId: null, focused: false, activityLogOpen: false };

export function App() {
  const {
    accessToken,
    user,
    workspaces,
    setSession,
    clearSession,
    setWorkspaces,
  } = useAppStore();
  const [booting, setBooting] = useState(true);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [headerMiddleSlot, setHeaderMiddleSlot] = useState<HTMLDivElement | null>(null);
  const contentCardRef = useRef<HTMLDivElement | null>(null);
  const [searchRightOffset, setSearchRightOffset] = useState<number | null>(null);
  const [navState, setNavState] = useState<WorkspaceNavState>(ROOT_NAV_STATE);
  const [historyStack, setHistoryStack] = useState<WorkspaceNavState[]>([ROOT_NAV_STATE]);
  const [historyIndex, setHistoryIndex] = useState(0);
  const historyStackRef = useRef(historyStack);

  useEffect(() => {
    historyStackRef.current = historyStack;
  }, [historyStack]);

  const selectedWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === navState.workspaceId) ?? null,
    [navState.workspaceId, workspaces]
  );

  const canGoBack = historyIndex > 0;
  const canGoForward = historyIndex < historyStack.length - 1;

  function navigate(next: WorkspaceNavState) {
    const updated = [...historyStack.slice(0, historyIndex + 1), next];
    window.history.pushState({ seq: updated.length - 1 }, "");
    setHistoryStack(updated);
    setHistoryIndex(updated.length - 1);
    setNavState(next);
  }

  function navigateWithin(patch: Partial<WorkspaceNavState>) {
    navigate({ ...navState, workspaceId: selectedWorkspace?.id ?? navState.workspaceId, ...patch });
  }

  async function loadWorkspaces(token = accessToken) {
    if (!token) return;
    const data = await api.listWorkspaces(token);
    setWorkspaces(data.workspaces);
  }

  useEffect(() => {
    async function restore() {
      try {
        const data = await api.refresh();
        setSession(data.accessToken);
        await loadWorkspaces(data.accessToken);
      } catch {
        clearSession();
      } finally {
        setBooting(false);
      }
    }

    void restore();
  }, []);

  // Access tokens last 15 minutes and were previously only obtained at boot, so a session
  // silently stopped working after 15 minutes of use and every action failed until reload.
  // Two mechanisms, because neither is sufficient alone: the timer keeps a long editing session
  // alive, and the 401 retry covers the case where the timer did not fire — a sleeping laptop,
  // a backgrounded tab whose timers were throttled.
  useEffect(() => {
    if (!accessToken) return;

    async function renew() {
      try {
        const data = await api.refresh();
        setSession(data.accessToken);
        return data.accessToken;
      } catch {
        clearSession();
        return null;
      }
    }

    setAuthHandlers({
      refresh: renew,
      onSessionExpired: () => clearSession(),
    });

    const timer = window.setInterval(() => void renew(), ACCESS_TOKEN_RENEW_MS);

    return () => {
      window.clearInterval(timer);
      setAuthHandlers(null);
    };
  }, [accessToken === null]);

  useEffect(() => {
    window.history.replaceState({ seq: 0 }, "");
    function onPopState(event: PopStateEvent) {
      const state = event.state as { seq: number } | null;
      const stack = historyStackRef.current;
      if (state && stack[state.seq] !== undefined) {
        setHistoryIndex(state.seq);
        setNavState(stack[state.seq]);
      } else {
        setHistoryIndex(0);
        setNavState(ROOT_NAV_STATE);
      }
    }
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useLayoutEffect(() => {
    const cardEl = contentCardRef.current;
    const headerEl = headerMiddleSlot?.closest("header");
    if (!cardEl || !headerEl) return;
    const update = () => setSearchRightOffset(headerEl.getBoundingClientRect().right - cardEl.getBoundingClientRect().right);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(cardEl);
    window.addEventListener("resize", update);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [headerMiddleSlot, selectedWorkspace]);

  async function handleLogout() {
    try {
      await api.logout();
    } finally {
      clearSession();
      setNavState(ROOT_NAV_STATE);
      setHistoryStack([ROOT_NAV_STATE]);
      setHistoryIndex(0);
    }
  }

  if (booting) {
    return (
      <main className="grid min-h-screen place-items-center bg-neutral-50">
        <div className="flex items-center gap-3 text-sm text-neutral-600">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading Archive Engine
        </div>
      </main>
    );
  }

  return (
    <ToastProvider swipeDirection="right">
      <main className="min-h-screen bg-surface text-ink">
        {!accessToken ? (
          <AuthScreen
            onAuthed={async (token, authedUser) => {
              setSession(token, authedUser);
              await loadWorkspaces(token);
            }}
            onError={setError}
          />
        ) : (
          <div className="flex min-h-screen flex-col">
            <button
              type="button"
              onClick={() => window.history.back()}
              disabled={!canGoBack}
              aria-label="Back"
              className={cn(
                "fixed left-2 top-1/2 z-20 -translate-y-1/2 rounded-full p-2 outline-none transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-500 sm:left-4",
                canGoBack ? "text-neutral-400 hover:bg-black/5 hover:text-neutral-700" : "cursor-not-allowed text-neutral-200"
              )}
            >
              <ChevronLeft className="h-5 w-5" />
            </button>
            <button
              type="button"
              onClick={() => window.history.forward()}
              disabled={!canGoForward}
              aria-label="Forward"
              className={cn(
                "fixed right-2 top-1/2 z-20 -translate-y-1/2 rounded-full p-2 outline-none transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-500 sm:right-4",
                canGoForward ? "text-neutral-400 hover:bg-black/5 hover:text-neutral-700" : "cursor-not-allowed text-neutral-200"
              )}
            >
              <ChevronRight className="h-5 w-5" />
            </button>
            <AppHeader
              user={user}
              onLogout={handleLogout}
              middleRef={setHeaderMiddleSlot}
            />
            <div
              ref={contentCardRef}
              className="mx-0 flex-1 bg-white sm:mx-8 sm:shadow-[0_0_0_1px_rgba(0,0,0,0.06),_-8px_0_16px_-12px_rgba(0,0,0,0.15),_8px_0_16px_-12px_rgba(0,0,0,0.15)] lg:mx-16 xl:mx-28"
            >
              {selectedWorkspace ? (
                <WorkspaceView
                  token={accessToken}
                  workspace={selectedWorkspace}
                  currentUserId={user?.id ?? null}
                  onError={setError}
                  onNotice={setNotice}
                  headerSlot={headerMiddleSlot}
                  searchRightOffset={searchRightOffset}
                  documentId={navState.documentId}
                  focused={navState.focused}
                  activityLogOpen={navState.activityLogOpen}
                  onNavigate={navigateWithin}
                />
              ) : (
                <WorkspacesLanding
                  workspaces={workspaces}
                  onSelect={(id) => navigate({ workspaceId: id, documentId: null, focused: false, activityLogOpen: false })}
                  onCreate={async (name) => {
                    await api.createWorkspace(accessToken, name);
                    await loadWorkspaces();
                    setNotice({ title: "Workspace created" });
                  }}
                  onError={setError}
                />
              )}
            </div>
          </div>
        )}
      </main>
      <Toast open={Boolean(error)} onOpenChange={(open) => !open && setError(null)}>
        <ToastTitle>Request failed</ToastTitle>
        <ToastDescription>{error}</ToastDescription>
      </Toast>
      <Toast open={Boolean(notice)} onOpenChange={(open) => !open && setNotice(null)}>
        <ToastTitle>{notice?.title}</ToastTitle>
        {notice?.description ? <ToastDescription>{notice.description}</ToastDescription> : null}
      </Toast>
      <ToastViewport />
    </ToastProvider>
  );
}





























