"use client";

import { useCallback, useEffect } from "react";
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type NodeTypes,
  BackgroundVariant,
  ConnectionLineType,
} from "reactflow";
import "reactflow/dist/style.css";
import { useGraphStore } from "@/store/graph";
import { CreativeNode } from "./CreativeNode";
import { DetailPanel } from "./DetailPanel";
import type { GraphNode } from "@/lib/types";

const nodeTypes: NodeTypes = {
  creative: CreativeNode as unknown as NodeTypes["creative"],
};

const edgeStyle = {
  stroke: "#334155",
  strokeWidth: 2,
};

const edgeAnimatedStyle = {
  stroke: "#3b82f6",
  strokeWidth: 2,
};

function layoutNodes(graphNodes: GraphNode[]): Node[] {
  // Group by generation, then arrange in a tree layout
  const byGeneration: Record<number, GraphNode[]> = {};
  for (const node of graphNodes) {
    const gen = node.generation;
    if (!byGeneration[gen]) byGeneration[gen] = [];
    byGeneration[gen].push(node);
  }

  const nodeWidth = 220;
  const nodeHeight = 280;
  const gapX = 40;
  const gapY = 80;

  const rfNodes: Node[] = [];

  const generations = Object.keys(byGeneration)
    .map(Number)
    .sort((a, b) => a - b);

  for (const gen of generations) {
    const nodesInGen = byGeneration[gen];
    const totalWidth = nodesInGen.length * (nodeWidth + gapX) - gapX;
    const startX = -totalWidth / 2;

    nodesInGen.forEach((gNode, idx) => {
      rfNodes.push({
        id: gNode.id,
        type: "creative",
        position: {
          x: startX + idx * (nodeWidth + gapX),
          y: gen * (nodeHeight + gapY),
        },
        data: gNode,
      });
    });
  }

  return rfNodes;
}

export function GraphCanvas() {
  const { nodes: graphNodes, edges: graphEdges, loading, error, fetchGraph, selectNode } = useGraphStore();

  const [rfNodes, setRfNodes, onNodesChange] = useNodesState([]);
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState([]);

  useEffect(() => {
    fetchGraph();
  }, [fetchGraph]);

  useEffect(() => {
    const laid = layoutNodes(graphNodes);
    setRfNodes(laid);
  }, [graphNodes, setRfNodes]);

  useEffect(() => {
    const edges: Edge[] = graphEdges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      type: "smoothstep",
      animated: e.relationship === "variation",
      style: e.relationship === "variation" ? edgeAnimatedStyle : edgeStyle,
      label: e.variable_isolated || undefined,
      labelStyle: { fill: "#64748b", fontSize: 10 },
      labelBgStyle: { fill: "#0f172a", fillOpacity: 0.8 },
    }));
    setRfEdges(edges);
  }, [graphEdges, setRfEdges]);

  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      selectNode(node.data as GraphNode);
    },
    [selectNode]
  );

  const onPaneClick = useCallback(() => {
    selectNode(null);
  }, [selectNode]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center space-y-3">
          <div className="w-10 h-10 border-2 border-blue-500/30 border-t-blue-500 rounded-full animate-spin mx-auto" />
          <p className="text-sm text-slate-400">Carregando grafo...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center space-y-2 p-6 rounded-xl bg-red-500/10 border border-red-500/20">
          <p className="text-sm text-red-400">Erro ao carregar: {error}</p>
          <button
            onClick={fetchGraph}
            className="text-xs text-blue-400 hover:text-blue-300 underline"
          >
            Tentar novamente
          </button>
        </div>
      </div>
    );
  }

  if (graphNodes.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center space-y-4 max-w-md">
          <div className="w-16 h-16 rounded-2xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center mx-auto">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" strokeWidth="1.5">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
            </svg>
          </div>
          <div>
            <h3 className="text-lg font-semibold text-white">Nenhum criativo ainda</h3>
            <p className="text-sm text-slate-400 mt-1">
              Use a API <code className="text-blue-400 text-xs bg-blue-500/10 px-1.5 py-0.5 rounded">POST /api/generate</code> para criar o primeiro criativo.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="relative w-full h-full">
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={onNodeClick}
        onPaneClick={onPaneClick}
        nodeTypes={nodeTypes}
        connectionLineType={ConnectionLineType.SmoothStep}
        fitView
        fitViewOptions={{ padding: 0.3 }}
        minZoom={0.1}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={24}
          size={1}
          color="#1e293b"
        />
        <Controls
          className="!rounded-xl !border-slate-700/50 !bg-slate-800/80 !backdrop-blur-sm [&>button]:!bg-transparent [&>button]:!text-slate-400 [&>button]:!border-slate-700/50 [&>button:hover]:!bg-slate-700/50"
        />
        <MiniMap
          nodeColor={(node) => {
            const status = node.data?.status;
            if (status === "winner") return "#10b981";
            if (status === "testing") return "#3b82f6";
            if (status === "killed") return "#ef4444";
            return "#475569";
          }}
          maskColor="rgba(15,23,42,0.8)"
          className="!rounded-xl !border-slate-700/50 !bg-slate-800/80"
        />
      </ReactFlow>
      <DetailPanel />
    </div>
  );
}
