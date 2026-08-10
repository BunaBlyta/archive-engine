import { api } from "../../api/client";
import type { Workspace, WorkspaceDashboardMember } from "../../api/types";
import { EmptyState } from "../../components/EmptyState";
import { errorMessage } from "../../lib/format";
import type { Notice } from "../../lib/types";
import { displayName, formatRelativeDate, initials } from "../../lib/utils";
import { AddMemberDialog } from "./AddMemberDialog";
import { Activity, Loader2, Shield, Users } from "lucide-react";
import { useEffect, useState } from "react";

export function DashboardPanel({
  token,
  workspace,
  onError,
  onNotice,
  onOpenActivityLog,
}: {
  token: string;
  workspace: Workspace;
  onError: (message: string) => void;
  onNotice: (notice: Notice) => void;
  onOpenActivityLog: () => void;
}) {
  const [members, setMembers] = useState<WorkspaceDashboardMember[]>([]);
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const dashData = await api.getDashboard(token, workspace.id);
      setMembers(dashData.members);
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, [workspace.id]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <section className="flex min-h-0 flex-1 flex-col rounded-2xl bg-white p-3">
        <div className="shrink-0 pb-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <Users className="h-4 w-4 shrink-0 text-neutral-400" />
              <h3 className="text-base">Members</h3>
              {workspace.role === "admin" ? (
                <div className="-ml-2">
                  <AddMemberDialog
                    token={token}
                    workspace={workspace}
                    onAdded={async () => {
                      await load();
                      onNotice({ title: "Member added" });
                    }}
                    onError={onError}
                  />
                </div>
              ) : null}
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onOpenActivityLog}
                className="flex items-center gap-1.5 text-[11px] text-accent-400 hover:text-accent-600"
              >
                <Activity className="h-3 w-3 shrink-0" />
                Recent activity
              </button>
              {loading ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-neutral-400" /> : null}
            </div>
          </div>
          <p className="mt-3 text-sm text-neutral-500">{members.length} with access</p>
        </div>
        {members.length === 0 ? (
          <EmptyState icon={<Users className="h-5 w-5" />} title="No members found" text="Workspace members will appear here." />
        ) : (
          <div className="min-h-0 flex-1 divide-y divide-neutral-200 overflow-y-auto">
            {members.map((member) => (
              <div key={member.userId} className="flex items-center gap-3 px-1 py-3.5 text-sm">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-accent-300 to-accent-500 text-xs text-white">
                  {initials(member)}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-sm">{displayName(member)}</span>
                    {member.role === "admin" ? <Shield className="h-3 w-3 shrink-0 text-accent-400" aria-label="Admin" /> : null}
                  </div>
                  <div className="text-xs text-neutral-400">{member.contributionCount} contributions</div>
                </div>
                <div className="shrink-0 text-xs text-neutral-400">{formatRelativeDate(member.createdAt)}</div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
