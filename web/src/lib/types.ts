// Shared across the toast host in App and the panels that raise notices.
export type Notice = { title: string; description?: string };

export type WorkspaceNavState = {
  workspaceId: string | null;
  documentId: string | null;
  focused: boolean;
  activityLogOpen: boolean;
};

export type DocumentViewMode = "versions" | "editing" | "review";
