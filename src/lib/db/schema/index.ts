// Barrel re-export de todos os schemas Drizzle.
// Ordem por dependência: workspaces primeiro (todos referenciam), depois
// demais domínios.

export * from "./workspaces";
export * from "./auth-legacy";
export * from "./meta-accounts";
export * from "./creatives";
export * from "./metrics";
export * from "./campaigns";
export * from "./testing";
export * from "./publishing";
export * from "./intelligence";
export * from "./crm";
export * from "./pipelines";
export * from "./prompts";
export * from "./ad-accounts";
export * from "./insights";
export * from "./leads";
export * from "./projects";
export * from "./misc";
export * from "./creative-intelligence";
export * from "./classified-insights";
