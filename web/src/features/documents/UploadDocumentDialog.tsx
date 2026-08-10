import { api } from "../../api/client";
import type { Workspace } from "../../api/types";
import { Field } from "../../components/Field";
import { Button } from "../../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { SUPPORTED_UPLOAD_ACCEPT } from "../../lib/constants";
import { errorMessage, isSupportedUploadFile } from "../../lib/format";
import { Loader2, Upload } from "lucide-react";
import { useState } from "react";
import type { FormEvent } from "react";

export function UploadDocumentDialog({
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
