import type { Review, WorkspaceMember } from "../../api/types";
import { Field } from "../../components/Field";
import { Button } from "../../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { displayName } from "../../lib/utils";
import { Loader2, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import type { FormEvent } from "react";

export function AssignTaskDialog({
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
