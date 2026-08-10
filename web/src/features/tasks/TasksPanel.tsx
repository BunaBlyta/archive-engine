import type { DocumentTask, WorkspaceMember } from "../../api/types";
import { Button } from "../../components/ui/button";
import { cn, displayName } from "../../lib/utils";
import { AssignTaskDialog } from "./AssignTaskDialog";
import { CheckSquare, Loader2 } from "lucide-react";

export function TasksPanel({
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
