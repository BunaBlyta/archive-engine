import { Field } from "../../components/Field";
import { Button } from "../../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "../../components/ui/dialog";
import { Loader2, MessageSquare } from "lucide-react";
import { useState } from "react";
import type { FormEvent } from "react";

export function RequestChangesDialog({
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
