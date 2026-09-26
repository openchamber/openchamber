/**
 * OpenCode's experimental usage route (`session.stats`,
 * `GET /api/experimental/session/stats`), translated into the shape the usage
 * page reads.
 *
 * Route semantics (OpenCode 2.0.15, `packages/core/src/session/stats.ts`):
 * - `from`/`to` are epoch milliseconds, `from` inclusive, `to` exclusive.
 *   `to` defaults to now; without `from` the range starts at the oldest
 *   message. `from >= to` is a 400.
 * - `project` is an OpenCode project id, not a directory; without it every
 *   project on the server is counted.
 * - `timezone` is an IANA zone used to bucket `activity` into `YYYY-MM-DD`
 *   days (defaults to UTC, so we always send the viewer's zone).
 * - `tools` selects the tool-call breakdown. We ask for `"detail"`: the same
 *   message scan `"summary"` runs, plus per-tool counts sorted by calls and a
 *   median duration. `"none"` would make OpenCode skip that work.
 *
 * A failed read throws; it is never a zeroed report.
 */

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

/** Tool-call counts for the whole report. */
interface UsageToolTotals {
  calls: number
  succeeded: number
  failed: number
  /** Neither completed nor errored: interrupted, pending or unknown state. */
  unfinished: number
}

/** One tool's counts; `detail` reports carry these per tool. */
interface UsageToolUsage {
  name: string
  calls: number
  succeeded: number
  failed: number
  unfinished: number
  /** Median duration of completed calls in ms; absent when none completed. */
  durationP50: number | null
}

/** The tool-call breakdown the request mode produced; `none` carries nothing. */
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
  /** Longest run of consecutive active days inside the range. */
  streak: number
  /** Active days only, ascending; days with no model steps are absent. */
  activity: Array<{ date: string; steps: number }>
  /** Sorted by total tokens, largest first. */
  models: UsageModel[]
}

interface UsageStatsQuery {
  from?: number
  to?: number
  /** OpenCode project id; omit for every project. */
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

export async function fetchUsageStats(query: UsageStatsQuery, signal?: AbortSignal): Promise<UsageStats> {
  try {
    const info = await opencodeClient.getSdkClient().session.stats(
      { from: query.from, to: query.to, project: query.projectID, timezone: query.timezone, tools: "detail" },
      { signal },
    )
    return toUsageStats(info)
  } catch (error) {
    throw normalizeOpencodeError("session.stats", error)
  }
}

/** The OpenCode project id a directory belongs to, for the `project` filter. */
export async function resolveUsageProjectID(directory: string): Promise<string> {
  const project = await opencodeClient.getCurrentProject(directory)
  return project.id
}
