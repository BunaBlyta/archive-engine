import { api } from "../../api/client";
import type { Workspace } from "../../api/types";
import { Field } from "../../components/Field";
import { Button } from "../../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { errorMessage } from "../../lib/format";
import { Loader2, Users } from "lucide-react";
import { useState } from "react";
import type { FormEvent } from "react";

export function AddMemberDialog({
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
