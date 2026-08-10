import type { ArchiveDocument, Workspace } from "../../api/types";
import { EmptyState } from "../../components/EmptyState";
import { Button } from "../../components/ui/button";
import { Dialog, DialogContent } from "../../components/ui/dialog";
import { latestVersion, proposalStatusLabel } from "../../lib/format";
import { formatBytes } from "../../lib/utils";
import { VersionPreviewContent } from "./VersionPreviewContent";
import { FileText, Loader2, Maximize2, Upload } from "lucide-react";
import { useEffect, useState } from "react";

export function DocumentQuickPreview({
  token,
  workspace,
  document,
  onFocus,
  onError,
}: {
  token: string;
  workspace: Workspace;
  document: ArchiveDocument | null;
  onFocus: () => void;
  onError: (message: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    setExpanded(false);
  }, [document?.id]);

  if (!document) {
    return (
      <section className="flex h-full min-h-[20rem] items-center justify-center rounded-2xl bg-white text-sm text-neutral-500">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        Loading document
      </section>
    );
  }

  const version = latestVersion(document);
  const openProposal = document.openProposedChange;

  return (
    <section className="flex h-full min-h-0 flex-col rounded-2xl bg-white p-3">
      <div className="flex shrink-0 items-start justify-between gap-3 pb-3">
        <div className="min-w-0">
          <h3 className="truncate text-lg">{document.title}</h3>
          <p className="mt-0.5 text-xs text-neutral-500">
            {version ? `v${version.version} · ${formatBytes(version.sizeBytes)}` : "No versions"}
          </p>
          {openProposal ? (
            <p className="mt-1 text-xs text-flame-500/60">{proposalStatusLabel(openProposal.status)}</p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setExpanded(true)}
            aria-label="Expand preview"
            title="Expand preview"
          >
            <Maximize2 className="h-4 w-4" />
          </Button>
          <Button variant="secondary" size="sm" onClick={onFocus}>
            Document details
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden rounded-lg border border-neutral-100 bg-white">
        {version ? (
          <VersionPreviewContent token={token} workspace={workspace} document={document} version={version} onError={onError} />
        ) : (
          <EmptyState icon={<FileText className="h-5 w-5" />} title="No versions yet" text="Upload a file to create the first version." />
        )}
      </div>
      <Dialog open={expanded} onOpenChange={setExpanded}>
        <DialogContent className="h-[95vh] w-[95vw] max-w-none overflow-hidden rounded-lg border-0 bg-white p-0">
          {version ? (
            <VersionPreviewContent token={token} workspace={workspace} document={document} version={version} onError={onError} />
          ) : (
            <EmptyState icon={<FileText className="h-5 w-5" />} title="No versions yet" text="Upload a file to create the first version." />
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}
