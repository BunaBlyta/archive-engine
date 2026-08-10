import { api } from "../../api/client";
import type { AuditLog, Pagination, Workspace } from "../../api/types";
import { EmptyState } from "../../components/EmptyState";
import { Pager } from "../../components/Pager";
import { PAGE_SIZE } from "../../lib/constants";
import { auditActionLabel, errorMessage } from "../../lib/format";
import { cn, displayName, formatRelativeDate } from "../../lib/utils";
import { Activity } from "lucide-react";
import { useEffect, useState } from "react";

export function ActivityLogPage({
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
                  <div className="truncate">
                    {auditActionLabel(log.action)}
                    {log.document ? (
                      <span className="text-neutral-400"> · {log.document.title}</span>
                    ) : null}
                  </div>
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
