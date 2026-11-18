export interface ControlInput {
  projectId?: unknown;
  directory?: unknown;
  kind?: unknown;
  id?: unknown;
  body?: unknown;
  completed?: unknown;
  planId?: unknown;
  dependsOn?: unknown;
  sessionId?: unknown;
  expected?: unknown;
  ready?: unknown;
  source?: unknown;
  args?: unknown;
  url?: unknown;
  waitId?: unknown;
  prompt?: unknown;
  count?: unknown;
  aspect?: unknown;
  resolution?: unknown;
  images?: unknown;
  path?: unknown;
  label?: unknown;
  maxBytes?: unknown;
}

export interface ActionContext {
  directory?: string | null | undefined;
  signal?: AbortSignal | undefined;
}
