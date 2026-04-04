import { create } from "zustand";

interface User {
  id: string;
  email: string;
  name: string;
  avatar_url?: string;
}

interface Workspace {
  id: string;
  name: string;
  slug: string;
  plan: string;
  role: string;
}

interface AuthStore {
  user: User | null;
  workspace: Workspace | null;
  workspaces: Workspace[];
  loading: boolean;
  initialized: boolean;

  fetchMe: () => Promise<boolean>;
  login: (email: string, password: string) => Promise<string | null>;
  register: (data: { name: string; email: string; password: string; workspace_name?: string }) => Promise<string | null>;
  logout: () => Promise<void>;
  switchWorkspace: (workspaceId: string) => Promise<boolean>;
}

export const useAuthStore = create<AuthStore>((set, get) => ({
  user: null,
  workspace: null,
  workspaces: [],
  loading: false,
  initialized: false,

  fetchMe: async () => {
    set({ loading: true });
    try {
      const res = await fetch("/api/auth/me");
      if (!res.ok) {
        set({ user: null, workspace: null, workspaces: [], loading: false, initialized: true });
        return false;
      }
      const data = await res.json();
      const currentWs = data.workspaces.find((w: Workspace) => w.id === data.current_workspace_id) || data.workspaces[0];
      set({
        user: data.user,
        workspace: currentWs,
        workspaces: data.workspaces,
        loading: false,
        initialized: true,
      });
      return true;
    } catch {
      set({ user: null, workspace: null, workspaces: [], loading: false, initialized: true });
      return false;
    }
  },

  login: async (email, password) => {
    set({ loading: true });
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        set({ loading: false });
        return data.message || data.error || "Login failed";
      }
      // Fetch full user data after login
      await get().fetchMe();
      return null;
    } catch {
      set({ loading: false });
      return "Network error";
    }
  },

  register: async (data) => {
    set({ loading: true });
    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      const result = await res.json();
      if (!res.ok) {
        set({ loading: false });
        return result.message || result.error || "Registration failed";
      }
      await get().fetchMe();
      return null;
    } catch {
      set({ loading: false });
      return "Network error";
    }
  },

  logout: async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    set({ user: null, workspace: null, workspaces: [], initialized: true });
  },

  switchWorkspace: async (workspaceId) => {
    try {
      const res = await fetch("/api/workspaces/switch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace_id: workspaceId }),
      });
      if (!res.ok) return false;
      const ws = get().workspaces.find((w) => w.id === workspaceId);
      if (ws) set({ workspace: ws });
      return true;
    } catch {
      return false;
    }
  },
}));
