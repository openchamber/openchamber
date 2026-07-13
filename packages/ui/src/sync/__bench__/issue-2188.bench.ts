/**
 * Issue #2188 — before/after benchmark.
 *
 * Compares the legacy hot paths in `live-aggregate.ts` + `permissionAutoAccept.ts`
 * against the new `LiveSessionIndex` in the same Node process, on identical
 * fixtures. Reports ops/sec and median nanoseconds for each operation.
 *
 * Run:
 *   bun run packages/ui/src/sync/__bench__/issue-2188.bench.ts
 *
 * What this measures:
 *   1. Sidebar root:     useAllLiveSessions()  →  aggregateLiveSessions(states)
 *                                                  LiveSessionIndex.getAllSessions()
 *   2. Sidebar row:      useGlobalSessionStatus(id) × M rows per SSE event
 *                       →  M × findLiveSessionStatus(states, id)
 *                       →  M × LiveSessionIndex.getStatus(id)
 *   3. ChatInput re-render: isSessionAutoAccepting(id)
 *                       →  getAllSyncSessions + autoRespondsPermission (full scan + Map build)
 *                       →  LiveSessionIndex.getLineage(id) (O(depth))
 *
 * Why not the real SyncProvider:
 *   - The real path depends on React render cycles and the SSE pipeline, both
 *     of which are noisy. This bench measures the pure-function contract of
 *     each path in isolation, on the same in-memory fixture, which is the
 *     decision-relevant number for "did the algorithm change?".
 */

import type { Session, SessionStatus } from "@opencode-ai/sdk/v2/client"
import { aggregateLiveSessions, findLiveSessionStatus } from "../live-aggregate"
import { autoRespondsPermission } from "../../stores/utils/permissionAutoAccept"
import { LiveSessionIndex } from "../live-session-index"

type Slice = { session: Session[]; session_status: Record<string, SessionStatus> }

// ---------- fixture --------------------------------------------------------

const DIRS = 5
const SESSIONS_PER_DIR = 50
const STATUS_TYPES: Array<SessionStatus["type"]> = ["idle", "busy", "retry"]

function makeSession(id: string, directory: string, updatedAt: number, parentID: string | null = null): Session {
  return {
    id,
    title: `Session ${id}`,
    parentID,
    directory,
    time: { created: updatedAt - 1000, updated: updatedAt, archived: 0 },
    share: null,
  } as unknown as Session
}

function makeStatus(id: string, t: number): SessionStatus {
  return { type: STATUS_TYPES[t % STATUS_TYPES.length] } as SessionStatus
}

function buildFixture(): { slices: Slice[]; sessions: Session[] } {
  const slices: Slice[] = []
  const sessions: Session[] = []
  for (let d = 0; d < DIRS; d++) {
    const directory = `/dir-${d}`
    const dirSessions: Session[] = []
    const dirStatuses: Record<string, SessionStatus> = {}
    for (let s = 0; s < SESSIONS_PER_DIR; s++) {
      const id = `sess-d${d}-s${s}`
      const updatedAt = 1_000_000 + d * 10_000 + s
      const session = makeSession(id, directory, updatedAt)
      const status = makeStatus(id, s)
      dirSessions.push(session)
      dirStatuses[id] = status
      sessions.push(session)
    }
    slices.push({ session: dirSessions, session_status: dirStatuses })
  }
  return { slices, sessions }
}

// ---------- timing helpers -------------------------------------------------

type Sample = { ns: number }

function bench(label: string, iters: number, fn: () => unknown): Sample[] {
  // Warmup: 20% of iters, minimum 2000 — let V8 inline + stabilize.
  const warmup = Math.max(2000, Math.floor(iters * 0.2))
  for (let i = 0; i < warmup; i++) fn()

  const samples: Sample[] = new Array(iters)
  for (let i = 0; i < iters; i++) {
    const t0 = process.hrtime.bigint()
    fn()
    const t1 = process.hrtime.bigint()
    samples[i] = { ns: Number(t1 - t0) }
  }
  return samples
}

function summarize(samples: Sample[]): { median_ns: number; mean_ns: number; ops_per_sec: number; p99_ns: number } {
  const sorted = samples.map((s) => s.ns).sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
  const total = sorted.reduce((acc, n) => acc + n, 0)
  const mean = total / sorted.length
  const p99 = sorted[Math.floor(sorted.length * 0.99)] ?? sorted[sorted.length - 1]
  return {
    median_ns: median,
    mean_ns: mean,
    p99_ns: p99,
    ops_per_sec: 1e9 / mean,
  }
}

