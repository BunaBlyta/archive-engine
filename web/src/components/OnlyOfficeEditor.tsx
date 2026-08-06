import { useEffect, useId, useRef } from "react";
import type { OnlyOfficeEditorConfig } from "../api/types";

type OnlyOfficeInstance = { destroyEditor?: () => void };
type OnlyOfficeApi = {
  DocEditor: new (placeholder: string, config: Record<string, unknown>) => OnlyOfficeInstance;
};

declare global {
  interface Window {
    DocsAPI?: OnlyOfficeApi;
  }
}

let apiScriptPromise: Promise<void> | null = null;

function loadApiScript(documentServerUrl: string) {
  if (window.DocsAPI) return Promise.resolve();
  if (apiScriptPromise) return apiScriptPromise;

  apiScriptPromise = new Promise<void>((resolve, reject) => {
    const script = window.document.createElement("script");
    script.src = `${documentServerUrl.replace(/\/$/, "")}/web-apps/apps/api/documents/api.js`;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("ONLYOFFICE editor could not be loaded"));
    window.document.head.appendChild(script);
  });

  return apiScriptPromise;
}

export function OnlyOfficeEditor({ config, className = "" }: { config: OnlyOfficeEditorConfig; className?: string }) {
  const placeholderId = `onlyoffice-editor-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const editorRef = useRef<OnlyOfficeInstance | null>(null);

  useEffect(() => {
    let cancelled = false;

    void loadApiScript(config.documentServerUrl)
      .then(() => {
        if (cancelled || !window.DocsAPI) return;
        const { documentServerUrl: _documentServerUrl, ...editorConfig } = config;
        editorRef.current = new window.DocsAPI.DocEditor(
          placeholderId,
          editorConfig as unknown as Record<string, unknown>
        );
      })
      .catch(() => {
        // The parent panel remains visible; the app-level error state handles API failures.
      });

    return () => {
      cancelled = true;
      editorRef.current?.destroyEditor?.();
      editorRef.current = null;
    };
  }, [config, placeholderId]);

  return <div id={placeholderId} className={`h-full min-h-[28rem] w-full ${className}`} />;
}
