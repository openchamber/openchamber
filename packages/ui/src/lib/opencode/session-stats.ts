
import type { SessionStatsInfo } from "@opencode/client"
import { normalizeOpencodeError, opencodeClient } from "./client"

export interface UsageTokens {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  total: number
}

export interface UsageModel {
  providerID: string
  modelID: string
  variant: string | null
  steps: number
  tokens: UsageTokens
  cost: number
}

interface UsageToolTotals {
  calls: number
  succeeded: number
  failed: number
  unfinished: number
}

interface UsageToolUsage {
  name: string
  calls: number
  succeeded: number
  failed: number
  unfinished: number
  durationP50: number | null
}

export type UsageTools =
  | { mode: "none" }
  | { mode: "summary"; totals: UsageToolTotals }
  | { mode: "detail"; totals: UsageToolTotals; usage: UsageToolUsage[] }

export interface UsageStats {
  range: { from: number; to: number }
  sessions: number
  subagents: number
  prompts: number
  steps: number
  tokens: UsageTokens
  cost: number
  tools: UsageTools
  activeDays: number
  streak: number
  activity: Array<{ date: string; steps: number }>
  models: UsageModel[]
}

interface UsageStatsQuery {
  from?: number
  to?: number
  projectID?: string
  timezone: string
}

const toTokens = (tokens: SessionStatsInfo["tokens"]): UsageTokens => ({
  input: tokens.input,
  output: tokens.output,
  reasoning: tokens.reasoning,
  cacheRead: tokens.cache.read,
  cacheWrite: tokens.cache.write,
  total: tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write,
})

const toTools = (tools: SessionStatsInfo["tools"]): UsageTools => {
  if (tools.mode === "none") return { mode: "none" }
  const totals = {
    calls: tools.totals.calls,
    succeeded: tools.totals.succeeded,
    failed: tools.totals.failed,
    unfinished: tools.totals.unfinished,
  }
  if (tools.mode === "summary") return { mode: "summary", totals }
  return {
    mode: "detail",
    totals,
    usage: tools.usage.map((tool) => ({
      name: tool.name,
      calls: tool.calls,
      succeeded: tool.succeeded,
      failed: tool.failed,
      unfinished: tool.unfinished,
      durationP50: tool.durationP50 ?? null,
    })),
  }
}

const toUsageStats = (info: SessionStatsInfo): UsageStats => ({
  range: { from: info.range.from, to: info.range.to },
  sessions: info.sessions,
  subagents: info.subagents,
  prompts: info.prompts,
  steps: info.steps,
  tokens: toTokens(info.tokens),
  cost: info.cost,
  tools: toTools(info.tools),
  activeDays: info.activeDays,
  streak: info.streak,
  activity: info.activity.map((day) => ({ date: day.date, steps: day.steps })),
  models: info.models.map((entry) => ({
    providerID: entry.model.providerID,
    modelID: entry.model.id,
    variant: entry.model.variant ?? null,
    steps: entry.steps,
    tokens: toTokens(entry.tokens),
    cost: entry.cost,
  })),
})

const requestStats = async (query: UsageStatsQuery, tools: "none" | "detail", signal?: AbortSignal): Promise<SessionStatsInfo> => {
  try {
    return await opencodeClient.getSdkClient().experimental.session.stats(
      { from: query.from, to: query.to, project: query.projectID, timezone: query.timezone, tools },
      { signal },
    )
  } catch (error) {
    throw normalizeOpencodeError("session.stats", error)
  }
}

export async function fetchUsageStats(query: UsageStatsQuery, signal?: AbortSignal): Promise<UsageStats> {
  return toUsageStats(await requestStats(query, "none", signal))
}

export async function fetchUsageTools(query: UsageStatsQuery, signal?: AbortSignal): Promise<UsageTools> {
  return toTools((await requestStats(query, "detail", signal)).tools)
}

export async function resolveUsageProjectID(directory: string): Promise<string> {
  const project = await opencodeClient.getCurrentProject(directory)
  return project.id
}
