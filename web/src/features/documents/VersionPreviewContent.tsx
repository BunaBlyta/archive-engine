import { api } from "../../api/client";
import type { ArchiveDocument, DocumentVersion, Workspace } from "../../api/types";
import { EmptyState } from "../../components/EmptyState";
import { errorMessage, previewKind } from "../../lib/format";
import { cn } from "../../lib/utils";
import { FileText, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

export function VersionPreviewContent({
  token,
  workspace,
  document,
  version,
  onError,
  className,
}: {
  token: string;
  workspace: Workspace;
  document: ArchiveDocument;
  version: DocumentVersion;
  onError: (message: string) => void;
  className?: string;
}) {
  const [busy, setBusy] = useState(true);
  const [text, setText] = useState<string | null>(null);
  const kind = previewKind(version.mimeType);

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    setText(null);

    async function loadPreview() {
      try {
        const file = await api.previewVersion(token, workspace.id, document.id, version.version);
        if (cancelled) return;
        if (kind === "text" || kind === "html") {
          setText(await file.blob.text());
        }
      } catch (error) {
        if (!cancelled) onError(errorMessage(error));
      } finally {
        if (!cancelled) setBusy(false);
      }
    }

    void loadPreview();
    return () => {
      cancelled = true;
    };
  }, [token, workspace.id, document.id, version.id, version.version, kind]);

  return (
    <div className={cn("h-full w-full", className)}>
      {busy ? (
        <div className="grid h-full place-items-center text-sm text-neutral-500">
          <span className="flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" />Loading preview</span>
        </div>
      ) : kind === "html" && text !== null ? (
        <iframe
          title={`${document.title} version ${version.version}`}
          srcDoc={text}
          sandbox=""
          className="h-full w-full border-0 bg-neutral-100"
        />
      ) : kind === "text" && text !== null ? (
        <div className="h-full overflow-auto bg-white">
          <pre className="mx-auto max-w-4xl whitespace-pre-wrap px-6 py-8 font-mono text-sm leading-6 text-neutral-800">
            {text}
          </pre>
        </div>
      ) : (
        <EmptyState
          icon={<FileText className="h-5 w-5" />}
          title="Preview unavailable"
          text="This file type cannot be displayed in the browser."
        />
      )}
    </div>
  );
}