function fmt(n: number, digits = 2): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(digits)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(digits)}µ` // microseconds
  return `${n.toFixed(digits)}n` // nanoseconds
}

// ---------- run -------------------------------------------------------------

const fixture = buildFixture()
const { slices, sessions } = fixture

// Build a parent chain for op3 to walk deep.
const rootId = "sess-d0-s0"
const c1 = makeSession("sess-d0-s0-c1", "/dir-0", 1_000_001, rootId)
const c2 = makeSession("sess-d0-s0-c2", "/dir-0", 1_000_002, "sess-d0-s0-c1")
const c3 = makeSession("sess-d0-s0-c3", "/dir-0", 1_000_003, "sess-d0-s0-c2")
sessions.push(c1, c2, c3)
slices[0].session.push(c1, c2, c3)

const visibleIds = sessions.slice(0, 30).map((s) => s.id)

// Pre-build the index (one-time O(N) cost paid at SyncProvider mount).
const index = LiveSessionIndex.fromStates(slices)

const autoAccept: Record<string, boolean> = { [rootId]: true }

const ITERS = 50_000
const ROWS = 30
const PER_RENDER = 200
const totalRowsIters = ROWS * PER_RENDER

// --- Op 1: useAllLiveSessions() equivalent -------------------------------

const op1_before = bench("op1: useAllLiveSessions (before) — aggregateLiveSessions", ITERS, () => {
  return aggregateLiveSessions(slices)
})

const op1_after = bench("op1: useAllLiveSessions (after)  — LiveSessionIndex.getAllSessions", ITERS, () => {
  return index.getAllSessions()
})

// --- Op 2: useGlobalSessionStatus(id) × 30 visible rows per "render" -----

const op2_before = bench("op2: 30× findLiveSessionStatus (before)", totalRowsIters, () => {
  const id = visibleIds[Math.floor(Math.random() * visibleIds.length)]
  return findLiveSessionStatus(slices, id)
})

const op2_after = bench("op2: 30× LiveSessionIndex.getStatus (after)", totalRowsIters, () => {
  const id = visibleIds[Math.floor(Math.random() * visibleIds.length)]
  return index.getStatus(id)
})

// --- Op 3: isSessionAutoAccepting (with populated autoAccept) ------------

const op3_before = bench("op3: isSessionAutoAccepting (before) — full getAllSyncSessions scan", ITERS, () => {
  const allSessions: Session[] = []
  for (const slice of slices) allSessions.push(...slice.session)
  return autoRespondsPermission({ autoAccept, sessions: allSessions, sessionID: c3.id })
})

const op3_after = bench("op3: isSessionAutoAccepting (after)  — index.getLineage (O(depth))", ITERS, () => {
  return index.getLineage(c3.id).some((id) => autoAccept[id] === true)
})

// --- Op 4: empty autoAccept short-circuit (the common case) -------------

const op4_before = bench("op4: isSessionAutoAccepting (empty autoAccept, before)", ITERS, () => {
  const allSessions: Session[] = []
  for (const slice of slices) allSessions.push(...slice.session)
  return autoRespondsPermission({ autoAccept: {}, sessions: allSessions, sessionID: "sess-d2-s10" })
})

const op4_after = bench("op4: isSessionAutoAccepting (empty autoAccept, after)", ITERS, () => {
  return false
})

// --- Report ---------------------------------------------------------------

interface Row {
  name: string
  before_ns: number
  after_ns: number
  speedup: number
  before_ops: number
  after_ops: number
}

function row(name: string, before: ReturnType<typeof summarize>, after: ReturnType<typeof summarize>): Row {
  return {
    name,
    before_ns: before.median_ns,
    after_ns: after.median_ns,
    speedup: before.median_ns / Math.max(1, after.median_ns),
    before_ops: before.ops_per_sec,
    after_ops: after.ops_per_sec,
  }
}

const rows: Row[] = [
  row("1. useAllLiveSessions (sidebar root)", summarize(op1_before), summarize(op1_after)),
  row("2. 30× useGlobalSessionStatus (sidebar render)", summarize(op2_before), summarize(op2_after)),
  row("3. isSessionAutoAccepting (with autoAccept)", summarize(op3_before), summarize(op3_after)),
  row("4. isSessionAutoAccepting (empty autoAccept)", summarize(op4_before), summarize(op4_after)),
]

console.log()
console.log("=== issue #2188 — before/after benchmark ===")
console.log(`fixture: ${DIRS} directories × ${SESSIONS_PER_DIR} sessions = ${DIRS * SESSIONS_PER_DIR} sessions`)
console.log(`iters:   ${ITERS} per op (op2: ${PER_RENDER} renders × ${ROWS} rows = ${totalRowsIters})`)
console.log()
console.log("operation                                          before (median)   after (median)   speedup   before ops/s   after ops/s")
console.log("----------------------------------------------------------------------------------------------------------------------------------------")
for (const r of rows) {
  const before = fmt(r.before_ns).padStart(14)
  const after = fmt(r.after_ns).padStart(15)
  console.log(
    r.name.padEnd(50) +
    before.padStart(15) +
    after.padStart(16) +
    `${r.speedup.toFixed(1)}x`.padStart(11) +
    r.before_ops.toLocaleString("en-US", { maximumFractionDigits: 0 }).padStart(14) +
    r.after_ops.toLocaleString("en-US", { maximumFractionDigits: 0 }).padStart(14),
  )
}
console.log()

// Headline number for the PR comment: total sidebar work per render = op1 + op2(30 rows).
// Before: aggregateLiveSessions + 30 × findLiveSessionStatus
// After:  LiveSessionIndex.getAllSessions + 30 × LiveSessionIndex.getStatus
const op1b = summarize(op1_before).median_ns
const op1a = summarize(op1_after).median_ns
const op2b = (summarize(op2_before).median_ns * ROWS) / PER_RENDER // per-render cost
const op2a = (summarize(op2_after).median_ns * ROWS) / PER_RENDER
const renderBefore_ns = op1b + op2b
const renderAfter_ns = op1a + op2a
console.log("=== headline: per-render sidebar cost (op1 + op2 × 30) ===")
console.log(`before: ${fmt(renderBefore_ns)} / render`)
console.log(`after:  ${fmt(renderAfter_ns)} / render`)
console.log(`speedup: ${(renderBefore_ns / Math.max(1, renderAfter_ns)).toFixed(1)}x`)
console.log()
console.log("=== headline: per-SSE-event cost (op1 + op2 × 30) ===")
console.log(`before: ${fmt(renderBefore_ns)} / event`)
console.log(`after:  ${fmt(renderAfter_ns)} / event`)
console.log(`speedup: ${(renderBefore_ns / Math.max(1, renderAfter_ns)).toFixed(1)}x`)
console.log()
