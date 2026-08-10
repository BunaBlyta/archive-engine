import { api } from "../../api/client";
import type { ArchiveDocument, Workspace } from "../../api/types";
import { Button } from "../../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "../../components/ui/dialog";
import { errorMessage } from "../../lib/format";
import { Archive, Loader2 } from "lucide-react";
import { useState } from "react";

export function ArchiveDocumentDialog({
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
