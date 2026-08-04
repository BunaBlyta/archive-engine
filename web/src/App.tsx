import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  ArrowDownToLine,
  FilePlus2,
  FileText,
  History,
  Loader2,
  LogOut,
  Plus,
  RefreshCw,
  Search,
  Shield,
  Upload,
  Users,
} from "lucide-react";
import { api, ApiError } from "./api/client";
import type { ArchiveDocument, AuditLog, DocumentVersion, Pagination, SearchResult, Workspace } from "./api/types";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./components/ui/tabs";
import { Toast, ToastDescription, ToastProvider, ToastTitle, ToastViewport } from "./components/ui/toast";
import { cn, formatBytes, formatDate } from "./lib/utils";

type Notice = { title: string; description?: string };

const PAGE_SIZE = 25;

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

function latestVersion(document: ArchiveDocument) {
  return document.latestVersion ?? document.versions?.[document.versions.length - 1] ?? null;
}

export function App() {
  const {
    accessToken,
    user,
    workspaces,
    selectedWorkspaceId,
    setSession,
    clearSession,
    setWorkspaces,
    selectWorkspace,
  } = useAppStore();
  const [booting, setBooting] = useState(true);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selectedWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ?? null,
    [selectedWorkspaceId, workspaces]
  );

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

  async function handleLogout() {
    try {
      await api.logout();
    } finally {
      clearSession();
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
      <main className="min-h-screen bg-neutral-50 text-neutral-950">
        {!accessToken ? (
          <AuthScreen
            onAuthed={async (token, authedUser) => {
              setSession(token, authedUser);
              await loadWorkspaces(token);
            }}
            onError={setError}
          />
        ) : (
          <div className="grid min-h-screen grid-cols-1 lg:grid-cols-[18rem_1fr]">
            <aside className="border-b border-neutral-200 bg-white lg:border-b-0 lg:border-r">
              <div className="flex h-full flex-col">
                <div className="flex h-16 items-center gap-3 border-b border-neutral-200 px-5">
                  <div className="grid h-9 w-9 place-items-center rounded-md bg-neutral-950 text-white">
                    <FileText className="h-5 w-5" />
                  </div>
                  <div>
                    <div className="text-sm font-semibold">Archive Engine</div>
                    <div className="text-xs text-neutral-500">{user?.email ?? "Signed in"}</div>
                  </div>
                </div>
                <WorkspaceRail
                  workspaces={workspaces}
                  selectedWorkspaceId={selectedWorkspaceId}
                  onSelect={selectWorkspace}
                  onCreate={async (name) => {
                    await api.createWorkspace(accessToken, name);
                    await loadWorkspaces();
                    setNotice({ title: "Workspace created" });
                  }}
                  onError={setError}
                />
                <div className="mt-auto border-t border-neutral-200 p-4">
                  <Button variant="ghost" className="w-full justify-start" onClick={handleLogout}>
                    <LogOut className="h-4 w-4" />
                    Sign out
                  </Button>
                </div>
              </div>
            </aside>
            <section className="min-w-0">
              {selectedWorkspace ? (
                <WorkspaceView
                  token={accessToken}
                  workspace={selectedWorkspace}
                  onError={setError}
                  onNotice={setNotice}
                />
              ) : (
                <EmptyState
                  icon={<Plus className="h-5 w-5" />}
                  title="Create a workspace to start"
                  text="Workspaces keep documents, versions, search, members, and audit logs together."
                />
              )}
            </section>
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

function AuthScreen({
  onAuthed,
  onError,
}: {
  onAuthed: (token: string, user: { id: string; email: string }) => Promise<void>;
  onError: (message: string) => void;
}) {
  const [mode, setMode] = useState("login");
  const [email, setEmail] = useState("test@example.com");
  const [password, setPassword] = useState("password123");
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const data = mode === "login"
        ? await api.login(email, password)
        : await api.register(email, password);
      await onAuthed(data.accessToken, data.user);
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="grid min-h-screen place-items-center px-4">
      <form onSubmit={submit} className="w-full max-w-sm rounded-lg border border-neutral-200 bg-white p-6 shadow-sm">
        <div className="mb-6 flex items-center gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-md bg-neutral-950 text-white">
            <FileText className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-lg font-semibold">Archive Engine</h1>
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

function WorkspaceRail({
  workspaces,
  selectedWorkspaceId,
  onSelect,
  onCreate,
  onError,
}: {
  workspaces: Workspace[];
  selectedWorkspaceId: string | null;
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
    <div className="flex-1 p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="text-xs font-semibold uppercase tracking-wide text-neutral-500">Workspaces</div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="Create workspace">
              <Plus className="h-4 w-4" />
            </Button>
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
              <Button disabled={busy}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Create</Button>
            </form>
          </DialogContent>
        </Dialog>
      </div>
      <div className="space-y-1">
        {workspaces.map((workspace) => (
          <button
            key={workspace.id}
            type="button"
            onClick={() => onSelect(workspace.id)}
            className={cn(
              "flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-neutral-100",
              workspace.id === selectedWorkspaceId && "bg-neutral-950 text-white hover:bg-neutral-900"
            )}
          >
            <span className="truncate font-medium">{workspace.name}</span>
            <span className={cn("ml-2 text-xs", workspace.id === selectedWorkspaceId ? "text-neutral-300" : "text-neutral-500")}>
              {workspace.role}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function WorkspaceView({
  token,
  workspace,
  onError,
  onNotice,
}: {
  token: string;
  workspace: Workspace;
  onError: (message: string) => void;
  onNotice: (notice: Notice) => void;
}) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-neutral-200 bg-white px-5 py-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-xl font-semibold">{workspace.name}</h2>
            <p className="text-sm text-neutral-500">Role: {workspace.role} · Created {formatDate(workspace.createdAt)}</p>
          </div>
          <Badge tone={workspace.role === "admin" ? "blue" : "neutral"}>{workspace.role}</Badge>
        </div>
      </header>
      <Tabs defaultValue="documents" className="flex-1">
        <div className="border-b border-neutral-200 bg-white px-5 py-3">
          <TabsList>
            <TabsTrigger value="documents"><FileText className="mr-2 h-4 w-4" />Documents</TabsTrigger>
            <TabsTrigger value="search"><Search className="mr-2 h-4 w-4" />Search</TabsTrigger>
            <TabsTrigger value="audit"><Activity className="mr-2 h-4 w-4" />Audit</TabsTrigger>
            <TabsTrigger value="members"><Users className="mr-2 h-4 w-4" />Members</TabsTrigger>
          </TabsList>
        </div>
        <div className="p-5">
          <TabsContent value="documents">
            <DocumentsPanel token={token} workspace={workspace} onError={onError} onNotice={onNotice} />
          </TabsContent>
          <TabsContent value="search">
            <SearchPanel token={token} workspace={workspace} onError={onError} />
          </TabsContent>
          <TabsContent value="audit">
            <AuditPanel token={token} workspace={workspace} onError={onError} />
          </TabsContent>
          <TabsContent value="members">
            <MembersPanel token={token} workspace={workspace} onError={onError} onNotice={onNotice} />
          </TabsContent>
        </div>
      </Tabs>
    </div>
  );
}

function DocumentsPanel({
  token,
  workspace,
  onError,
  onNotice,
}: {
  token: string;
  workspace: Workspace;
  onError: (message: string) => void;
  onNotice: (notice: Notice) => void;
}) {
  const [documents, setDocuments] = useState<ArchiveDocument[]>([]);
  const [pagination, setPagination] = useState<Pagination | null>(null);
  const [selected, setSelected] = useState<ArchiveDocument | null>(null);
  const [busy, setBusy] = useState(false);
  const [offset, setOffset] = useState(0);

  async function load(nextOffset = offset) {
    setBusy(true);
    try {
      const data = await api.listDocuments(token, workspace.id, nextOffset, PAGE_SIZE);
      setDocuments(data.documents);
      setPagination(data.pagination);
      setOffset(nextOffset);
      if (selected && !data.documents.some((document) => document.id === selected.id)) {
        setSelected(null);
      }
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function loadDocument(documentId: string) {
    try {
      const data = await api.getDocument(token, workspace.id, documentId);
      setSelected(data.document);
    } catch (error) {
      onError(errorMessage(error));
    }
  }

  useEffect(() => {
    setSelected(null);
    setOffset(0);
    void load(0);
  }, [workspace.id]);

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_26rem]">
      <section className="min-w-0 rounded-lg border border-neutral-200 bg-white">
        <div className="flex flex-col gap-3 border-b border-neutral-200 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h3 className="font-semibold">Documents</h3>
            <p className="text-sm text-neutral-500">Upload files, add versions, and download exact revisions.</p>
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => load()} disabled={busy}>
              <RefreshCw className={cn("h-4 w-4", busy && "animate-spin")} />
              Refresh
            </Button>
            <UploadDocumentDialog
              token={token}
              workspace={workspace}
              onUploaded={async () => {
                await load(0);
                onNotice({ title: "Document uploaded" });
              }}
              onError={onError}
            />
          </div>
        </div>
        <DocumentTable documents={documents} selectedId={selected?.id ?? null} onSelect={loadDocument} busy={busy} />
        <Pager pagination={pagination} onPage={load} />
      </section>
      <DocumentDetail
        token={token}
        workspace={workspace}
        document={selected}
        onChanged={async (documentId) => {
          await loadDocument(documentId);
          await load();
        }}
        onError={onError}
        onNotice={onNotice}
      />
    </div>
  );
}

function DocumentTable({
  documents,
  selectedId,
  onSelect,
  busy,
}: {
  documents: ArchiveDocument[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  busy: boolean;
}) {
  if (!busy && documents.length === 0) {
    return <EmptyState icon={<FilePlus2 className="h-5 w-5" />} title="No documents yet" text="Upload the first file for this workspace." />;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[44rem] text-left text-sm">
        <thead className="bg-neutral-50 text-xs uppercase tracking-wide text-neutral-500">
          <tr>
            <th className="px-4 py-3 font-semibold">Title</th>
            <th className="px-4 py-3 font-semibold">Latest</th>
            <th className="px-4 py-3 font-semibold">Search</th>
            <th className="px-4 py-3 font-semibold">Uploaded</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-100">
          {documents.map((document) => {
            const version = latestVersion(document);
            return (
              <tr
                key={document.id}
                onClick={() => onSelect(document.id)}
                className={cn("cursor-pointer hover:bg-neutral-50", selectedId === document.id && "bg-blue-50")}
              >
                <td className="px-4 py-3 font-medium">{document.title}</td>
                <td className="px-4 py-3 text-neutral-600">{version ? `v${version.version} · ${formatBytes(version.sizeBytes)}` : "None"}</td>
                <td className="px-4 py-3">
                  <Badge tone={statusTone(version?.search?.status)}>{version?.search?.status ?? "not indexed"}</Badge>
                </td>
                <td className="px-4 py-3 text-neutral-600">{formatDate(document.createdAt)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function DocumentDetail({
  token,
  workspace,
  document,
  onChanged,
  onError,
  onNotice,
}: {
  token: string;
  workspace: Workspace;
  document: ArchiveDocument | null;
  onChanged: (documentId: string) => Promise<void>;
  onError: (message: string) => void;
  onNotice: (notice: Notice) => void;
}) {
  if (!document) {
    return (
      <section className="rounded-lg border border-dashed border-neutral-300 bg-white">
        <EmptyState icon={<History className="h-5 w-5" />} title="Select a document" text="Version history and downloads show here." />
      </section>
    );
  }

  return (
    <section className="rounded-lg border border-neutral-200 bg-white">
      <div className="border-b border-neutral-200 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="truncate font-semibold">{document.title}</h3>
            <p className="mt-1 text-xs text-neutral-500">{document.id}</p>
          </div>
          <UploadVersionDialog
            token={token}
            workspace={workspace}
            document={document}
            onUploaded={async () => {
              await onChanged(document.id);
              onNotice({ title: "Version uploaded" });
            }}
            onError={onError}
          />
        </div>
      </div>
      <div className="divide-y divide-neutral-100">
        {[...(document.versions ?? [])].reverse().map((version) => (
          <VersionRow
            key={version.id}
            token={token}
            workspace={workspace}
            document={document}
            version={version}
            onError={onError}
          />
        ))}
      </div>
    </section>
  );
}

function VersionRow({
  token,
  workspace,
  document,
  version,
  onError,
}: {
  token: string;
  workspace: Workspace;
  document: ArchiveDocument;
  version: DocumentVersion;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);

  async function download() {
    setBusy(true);
    try {
      const { blob, filename } = await api.downloadVersion(token, workspace.id, document.id, version.version);
      const url = URL.createObjectURL(blob);
      const link = window.document.createElement("a");
      link.href = url;
      link.download = filename;
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">Version {version.version}</span>
            <Badge tone={statusTone(version.search?.status)}>{version.search?.status ?? "not indexed"}</Badge>
          </div>
          <div className="mt-1 truncate text-sm text-neutral-600">{version.originalFilename ?? "Unnamed file"}</div>
          <div className="mt-1 text-xs text-neutral-500">{formatBytes(version.sizeBytes)} · {version.mimeType} · {formatDate(version.createdAt)}</div>
          <div className="mt-2 break-all font-mono text-[11px] text-neutral-400">{version.sha256}</div>
        </div>
        <Button variant="secondary" size="icon" onClick={download} disabled={busy} aria-label={`Download version ${version.version}`}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowDownToLine className="h-4 w-4" />}
        </Button>
      </div>
      {version.search?.error ? <p className="mt-2 text-sm text-red-600">{version.search.error}</p> : null}
    </div>
  );
}

function UploadDocumentDialog({
  token,
  workspace,
  onUploaded,
  onError,
}: {
  token: string;
  workspace: Workspace;
  onUploaded: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!file) return;
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
        <Button><Upload className="h-4 w-4" />Upload</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Upload document</DialogTitle>
          <DialogDescription>Create a document with version 1 from a text file or searchable PDF.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <Field label="Title">
            <Input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Defaults to filename" />
          </Field>
          <Field label="File">
            <Input type="file" onChange={(event) => setFile(event.target.files?.[0] ?? null)} required />
          </Field>
          <Button disabled={busy || !file}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />} Upload</Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function UploadVersionDialog({
  token,
  workspace,
  document,
  onUploaded,
  onError,
}: {
  token: string;
  workspace: Workspace;
  document: ArchiveDocument;
  onUploaded: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!file) return;
    setBusy(true);
    try {
      await api.uploadVersion(token, workspace.id, document.id, file);
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
        <Button variant="secondary" size="sm"><Plus className="h-4 w-4" />Version</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add version</DialogTitle>
          <DialogDescription>Attach the next revision to {document.title}.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <Field label="File">
            <Input type="file" onChange={(event) => setFile(event.target.files?.[0] ?? null)} required />
          </Field>
          <Button disabled={busy || !file}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />} Add version</Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function SearchPanel({ token, workspace, onError }: { token: string; workspace: Workspace; onError: (message: string) => void }) {
  const [query, setQuery] = useState("banana");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [pagination, setPagination] = useState<Pagination | null>(null);
  const [offset, setOffset] = useState(0);
  const [busy, setBusy] = useState(false);

  async function runSearch(nextOffset = 0) {
    if (!query.trim()) return;
    setBusy(true);
    try {
      const data = await api.searchDocuments(token, workspace.id, query, nextOffset, PAGE_SIZE);
      setResults(data.results);
      setPagination(data.pagination);
      setOffset(nextOffset);
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    setResults([]);
    setPagination(null);
    setOffset(0);
  }, [workspace.id]);

  return (
    <section className="rounded-lg border border-neutral-200 bg-white">
      <form onSubmit={(event) => { event.preventDefault(); void runSearch(0); }} className="flex flex-col gap-3 border-b border-neutral-200 p-4 sm:flex-row">
        <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search text and PDF contents" />
        <Button disabled={busy || !query.trim()}><Search className="h-4 w-4" />Search</Button>
      </form>
      <div className="divide-y divide-neutral-100">
        {results.length === 0 ? (
          <EmptyState icon={<Search className="h-5 w-5" />} title="No search results" text="Search indexes are created when documents are uploaded." />
        ) : results.map((result) => (
          <div key={`${result.document.id}-${result.version.id}`} className="p-4">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="font-semibold">{result.document.title}</h3>
              <Badge tone="green">v{result.version.version}</Badge>
              <Badge tone={statusTone(result.search.status)}>{result.search.status}</Badge>
            </div>
            <p className="mt-2 text-sm text-neutral-700">{result.search.snippet ?? "Matched indexed content"}</p>
            <p className="mt-2 text-xs text-neutral-500">{result.version.originalFilename ?? result.version.mimeType} · {formatDate(result.search.indexedAt)}</p>
          </div>
        ))}
      </div>
      <Pager pagination={pagination ? { ...pagination, offset } : null} onPage={runSearch} />
    </section>
  );
}

function AuditPanel({ token, workspace, onError }: { token: string; workspace: Workspace; onError: (message: string) => void }) {
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [pagination, setPagination] = useState<Pagination | null>(null);
  const [offset, setOffset] = useState(0);
  const [busy, setBusy] = useState(false);

  async function load(nextOffset = offset) {
    setBusy(true);
    try {
      const data = await api.listAuditLogs(token, workspace.id, nextOffset, PAGE_SIZE);
      setLogs(data.auditLogs);
      setPagination(data.pagination);
      setOffset(nextOffset);
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    setOffset(0);
    void load(0);
  }, [workspace.id]);

  return (
    <section className="rounded-lg border border-neutral-200 bg-white">
      <div className="flex items-center justify-between border-b border-neutral-200 p-4">
        <div>
          <h3 className="font-semibold">Audit log</h3>
          <p className="text-sm text-neutral-500">Recent document and membership events.</p>
        </div>
        <Button variant="secondary" onClick={() => load()} disabled={busy}>
          <RefreshCw className={cn("h-4 w-4", busy && "animate-spin")} />
          Refresh
        </Button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[48rem] text-left text-sm">
          <thead className="bg-neutral-50 text-xs uppercase tracking-wide text-neutral-500">
            <tr>
              <th className="px-4 py-3 font-semibold">Action</th>
              <th className="px-4 py-3 font-semibold">Entity</th>
              <th className="px-4 py-3 font-semibold">Actor</th>
              <th className="px-4 py-3 font-semibold">When</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-100">
            {logs.map((log) => (
              <tr key={log.id}>
                <td className="px-4 py-3 font-medium">{log.action}</td>
                <td className="px-4 py-3 text-neutral-600">{log.entityType}</td>
                <td className="px-4 py-3 text-neutral-600">{log.actorEmail ?? log.actorId ?? "System"}</td>
                <td className="px-4 py-3 text-neutral-600">{formatDate(log.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {logs.length === 0 ? <EmptyState icon={<Activity className="h-5 w-5" />} title="No audit events" text="Events appear as files and members change." /> : null}
      <Pager pagination={pagination ? { ...pagination, offset } : null} onPage={load} />
    </section>
  );
}

function MembersPanel({
  token,
  workspace,
  onError,
  onNotice,
}: {
  token: string;
  workspace: Workspace;
  onError: (message: string) => void;
  onNotice: (notice: Notice) => void;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"admin" | "member">("member");
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await api.addMember(token, workspace.id, email, role);
      setEmail("");
      setRole("member");
      onNotice({ title: "Member added" });
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="max-w-xl rounded-lg border border-neutral-200 bg-white p-5">
      <div className="mb-5">
        <h3 className="font-semibold">Add member</h3>
        <p className="text-sm text-neutral-500">Admins can add registered users to this workspace.</p>
      </div>
      <form onSubmit={submit} className="grid gap-4 sm:grid-cols-[1fr_10rem_auto] sm:items-end">
        <Field label="Email">
          <Input value={email} onChange={(event) => setEmail(event.target.value)} type="email" required disabled={workspace.role !== "admin"} />
        </Field>
        <Field label="Role">
          <Select value={role} onValueChange={(value) => setRole(value as "admin" | "member")} disabled={workspace.role !== "admin"}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="member">Member</SelectItem>
              <SelectItem value="admin">Admin</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Button disabled={busy || workspace.role !== "admin"}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Users className="h-4 w-4" />}
          Add
        </Button>
      </form>
      {workspace.role !== "admin" ? <p className="mt-4 text-sm text-neutral-500">Your current role can read documents but cannot add members.</p> : null}
    </section>
  );
}

function Pager({ pagination, onPage }: { pagination: Pagination | null; onPage: (offset: number) => void | Promise<void> }) {
  if (!pagination) return null;

  return (
    <div className="flex items-center justify-between border-t border-neutral-200 px-4 py-3 text-sm text-neutral-600">
      <span>Showing {pagination.offset + 1} to {pagination.offset + pagination.limit}</span>
      <div className="flex gap-2">
        <Button variant="secondary" size="sm" disabled={pagination.offset === 0} onClick={() => onPage(Math.max(0, pagination.offset - pagination.limit))}>
          Previous
        </Button>
        <Button variant="secondary" size="sm" disabled={pagination.nextOffset === null} onClick={() => pagination.nextOffset !== null && onPage(pagination.nextOffset)}>
          Next
        </Button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      {children}
    </div>
  );
}

function EmptyState({ icon, title, text }: { icon: React.ReactNode; title: string; text: string }) {
  return (
    <div className="grid min-h-[14rem] place-items-center p-8 text-center">
      <div>
        <div className="mx-auto grid h-10 w-10 place-items-center rounded-md bg-neutral-100 text-neutral-600">{icon}</div>
        <h3 className="mt-3 font-semibold">{title}</h3>
        <p className="mt-1 max-w-sm text-sm text-neutral-500">{text}</p>
      </div>
    </div>
  );
}
