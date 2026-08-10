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
import { OnlyOfficeEditor } from "./components/OnlyOfficeEditor";

type Notice = { title: string; description?: string };

const PAGE_SIZE = 25;

// Comfortably inside the API's 15-minute access token lifetime.
const ACCESS_TOKEN_RENEW_MS = 13 * 60 * 1000;

function errorMessage(error: unknown) {
  if (error instanceof ApiError) {
    return error.requestId ? `${error.message} (${error.requestId})` : error.message;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return "Something went wrong";
}

function statusTone(status?: string | null): "neutral" | "green" | "amber" | "red" | "blue" {
  if (status === "indexed") return "green";
  if (status === "failed") return "red";
  if (status === "pending") return "amber";
  if (status === "processing") return "blue";
  return "neutral";
}

function searchStatusLabel(status?: string | null) {
  if (status === "indexed") return "searchable";
  if (status === "failed") return "index failed";
  if (status === "pending") return "index pending";
  if (status === "processing") return "indexing";
  if (status === "unsupported") return "not searchable";
  return "not indexed";
}

const AUDIT_ACTION_LABELS: Record<string, string> = {
  "document.created": "Document created",
  "document.renamed": "Document renamed",
  "document.archived": "Document archived",
  "document_draft.created": "Draft created",
  "document_version.downloaded": "Downloaded",
  "document_version.exported": "Exported",
  "document_task.created": "Task created",
  "document_task.completed": "Task completed",
  "membership.created": "Member added",
  "proposed_change.opened": "Change proposed",
  "proposed_change.commented": "Change commented",
  "proposed_change.reviewed": "Change reviewed",
  "proposed_change.published": "Change published",
  "proposed_change.abandoned": "Proposal discarded",
  "proposed_change.withdrawn": "Proposal withdrawn to draft",
};

function auditActionLabel(action: string) {
  return AUDIT_ACTION_LABELS[action] ?? action;
}

function proposalStatusLabel(status?: string | null) {
  if (status === "open") return "Proposed change: awaiting review";
  if (status === "changes_requested") return "Changes requested";
  if (status === "approved") return "Approved";
  if (status === "published") return "Published";
  return status ?? "Unknown";
}

const WORD_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const SUPPORTED_UPLOAD_ACCEPT = ".txt,.md,.markdown,.docx,text/plain,text/markdown,application/vnd.openxmlformats-officedocument.wordprocessingml.document";

// Tiptap/ProseMirror is a large dependency — only load it once someone actually
// starts editing a markdown draft, instead of bundling it into the main chunk.
const MarkdownWysiwygEditor = lazy(() => import("./components/MarkdownWysiwygEditor"));

function isTextPreview(mimeType: string) {
  return (
    mimeType.startsWith("text/") ||
    mimeType === "application/json" ||
    mimeType.endsWith("+json") ||
    mimeType === "application/xml" ||
    mimeType.endsWith("+xml")
  );
}

function isEditableTextMimeType(mimeType: string) {
  const normalized = mimeType.toLowerCase();
  return normalized === "text/plain" || normalized === "text/markdown" || normalized === WORD_MIME;
}

function isSupportedUploadFile(file: File) {
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

function previewKind(mimeType: string): "text" | "html" | "unsupported" {
  if (isTextPreview(mimeType)) return "text";
  if (mimeType.toLowerCase() === WORD_MIME) return "html";
  return "unsupported";
}

// The API wraps search matches in private-use sentinels rather than returning HTML, so nothing
// it produces can be injected into the page. Splitting on them here is what turns a match into a
// highlight; rendering the snippet raw would show the sentinel characters to the user.
const SEARCH_HIGHLIGHT_START = "\uE000ARCHIVE_ENGINE_SEARCH_START\uE001";
const SEARCH_HIGHLIGHT_END = "\uE000ARCHIVE_ENGINE_SEARCH_END\uE001";

function SearchSnippet({ snippet }: { snippet: string }) {
  const parts = snippet.split(SEARCH_HIGHLIGHT_START);

  return (
    <>
      {parts.map((part, index) => {
        if (index === 0) return <span key={index}>{part}</span>;

        const [match, ...rest] = part.split(SEARCH_HIGHLIGHT_END);
        return (
          <span key={index}>
            <mark className="rounded bg-accent-100 px-0.5 text-inherit">{match}</mark>
            {rest.join(SEARCH_HIGHLIGHT_END)}
          </span>
        );
      })}
    </>
  );
}

function latestVersion(document: ArchiveDocument) {
  return document.latestVersion ?? document.versions?.[document.versions.length - 1] ?? null;
}

type WorkspaceNavState = {
  workspaceId: string | null;
  documentId: string | null;
  focused: boolean;
  activityLogOpen: boolean;
};

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

function AppHeader({
  user,
  onLogout,
  middleRef,
}: {
  user: UserRef | null;
  onLogout: () => void;
  middleRef?: (el: HTMLDivElement | null) => void;
}) {
  return (
    <header className="relative z-10 flex h-12 shrink-0 items-center gap-3 bg-surface px-4 shadow-[0_1px_3px_rgba(0,0,0,0.08)]">
      <div className="flex shrink-0 items-center gap-2">
        <img src={logoIcon} alt="" className="h-7 w-7" />
        <span className="hidden font-display text-[15px] font-medium lg:block">Archive Engine</span>
      </div>
      <div ref={middleRef} className="flex min-w-0 flex-1 items-center gap-3" />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="rounded-full outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
            aria-label="Account menu"
          >
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-accent-300 to-accent-500 text-xs font-semibold text-white">
              {initials(user)}
            </span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {user ? (
            <div className="px-2 py-1.5">
              <div className="truncate text-sm font-medium">{displayName(user)}</div>
              <div className="truncate text-xs text-neutral-500">{user.email}</div>
            </div>
          ) : null}
          <DropdownMenuItem onSelect={onLogout}>
            <LogOut className="h-4 w-4" />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  );
}

function WorkspacesLanding({
  workspaces,
  onSelect,
  onCreate,
  onError,
}: {
  workspaces: Workspace[];
  onSelect: (id: string) => void;
  onCreate: (name: string) => Promise<void>;
  onError: (message: string) => void;
}) {
  const [name, setName] = useState("");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function createWorkspace(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await onCreate(name);
      setName("");
      setOpen(false);
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl px-5 py-10">
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="font-display text-3xl">Workspaces</h1>
          <p className="mt-1 text-sm text-neutral-500">Select a workspace to manage documents and governance.</p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button><Plus className="h-4 w-4" />New workspace</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create workspace</DialogTitle>
              <DialogDescription>Start a separate document archive with its own members and audit trail.</DialogDescription>
            </DialogHeader>
            <form onSubmit={createWorkspace} className="space-y-4">
              <Field label="Workspace name">
                <Input value={name} onChange={(event) => setName(event.target.value)} required />
              </Field>
              <Button disabled={busy}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                Create
              </Button>
            </form>
          </DialogContent>
        </Dialog>
      </div>
      {workspaces.length === 0 ? (
        <EmptyState
          icon={<Plus className="h-5 w-5" />}
          title="No workspaces yet"
          text="Create a workspace to start archiving documents."
        />
      ) : (
        <div className="space-y-2">
          {workspaces.map((workspace) => (
            <button
              key={workspace.id}
              type="button"
              onClick={() => onSelect(workspace.id)}
              className="flex w-full items-center justify-between rounded-lg border border-surface-border bg-surface px-5 py-4 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:border-neutral-200 hover:shadow-md"
            >
              <div>
                <div className="text-sm">{workspace.name}</div>
                <div className="mt-0.5 text-sm text-neutral-500">Created {formatRelativeDate(workspace.createdAt)}</div>
              </div>
              <Badge tone={workspace.role === "admin" ? "accent" : "neutral"}>{workspace.role}</Badge>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function AuthScreen({
  onAuthed,
  onError,
}: {
  onAuthed: (token: string, user: UserRef) => Promise<void>;
  onError: (message: string) => void;
}) {
  const [mode, setMode] = useState("login");
  const [email, setEmail] = useState("test@example.com");
  const [password, setPassword] = useState("password123");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const data = mode === "login"
        ? await api.login(email, password)
        : await api.register(email, password, firstName, lastName);
      await onAuthed(data.accessToken, data.user);
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="grid min-h-screen place-items-center px-4">
      <form onSubmit={submit} className="w-full max-w-sm rounded-lg border border-neutral-100 bg-white p-6">
        <div className="mb-6 flex items-center gap-3">
          <img src={logoIcon} alt="" className="h-10 w-10" />
          <div>
            <h1 className="text-lg">Archive Engine</h1>
            <p className="text-sm text-neutral-500">Sign in to manage document versions.</p>
          </div>
        </div>
        <Tabs value={mode} onValueChange={setMode} className="mb-5">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="login">Login</TabsTrigger>
            <TabsTrigger value="register">Register</TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="space-y-4">
          {mode === "register" ? (
            <div className="grid grid-cols-2 gap-3">
              <Field label="First name">
                <Input value={firstName} onChange={(event) => setFirstName(event.target.value)} autoComplete="given-name" required />
              </Field>
              <Field label="Last name">
                <Input value={lastName} onChange={(event) => setLastName(event.target.value)} autoComplete="family-name" required />
              </Field>
            </div>
          ) : null}
          <Field label="Email">
            <Input value={email} onChange={(event) => setEmail(event.target.value)} type="email" autoComplete="email" required />
          </Field>
          <Field label="Password">
            <Input value={password} onChange={(event) => setPassword(event.target.value)} type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} required />
          </Field>
          <Button className="w-full" disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Shield className="h-4 w-4" />}
            {mode === "login" ? "Sign in" : "Create account"}
          </Button>
        </div>
      </form>
    </section>
  );
}

function WorkspaceView({
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

function DashboardPanel({
  token,
  workspace,
  onError,
  onNotice,
  onOpenActivityLog,
}: {
  token: string;
  workspace: Workspace;
  onError: (message: string) => void;
  onNotice: (notice: Notice) => void;
  onOpenActivityLog: () => void;
}) {
  const [members, setMembers] = useState<WorkspaceDashboardMember[]>([]);
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const dashData = await api.getDashboard(token, workspace.id);
      setMembers(dashData.members);
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, [workspace.id]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <section className="flex min-h-0 flex-1 flex-col rounded-2xl bg-white p-3">
        <div className="shrink-0 pb-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <Users className="h-4 w-4 shrink-0 text-neutral-400" />
              <h3 className="text-base">Members</h3>
              {workspace.role === "admin" ? (
                <div className="-ml-2">
                  <AddMemberDialog
                    token={token}
                    workspace={workspace}
                    onAdded={async () => {
                      await load();
                      onNotice({ title: "Member added" });
                    }}
                    onError={onError}
                  />
                </div>
              ) : null}
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onOpenActivityLog}
                className="flex items-center gap-3 text-xs text-accent-400 hover:text-accent-600"
              >
                <Activity className="h-4 w-4 shrink-0" />
                See recent activity
              </button>
              {loading ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-neutral-400" /> : null}
            </div>
          </div>
          <p className="mt-3 text-sm text-neutral-500">{members.length} with access</p>
        </div>
        {members.length === 0 ? (
          <EmptyState icon={<Users className="h-5 w-5" />} title="No members found" text="Workspace members will appear here." />
        ) : (
          <div className="min-h-0 flex-1 divide-y divide-neutral-200 overflow-y-auto">
            {members.map((member) => (
              <div key={member.userId} className="flex items-center gap-3 px-1 py-3.5 text-sm">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-accent-300 to-accent-500 text-xs text-white">
                  {initials(member)}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-sm">{displayName(member)}</span>
                    {member.role === "admin" ? <Shield className="h-3 w-3 shrink-0 text-accent-400" aria-label="Admin" /> : null}
                  </div>
                  <div className="text-xs text-neutral-400">{member.contributionCount} contributions</div>
                </div>
                <div className="shrink-0 text-xs text-neutral-400">{formatRelativeDate(member.createdAt)}</div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function ActivityLogPage({
  token,
  workspace,
  onError,
}: {
  token: string;
  workspace: Workspace;
  onError: (message: string) => void;
}) {
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [auditPagination, setAuditPagination] = useState<Pagination | null>(null);
  const [auditOffset, setAuditOffset] = useState(0);
  const [loading, setLoading] = useState(false);

  async function loadAuditPage(nextOffset: number) {
    setLoading(true);
    try {
      const data = await api.listAuditLogs(token, workspace.id, nextOffset, PAGE_SIZE);
      setAuditLogs(data.auditLogs);
      setAuditPagination(data.pagination);
      setAuditOffset(nextOffset);
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadAuditPage(0);
  }, [workspace.id]);

  return (
    <div className="flex h-full min-h-0 flex-col rounded-2xl bg-white p-3">
      <div className="shrink-0 pb-3">
        <div className="flex items-center gap-2.5">
          <Activity className="h-4 w-4 shrink-0 text-neutral-400" />
          <h3 className="text-base">Activity log</h3>
        </div>
        <p className="mt-2 text-sm text-neutral-500">Full audit log for this workspace.</p>
      </div>
      {!loading && auditLogs.length === 0 ? (
        <EmptyState icon={<Activity className="h-5 w-5" />} title="No audit events" text="Events appear as files and members change." />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-1 pt-2">
          {auditLogs.map((log, index) => (
            <div key={log.id} className="flex gap-3.5">
              <div className="flex w-2 shrink-0 flex-col items-center">
                <span className="mt-2 h-2.5 w-2.5 shrink-0 rounded-full bg-flame-400 ring-4 ring-flame-100" />
                {index < auditLogs.length - 1 ? <span className="w-0 flex-1 border-l border-dashed border-flame-300" /> : null}
              </div>
              <div className={cn("flex min-w-0 flex-1 items-start justify-between gap-3 text-sm", index < auditLogs.length - 1 ? "pb-6" : "")}>
                <div className="min-w-0">
                  <div>{auditActionLabel(log.action)}</div>
                  <div className="truncate text-xs text-neutral-400">
                    {log.actorEmail
                      ? displayName({ email: log.actorEmail, firstName: log.actorFirstName, lastName: log.actorLastName })
                      : log.actorId ?? "System"}
                  </div>
                </div>
                <span className="shrink-0 text-xs text-neutral-400">{formatRelativeDate(log.createdAt)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
      {auditPagination ? (
        <div className="-mx-3 -mb-3 mt-3 shrink-0 rounded-b-2xl border-t border-neutral-100 bg-white px-2">
          <Pager pagination={{ ...auditPagination, offset: auditOffset }} count={auditLogs.length} onPage={loadAuditPage} />
        </div>
      ) : null}
    </div>
  );
}

function AddMemberDialog({
  token,
  workspace,
  onAdded,
  onError,
}: {
  token: string;
  workspace: Workspace;
  onAdded: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"admin" | "reviewer">("reviewer");
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await api.addMember(token, workspace.id, email, role);
      setEmail("");
      setRole("reviewer");
      setOpen(false);
      await onAdded();
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Add member"
          title="Add member"
          className="h-4 w-4 p-0 text-base leading-none text-neutral-400 hover:text-neutral-700"
        >
          +
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add member</DialogTitle>
          <DialogDescription>Invite a registered user to this workspace.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <Field label="Email">
            <Input value={email} onChange={(event) => setEmail(event.target.value)} type="email" required />
          </Field>
          <Field label="Role">
            <Select value={role} onValueChange={(value) => setRole(value as "admin" | "reviewer")}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="reviewer">Reviewer</SelectItem>
                <SelectItem value="admin">Admin</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Button disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Users className="h-4 w-4" />}
            Add
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DocumentsListPanel({
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

function SearchResultList({
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

function DocumentTable({
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

function DocumentQuickPreview({
  token,
  workspace,
  document,
  onFocus,
  onError,
}: {
  token: string;
  workspace: Workspace;
  document: ArchiveDocument | null;
  onFocus: () => void;
  onError: (message: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    setExpanded(false);
  }, [document?.id]);

  if (!document) {
    return (
      <section className="flex h-full min-h-[20rem] items-center justify-center rounded-2xl bg-white text-sm text-neutral-500">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        Loading document
      </section>
    );
  }

  const version = latestVersion(document);
  const openProposal = document.openProposedChange;

  return (
    <section className="flex h-full min-h-0 flex-col rounded-2xl bg-white p-3">
      <div className="flex shrink-0 items-start justify-between gap-3 pb-3">
        <div className="min-w-0">
          <h3 className="truncate text-lg">{document.title}</h3>
          <p className="mt-0.5 text-xs text-neutral-500">
            {version ? `v${version.version} · ${formatBytes(version.sizeBytes)}` : "No versions"}
          </p>
          {openProposal ? (
            <p className="mt-1 text-xs text-flame-500/60">{proposalStatusLabel(openProposal.status)}</p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setExpanded(true)}
            aria-label="Expand preview"
            title="Expand preview"
          >
            <Maximize2 className="h-4 w-4" />
          </Button>
          <Button variant="secondary" size="sm" onClick={onFocus}>
            Document details
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden rounded-lg border border-neutral-100 bg-white">
        {version ? (
          <VersionPreviewContent token={token} workspace={workspace} document={document} version={version} onError={onError} />
        ) : (
          <EmptyState icon={<FileText className="h-5 w-5" />} title="No versions yet" text="Upload a file to create the first version." />
        )}
      </div>
      <Dialog open={expanded} onOpenChange={setExpanded}>
        <DialogContent className="h-[95vh] w-[95vw] max-w-none overflow-hidden rounded-none border-0 bg-transparent p-0">
          {version ? (
            <VersionPreviewContent token={token} workspace={workspace} document={document} version={version} onError={onError} />
          ) : (
            <EmptyState icon={<FileText className="h-5 w-5" />} title="No versions yet" text="Upload a file to create the first version." />
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}

type DocumentViewMode = "versions" | "editing" | "review";

function DocumentFocusView({
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
                  {isOwnProposal ? (
                    <p className="mt-1 text-sm text-flame-500/60">Someone else on the workspace needs to approve this change.</p>
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
                    <div className="mb-5 shrink-0 rounded-md border border-red-200 bg-red-50 p-3">
                      <p className="text-sm text-red-800">
                        Changes requested by {latestRequest.reviewer ? displayName(latestRequest.reviewer) : "a reviewer"}
                      </p>
                      {latestRequest.body ? (
                        <p className="mt-1 whitespace-pre-wrap text-sm text-red-700">{latestRequest.body}</p>
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

function TasksPanel({
  tasks,
  loading,
  onComplete,
  currentUserId,
  isAdmin,
  members,
  onAssignTask,
  className,
}: {
  tasks: DocumentTask[];
  loading: boolean;
  onComplete: (taskId: string) => void;
  currentUserId: string | null;
  isAdmin: boolean;
  members: WorkspaceMember[];
  onAssignTask: (title: string, assigneeId: string) => Promise<void>;
  className?: string;
}) {
  const openTasks = tasks.filter((t) => t.status === "open");
  const doneTasks = tasks.filter((t) => t.status === "done");

  return (
    <div className={cn("flex min-h-0 flex-col rounded-2xl bg-white p-3", className)}>
      <div className="shrink-0 pb-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <CheckSquare className="h-4 w-4 shrink-0 text-neutral-400" />
            <h4 className="text-base">Tasks</h4>
          </div>
          <div className="mr-2 flex items-center gap-2">
            {loading ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-neutral-400" /> : null}
            <AssignTaskDialog members={members} onCreate={onAssignTask} />
          </div>
        </div>
        <p className="mt-2 text-sm text-neutral-500">Freeform assignments for this document.</p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {openTasks.length > 0 ? (
          <div className="divide-y divide-neutral-200">
            {openTasks.map((task) => (
              <div key={task.id} className="flex items-start justify-between gap-3 px-1 py-3.5">
                <div className="min-w-0">
                  <p className="text-sm">{task.title}</p>
                  <p className="mt-0.5 text-xs text-neutral-400">
                    Assigned to {task.assignee ? displayName(task.assignee) : "—"}
                    {task.createdBy ? ` · by ${displayName(task.createdBy)}` : ""}
                  </p>
                </div>
                {/* The API allows only the assignee, the task's creator, or an admin to complete
                    it, so anyone else would get a 403 from this button. */}
                {isAdmin ||
                (currentUserId &&
                  (task.assignee?.id === currentUserId || task.createdBy?.id === currentUserId)) ? (
                  <Button variant="secondary" size="sm" onClick={() => onComplete(task.id)}>
                    <CheckSquare className="h-4 w-4" />
                    Done
                  </Button>
                ) : null}
              </div>
            ))}
          </div>
        ) : (
          <div className="px-1 text-sm text-neutral-500">No open tasks.</div>
        )}
        {doneTasks.length > 0 ? (
          <div className="mt-3">
            <div className="px-1 pb-2 text-xs uppercase tracking-wide text-neutral-400">Completed</div>
            <div className="divide-y divide-neutral-200">
              {doneTasks.map((task) => (
                <div key={task.id} className="flex items-start gap-3 px-1 py-3.5 opacity-60">
                  <CheckSquare className="mt-0.5 h-4 w-4 shrink-0 text-green-600" />
                  <div className="min-w-0">
                    <p className="text-sm line-through">{task.title}</p>
                    <p className="mt-0.5 text-xs text-neutral-400">
                      Assigned to {task.assignee ? displayName(task.assignee) : "—"}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function RequestChangesDialog({
  onSubmit,
  busy,
  disabled,
  title,
}: {
  onSubmit: (message: string) => Promise<void>;
  busy: boolean;
  disabled: boolean;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!message.trim()) return;
    await onSubmit(message.trim());
    setMessage("");
    setOpen(false);
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="secondary" disabled={disabled} title={title}>
          <MessageSquare className="h-4 w-4" />
          Request changes
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Request changes</DialogTitle>
          <DialogDescription>
            Tell the author what needs to change before this can be approved. They'll see this note and get a Revise button to address it.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <Field label="What needs to change?">
            <textarea
              autoFocus
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder="e.g. Section 2 still references the old pricing — please update before resubmitting."
              className="min-h-[8rem] w-full resize-none rounded-md border border-neutral-100 bg-white px-3 py-2 text-sm leading-6 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
              required
            />
          </Field>
          <Button type="submit" disabled={busy || !message.trim()}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <MessageSquare className="h-4 w-4" />}
            Send request
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function AssignTaskDialog({
  members,
  onCreate,
}: {
  members: WorkspaceMember[];
  onCreate: (title: string, assigneeId: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [assigneeId, setAssigneeId] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open && !assigneeId && members.length > 0) {
      setAssigneeId(members[0].userId);
    }
  }, [open, members, assigneeId]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!title.trim() || !assigneeId) return;
    setBusy(true);
    try {
      await onCreate(title.trim(), assigneeId);
      setTitle("");
      setOpen(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-4 w-4 p-0 text-base leading-none text-neutral-400 hover:text-neutral-700"
          aria-label="Assign task"
          title="Assign task"
        >
          +
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Assign task</DialogTitle>
          <DialogDescription>Create a freeform assignment for a workspace member on this document.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <Field label="Task">
            <Input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="e.g. Review the closing section"
              required
            />
          </Field>
          <Field label="Assign to">
            <Select value={assigneeId} onValueChange={setAssigneeId} disabled={members.length === 0}>
              <SelectTrigger><SelectValue placeholder="Select member" /></SelectTrigger>
              <SelectContent>
                {members.map((m) => (
                  <SelectItem key={m.userId} value={m.userId}>{displayName(m)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Button disabled={busy || !title.trim() || !assigneeId}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            Add
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const DIFF_CONTEXT_LINES = 12;

type DiffSegment =
  | { kind: "line"; index: number; line: LineDiffLine }
  | { kind: "collapsed"; id: string; startIndex: number; endIndex: number; count: number };

function buildDiffSegments(lines: LineDiffLine[]): DiffSegment[] {
  const segments: DiffSegment[] = [];
  let i = 0;

  while (i < lines.length) {
    if (lines[i].type !== "unchanged") {
      segments.push({ kind: "line", index: i, line: lines[i] });
      i++;
      continue;
    }

    let j = i;
    while (j < lines.length && lines[j].type === "unchanged") j++;
    const runLength = j - i;
    const leadContext = i === 0 ? 0 : DIFF_CONTEXT_LINES;
    const trailContext = j === lines.length ? 0 : DIFF_CONTEXT_LINES;
    const hiddenCount = runLength - leadContext - trailContext;

    if (hiddenCount <= 0) {
      for (let k = i; k < j; k++) segments.push({ kind: "line", index: k, line: lines[k] });
    } else {
      for (let k = i; k < i + leadContext; k++) segments.push({ kind: "line", index: k, line: lines[k] });
      segments.push({
        kind: "collapsed",
        id: `${i + leadContext}-${j - trailContext}`,
        startIndex: i + leadContext,
        endIndex: j - trailContext,
        count: hiddenCount,
      });
      for (let k = j - trailContext; k < j; k++) segments.push({ kind: "line", index: k, line: lines[k] });
    }
    i = j;
  }

  return segments;
}

function ProposedChangeDiffView({
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

function DiffLineWithComments({
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


function VersionRow({
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

function VersionPreviewContent({
  token,
  workspace,
  document,
  version,
  onError,
  className,
}: {
  token: string;
  workspace: Workspace;
  document: ArchiveDocument;
  version: DocumentVersion;
  onError: (message: string) => void;
  className?: string;
}) {
  const [busy, setBusy] = useState(true);
  const [text, setText] = useState<string | null>(null);
  const kind = previewKind(version.mimeType);

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    setText(null);

    async function loadPreview() {
      try {
        const file = await api.previewVersion(token, workspace.id, document.id, version.version);
        if (cancelled) return;
        if (kind === "text" || kind === "html") {
          setText(await file.blob.text());
        }
      } catch (error) {
        if (!cancelled) onError(errorMessage(error));
      } finally {
        if (!cancelled) setBusy(false);
      }
    }

    void loadPreview();
    return () => {
      cancelled = true;
    };
  }, [token, workspace.id, document.id, version.id, version.version, kind]);

  return (
    <div className={cn("h-full w-full", className)}>
      {busy ? (
        <div className="grid h-full place-items-center text-sm text-neutral-500">
          <span className="flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" />Loading preview</span>
        </div>
      ) : kind === "html" && text !== null ? (
        <iframe
          title={`${document.title} version ${version.version}`}
          srcDoc={text}
          sandbox=""
          className="h-full w-full border-0 bg-neutral-100"
        />
      ) : kind === "text" && text !== null ? (
        <pre className="h-full overflow-auto whitespace-pre-wrap p-4 font-mono text-sm leading-6 text-neutral-800">{text}</pre>
      ) : (
        <EmptyState
          icon={<FileText className="h-5 w-5" />}
          title="Preview unavailable"
          text="This file type cannot be displayed in the browser."
        />
      )}
    </div>
  );
}

function RenameDocumentDialog({
  token,
  workspace,
  document,
  onRenamed,
  onError,
  iconOnly,
}: {
  token: string;
  workspace: Workspace;
  document: ArchiveDocument;
  onRenamed: () => Promise<void>;
  onError: (message: string) => void;
  iconOnly?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(document.title);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) setTitle(document.title);
  }, [document.title, open]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const nextTitle = title.trim();
    if (!nextTitle) return;
    setBusy(true);
    try {
      await api.renameDocument(token, workspace.id, document.id, nextTitle);
      setOpen(false);
      await onRenamed();
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {iconOnly ? (
          <Button variant="ghost" size="icon" aria-label="Rename document" title="Rename">
            <Pencil className="h-4 w-4" />
          </Button>
        ) : (
          <Button variant="secondary" size="sm"><Pencil className="h-4 w-4" />Rename</Button>
        )}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename document</DialogTitle>
          <DialogDescription>Update the title shown in lists, search results, and audit metadata.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <Field label="Title">
            <Input value={title} onChange={(event) => setTitle(event.target.value)} required />
          </Field>
          <Button disabled={busy || !title.trim()}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Pencil className="h-4 w-4" />}
            Save
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ArchiveDocumentDialog({
  token,
  workspace,
  document,
  onArchived,
  onError,
}: {
  token: string;
  workspace: Workspace;
  document: ArchiveDocument;
  onArchived: () => void;
  onError: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function archiveDocument() {
    setBusy(true);
    try {
      await api.archiveDocument(token, workspace.id, document.id);
      setOpen(false);
      onArchived();
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="secondary" size="sm"><Archive className="h-4 w-4" />Archive</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Archive document</DialogTitle>
          <DialogDescription>Remove this document from active lists and search without deleting its history.</DialogDescription>
        </DialogHeader>
        <div className="rounded-md border border-neutral-100 bg-neutral-50 p-3">
          <div className="text-sm">{document.title}</div>
          <div className="mt-1 text-sm text-neutral-500">{document.versions?.length ?? 0} versions will be hidden from active workflows.</div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
          <Button type="button" variant="danger" onClick={archiveDocument} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Archive className="h-4 w-4" />}
            Archive
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function UploadDocumentDialog({
  token,
  workspace,
  onUploaded,
  onError,
  compact,
}: {
  token: string;
  workspace: Workspace;
  onUploaded: () => Promise<void>;
  onError: (message: string) => void;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!file) return;
    if (!isSupportedUploadFile(file)) {
      onError("Upload a .txt, .md, or .docx file. PDFs are not editable source documents.");
      return;
    }
    setBusy(true);
    try {
      await api.uploadDocument(token, workspace.id, title || file.name, file);
      setTitle("");
      setFile(null);
      setOpen(false);
      await onUploaded();
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {compact ? (
          <Button variant="ghost" size="icon" aria-label="Upload document"><Upload className="h-4 w-4" /></Button>
        ) : (
          <Button><Upload className="h-4 w-4" />Upload</Button>
        )}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Upload document</DialogTitle>
          <DialogDescription>Create a document with version 1 from a text, Markdown, or DOCX file.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <Field label="Title">
            <Input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Defaults to filename" />
          </Field>
          <Field label="File">
            <Input type="file" accept={SUPPORTED_UPLOAD_ACCEPT} onChange={(event) => setFile(event.target.files?.[0] ?? null)} required />
          </Field>
          <Button disabled={busy || !file}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />} Upload</Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Pager({
  pagination,
  count,
  onPage,
}: {
  pagination: Pagination | null;
  count: number;
  onPage: (offset: number) => void | Promise<void>;
}) {
  if (!pagination) return null;

  return (
    <div className="flex items-center justify-between border-t border-neutral-100 px-2 py-3 text-sm text-neutral-600">
      <span>
        {count === 0
          ? "No results"
          : `Showing ${pagination.offset + 1} to ${pagination.offset + count}`}
      </span>
      <div className="flex gap-1">
        <Button variant="secondary" size="icon" disabled={pagination.offset === 0} onClick={() => onPage(Math.max(0, pagination.offset - pagination.limit))} aria-label="Previous page">
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <Button variant="secondary" size="icon" disabled={pagination.nextOffset === null} onClick={() => pagination.nextOffset !== null && onPage(pagination.nextOffset)} aria-label="Next page">
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

// The label was previously not associated with its input at all — no htmlFor, no id — so screen
// readers announced an unlabelled field and clicking the label did nothing. Generating the id
// here keeps every call site unchanged.
function Field({ label, children }: { label: string; children: React.ReactElement<{ id?: string }> }) {
  const id = useId();

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      {cloneElement(children, { id })}
    </div>
  );
}

function EmptyState({ icon, title, text }: { icon: React.ReactNode; title: string; text: string }) {
  return (
    <div className="grid h-full min-h-[14rem] place-items-center p-8 text-center">
      <div>
        <div className="mx-auto grid h-10 w-10 place-items-center rounded-md bg-neutral-100 text-neutral-600">{icon}</div>
        <h3 className="mt-3 text-base">{title}</h3>
        <p className="mt-1 max-w-sm text-sm text-neutral-500">{text}</p>
      </div>
    </div>
  );
}
