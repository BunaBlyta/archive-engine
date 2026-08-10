import { api } from "../../api/client";
import type { ArchiveDocument, Workspace } from "../../api/types";
import { Field } from "../../components/Field";
import { Button } from "../../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { errorMessage } from "../../lib/format";
import { Loader2, Pencil, Save } from "lucide-react";
import { useEffect, useState } from "react";
import type { FormEvent } from "react";

export function RenameDocumentDialog({
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
