import type { Workspace } from "../../api/types";
import { EmptyState } from "../../components/EmptyState";
import { Field } from "../../components/Field";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { Select } from "../../components/ui/select";
import { errorMessage } from "../../lib/format";
import { formatRelativeDate } from "../../lib/utils";
import { Loader2, Plus } from "lucide-react";
import { useState } from "react";
import type { FormEvent } from "react";

export function WorkspacesLanding({
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
