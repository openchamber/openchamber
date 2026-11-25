// Model catalog: a cache file in the data dir, fallbacks, and discovery through a live agy session
// (SR 3.3). Discovery never spawns the process on its own; the proxy runs it on a ready process.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AcpClient, AcpConfigOption } from "./acp-client.ts";
import { PROVIDER_ID } from "./constants.ts";

export interface DiscoveredModel {
  id: string;
  name: string;
  variants: string[];
  contextLimit: number;
  outputLimit: number;
}

export interface ModelCache {
  updatedAt: number;
  models: DiscoveredModel[];
}

const CACHE_FILENAME = "models.json";

export const FALLBACK_MODELS: readonly DiscoveredModel[] = [
  { id: "gemini-4-neon", name: "Gemini 4 Neon", variants: ["low", "medium", "high", "xhigh"], contextLimit: 1_048_576, outputLimit: 65_536 },
  { id: "gemini-4-carbon", name: "Gemini 4 Carbon", variants: ["low", "medium", "high"], contextLimit: 1_048_576, outputLimit: 65_536 },
  { id: "gemini-4-argon", name: "Gemini 4 Argon", variants: ["low", "medium", "high"], contextLimit: 1_048_576, outputLimit: 65_536 },
  { id: "gemini-4-hydrogen", name: "Gemini 4 Hydrogen", variants: ["low", "medium", "high", "xhigh"], contextLimit: 1_048_576, outputLimit: 65_536 },
  { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", variants: ["low", "medium", "high"], contextLimit: 1_048_576, outputLimit: 65_536 },
  { id: "claude-opus-5-5", name: "Claude Opus 5.5", variants: ["low", "medium", "high"], contextLimit: 200_000, outputLimit: 32_000 },
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", variants: ["low", "medium", "high"], contextLimit: 200_000, outputLimit: 32_000 },
  { id: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)", variants: [], contextLimit: 131_072, outputLimit: 32_000 },
];

export function inferLimits(modelId: string): { contextLimit: number; outputLimit: number } {
  const lower = modelId.toLowerCase();
  if (lower.startsWith("claude-")) return { contextLimit: 200_000, outputLimit: 32_000 };
  if (lower.startsWith("gpt-")) return { contextLimit: 131_072, outputLimit: 32_000 };
  return { contextLimit: 1_048_576, outputLimit: 65_536 };
}

function isModel(value: unknown): value is DiscoveredModel {
  if (typeof value !== "object" || value === null) return false;
  const id: unknown = Reflect.get(value, "id");
  const name: unknown = Reflect.get(value, "name");
  const variants: unknown = Reflect.get(value, "variants");
  const context: unknown = Reflect.get(value, "contextLimit");
  const output: unknown = Reflect.get(value, "outputLimit");
  return (
    typeof id === "string" &&
    id.length > 0 &&
    typeof name === "string" &&
    Array.isArray(variants) &&
    variants.every((v) => typeof v === "string") &&
    typeof context === "number" &&
    typeof output === "number"
  );
}

/** The cached catalog, or the fallbacks with `updatedAt: 0` when there is none or it does not parse. */
export function loadCachedModels(dataDir: string): ModelCache {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path.join(dataDir, CACHE_FILENAME), "utf8"));
    if (typeof parsed !== "object" || parsed === null) throw new Error("bad cache");
    const models: unknown = Reflect.get(parsed, "models");
    const updatedAt: unknown = Reflect.get(parsed, "updatedAt");
    const valid = Array.isArray(models) ? models.filter(isModel) : [];
    if (valid.length === 0) throw new Error("empty cache");
    return { updatedAt: typeof updatedAt === "number" ? updatedAt : 0, models: valid };
  } catch {
    return { updatedAt: 0, models: [...FALLBACK_MODELS] };
  }
}

/** Atomic write (temp file, then rename). */
export function saveCachedModels(dataDir: string, models: readonly DiscoveredModel[], now: number = Date.now()): void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = path.join(dataDir, CACHE_FILENAME);
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
  const payload: ModelCache = { updatedAt: now, models: [...models] };
  writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

function findOption(options: readonly AcpConfigOption[], id: string): AcpConfigOption | undefined {
  return options.find((o) => o.category === id || o.id === id);
}

/**
 * Lists models and their thought levels through one throwaway session. `models` is null when agy lists
 * none: that is no data, and the caller keeps the catalog it has. The caller closes the session
 * (`sessionId` in the result) and records it as ephemeral.
 */
export async function discoverAgyModels(client: AcpClient, cwd: string): Promise<{ models: DiscoveredModel[] | null; sessionId: string }> {
  const session = await client.newSession({ cwd, mcpServers: [], append: null });
  const modelOption = findOption(session.configOptions, "model");
  if (!modelOption || modelOption.values.length === 0) return { models: null, sessionId: session.sessionId };
  const models: DiscoveredModel[] = [];
  for (const item of modelOption.values) {
    let variants: string[] = [];
    try {
      const updated = await client.setConfigOption(session.sessionId, modelOption.id, item.value);
      variants = findOption(updated, "thought_level")?.values.map((v) => v.value) ?? [];
    } catch {
      variants = [];
    }
    models.push({ id: item.value, name: item.name ?? item.value, variants, ...inferLimits(item.value) });
  }
  return { models, sessionId: session.sessionId };
}

export function toOpenCodeModelInfo(model: DiscoveredModel) {
  return {
    id: model.id,
    modelID: model.id,
    providerID: PROVIDER_ID,
    name: model.name,
    capabilities: { tools: true, input: ["text", "image"] as const, output: ["text"] as const },
    variants: model.variants.map((id) => ({ id })),
    time: { released: 0 },
    cost: [],
    status: "active" as const,
    enabled: true,
    limit: { context: model.contextLimit, output: model.outputLimit },
  };
}
