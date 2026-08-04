import { create } from "zustand";
import type { User, Workspace } from "../api/types";

type AppState = {
  accessToken: string | null;
  user: User | null;
  workspaces: Workspace[];
  selectedWorkspaceId: string | null;
  setSession: (accessToken: string, user?: User | null) => void;
  clearSession: () => void;
  setWorkspaces: (workspaces: Workspace[]) => void;
  selectWorkspace: (workspaceId: string | null) => void;
};

const storedUser = sessionStorage.getItem("archive-engine-user");

export const useAppStore = create<AppState>((set, get) => ({
  accessToken: null,
  user: storedUser ? JSON.parse(storedUser) as User : null,
  workspaces: [],
  selectedWorkspaceId: null,

  setSession: (accessToken, user) => {
    if (user) {
      sessionStorage.setItem("archive-engine-user", JSON.stringify(user));
    }

    set({
      accessToken,
      user: user ?? get().user,
    });
  },

  clearSession: () => {
    sessionStorage.removeItem("archive-engine-user");
    set({
      accessToken: null,
      user: null,
      workspaces: [],
      selectedWorkspaceId: null,
    });
  },

  setWorkspaces: (workspaces) => {
    const selectedWorkspaceId = get().selectedWorkspaceId;
    set({
      workspaces,
      selectedWorkspaceId: workspaces.some((workspace) => workspace.id === selectedWorkspaceId)
        ? selectedWorkspaceId
        : workspaces[0]?.id ?? null,
    });
  },

  selectWorkspace: (workspaceId) => set({ selectedWorkspaceId: workspaceId }),
}));
