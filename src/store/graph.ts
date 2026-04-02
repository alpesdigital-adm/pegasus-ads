import { create } from "zustand";
import type { GraphData, GraphNode, GraphEdge } from "@/lib/types";

interface GraphStore {
  nodes: GraphNode[];
  edges: GraphEdge[];
  selectedNode: GraphNode | null;
  loading: boolean;
  error: string | null;
  fetchGraph: () => Promise<void>;
  selectNode: (node: GraphNode | null) => void;
}

export const useGraphStore = create<GraphStore>((set) => ({
  nodes: [],
  edges: [],
  selectedNode: null,
  loading: false,
  error: null,

  fetchGraph: async () => {
    set({ loading: true, error: null });
    try {
      const res = await fetch("/api/graph");
      if (!res.ok) throw new Error("Failed to fetch graph");
      const data: GraphData = await res.json();
      set({ nodes: data.nodes, edges: data.edges, loading: false });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : "Unknown error",
        loading: false,
      });
    }
  },

  selectNode: (node) => set({ selectedNode: node }),
}));
