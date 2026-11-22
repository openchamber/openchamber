/**
 * "Continue with another model": stop a session's turn and hand the session to
 * the model the user picked, from wherever the previous model stopped.
 *
 * Two modes (`ContinueWorkMode`):
 * - `stop` stops the turn, then every shell command and subagent the session
 *   started, and continues.
 * - `keep` moves the shell commands and subagents the turn waits on to the
 *   background, stops the turn, and continues. That work, and whatever already
 *   ran in the background, keeps going; OpenCode hands each result to the
 *   session when it finishes, and by then the session runs on the new model.
 *
 * Both modes end a pending question or permission: the interrupt does that.
 * What OpenCode does at each step, and why the steps run in this order, is in
 * `./DOCUMENTATION.md`, "Continuing with another model".
 */

import type { ModelRefLike } from "@/lib/opencode/modelRef"
import { findRecordedTurnError, isStoppedTurnError } from "@/lib/messages/assistantError"
import { modelHandoffNote, type ContinueWorkMode, type HandoffNote, type HandoffStop, type HandoffWork } from "@/lib/opencode/model-handoff"
import type { ShellToStop } from "@/lib/opencode/background-shell"
import { getLastConversationMessage, type Message, type Part, type StructuredError, type ToolPart } from "@/lib/opencode/model"
import { executeHasBackgroundableWork, isExecuteTool, isShellTool, isSubagentTool, shellCommand, subagentDescription } from "@/lib/opencode/tools"

/** The model, effort and agent to continue on. */
export type ContinueSelection = {
  providerID: string
  modelID: string
  /** `null` is an explicit Default effort; `undefined` is a model without efforts. */
  variant: string | null | undefined
  agent?: string
}

/** The session to continue, with the directory its requests go to. */
export type ContinueTarget = { sessionId: string; directory: string }

/** A shell command running for the session or one of its subagents. */
export type RunningShell = {
  shellID: string
  command: string
  /** The session that started it: the target or one of its subagents. */
  sessionID: string
  /** Where the shell service runs it, the directory its removal goes to. */
  shellDirectory: string
  /** Went to the background; false while a turn waits for it. */
  background: boolean
}

/** A subagent session still running below the target. */
export type RunningSubagent = {
  sessionID: string
  parentID: string
  directory: string
  description?: string
  /** 1 for a child of the target, 2 for its child, and so on. */
  depth: number
}

/** Calls of the current step the turn waits on, which `session.background` can move. */
export type BlockingCalls = { messageID: string; callIDs: string[] }

/** The shell commands and subagents running for the session. */
export type RunningWork = { shells: RunningShell[]; subagents: RunningSubagent[] }

/** What the session is doing at the moment the user continues. */
export type ContinueSnapshot = RunningWork & {
  stop: HandoffStop
  /** The model the previous turn ran on, when known. */
  from?: ModelRefLike
  blocking: BlockingCalls | null
}

// ---------------------------------------------------------------------------
// Reading the session
// ---------------------------------------------------------------------------

const MAX_TOOLS_IN_NOTE = 4

/** A running tool call as the handoff note names it. */
const describeRunningTool = (part: ToolPart): string => {
  if (isShellTool(part.tool)) {
    const command = shellCommand(part.state.input)
    return command ? `the command \`${command}\`` : "a shell command"
  }
  if (isSubagentTool(part.tool)) {
    const description = subagentDescription(part.state.input)
    return description ? `the subagent "${description}"` : "a subagent"
  }
  return `the tool \`${part.tool}\``
}

const errorText = (error: { type?: string | null; message?: string | null } | null | undefined): string | undefined => {
  const name = error?.type?.trim()
  const message = error?.message?.trim()
  if (name && message) return `${name}: ${message}`
  return message || name || undefined
}

/**
 * Where the previous model stopped, from what the stores hold for the session.
 * A wait for the user wins: it is what the session is blocked on even while
 * the turn counts as running.
 */
export function describeHandoffStop(input: {
  messages: readonly Message[]
  partsOf: (messageID: string) => readonly Part[]
  active: boolean
  hasQuestion: boolean
  hasPermission: boolean
  /** The newest error OpenCode reported live for the session, when newer than its last message. */
  reportedError?: string
}): HandoffStop {
  if (input.hasQuestion) return { kind: "waiting", on: "question" }
  if (input.hasPermission) return { kind: "waiting", on: "permission" }
  const last = getLastConversationMessage(input.messages)
  if (input.active) {
    if (last?.role === "assistant" && last.retry) {
      return { kind: "retrying", attempt: last.retry.attempt, error: errorText(last.retry.error) }
    }
    const running = last?.role === "assistant"
      ? input.partsOf(last.id).filter((part): part is ToolPart => part.type === "tool" && part.state.status === "running")
      : []
    if (running.length > 0) return { kind: "working", tools: running.slice(0, MAX_TOOLS_IN_NOTE).map(describeRunningTool) }
    return { kind: "replying" }
  }
  if (last?.role === "assistant" && last.error && !isStoppedTurnError(last.error.type, last.error.message)) {
    return { kind: "failed", error: errorText(last.error) }
  }
  const recorded: StructuredError | null = findRecordedTurnError(input.messages)
  if (recorded) return { kind: "failed", error: errorText(recorded) }
  if (input.reportedError) return { kind: "failed", error: input.reportedError }
  // A prompt the session went idle on without a reply never started a turn.
  if (last?.role === "user") return { kind: "failed" }
  return { kind: "idle" }
}

/**
 * The shell and subagent calls of the session's current step that the turn
 * waits on. A call waiting for a permission has no job yet, so nothing can move
 * it to the background; the interrupt ends that wait instead.
 */
export function findBlockingCalls(input: {
  messages: readonly Message[]
  partsOf: (messageID: string) => readonly Part[]
  permissionCallIDs: ReadonlySet<string>
}): BlockingCalls | null {
  const last = getLastConversationMessage(input.messages)
  if (last?.role !== "assistant") return null
  const callIDs = input.partsOf(last.id).flatMap((part) => {
    if (part.type !== "tool" || part.state.status !== "running" || input.permissionCallIDs.has(part.callID)) return []
    const blocks = isShellTool(part.tool)
      || isSubagentTool(part.tool)
      || (isExecuteTool(part.tool) && executeHasBackgroundableWork(part.state.metadata))
    return blocks ? [part.callID] : []
  })
  return callIDs.length > 0 ? { messageID: last.id, callIDs } : null
}

/** Whether every one of `blocking`'s calls has settled in `parts`. */
export function blockingCallsSettled(blocking: BlockingCalls, parts: readonly Part[]): boolean {
  return blocking.callIDs.every((callID) => {
    const part = parts.find((candidate) => candidate.type === "tool" && candidate.callID === callID)
    return part?.type === "tool" && part.state.status !== "running"
  })
}

/**
 * The running subagents below `rootId`, deepest first, so a subagent is
 * stopped before the one that launched it. `parentOf` answers from the session
 * lists the caller holds; a session it does not know ends its chain.
 */
export function runningSubagentsBelow(input: {
  rootId: string
  activeSessionIds: ReadonlySet<string>
  parentOf: (sessionId: string) => string | undefined
  describe: (sessionId: string) => { directory: string; title?: string } | undefined
}): RunningSubagent[] {
  const found: RunningSubagent[] = []
  for (const sessionID of input.activeSessionIds) {
    if (sessionID === input.rootId) continue
    const parentID = input.parentOf(sessionID)
    if (!parentID) continue
    let depth = 0
    let current: string | undefined = sessionID
    const seen = new Set<string>()
    while (current !== undefined && current !== input.rootId && !seen.has(current)) {
      seen.add(current)
      depth += 1
      current = input.parentOf(current)
    }
    if (current !== input.rootId) continue
    const known = input.describe(sessionID)
    if (!known) continue
    found.push({ sessionID, parentID, directory: known.directory, description: known.title, depth })
  }
  return found.sort((left, right) => right.depth - left.depth || left.sessionID.localeCompare(right.sessionID))
}

// ---------------------------------------------------------------------------
// The continue sequence
// ---------------------------------------------------------------------------

export type ContinueStep = "background" | "handoff" | "interrupt" | "switch" | "note" | "send"

export type ContinueResult =
  /** Continued on the new model; `failedStops` background items could not be stopped. */
  | { status: "continued"; failedStops: number }
  /** A step failed. `stopped` says whether the session's turn had already been stopped. */
  | { status: "failed"; step: ContinueStep; stopped: boolean; error?: unknown }
  /** The runtime changed before the sequence finished. */
  | { status: "runtime-changed"; stopped: boolean }
  /** A continue for this session is already running. */
  | { status: "busy" }

/** Every call the sequence makes, injected so tests drive it without a server. */
export type ContinueDeps = {
  isRuntimeCurrent: () => boolean
  moveBlockingWorkToBackground: (target: ContinueTarget) => Promise<void>
  waitForBlockingCalls: (target: ContinueTarget, blocking: BlockingCalls) => Promise<boolean>
  interrupt: (target: ContinueTarget) => Promise<void>
  /** Drops the permission cards the interrupt left behind; never throws. */
  clearInterruptedPermissions: (target: ContinueTarget, scope: "session" | "tree") => Promise<void>
  switchSelection: (target: ContinueTarget, selection: ContinueSelection) => Promise<void>
  admitNote: (target: ContinueTarget, note: HandoffNote) => Promise<void>
  stopShells: (owner: { sessionID: string; directory: string }, shells: [ShellToStop, ...ShellToStop[]]) => Promise<void>
  stopSubagent: (subagent: RunningSubagent) => Promise<void>
  sendContinue: (target: ContinueTarget, prompt: string, selection: ContinueSelection) => Promise<void>
}

const inFlight = new Set<string>()

const handoffWork = (snapshot: ContinueSnapshot, sessionId: string): HandoffWork[] => [
  ...snapshot.shells.map((shell): HandoffWork => ({ kind: "shell", shellID: shell.shellID, command: shell.command })),
  ...snapshot.subagents
    .filter((subagent) => subagent.parentID === sessionId)
    .map((subagent): HandoffWork => ({ kind: "subagent", sessionID: subagent.sessionID, description: subagent.description })),
]

const toShellToStop = (shell: RunningShell): ShellToStop => ({
  shellID: shell.shellID,
  shellDirectory: shell.shellDirectory,
  command: shell.command,
})

/**
 * Stops the background commands of one session, in one call so its agent gets
 * one note. Commands the turn waits on are left to the interrupt that stops
 * their owner. Returns how many could not be stopped.
 */
const stopBackgroundShellsOf = async (
  owner: { sessionID: string; directory: string },
  shells: readonly RunningShell[],
  deps: ContinueDeps,
): Promise<number> => {
  const [first, ...rest] = shells.filter((shell) => shell.background && shell.sessionID === owner.sessionID).map(toShellToStop)
  if (!first) return 0
  try {
    await deps.stopShells(owner, [first, ...rest])
    return 0
  } catch {
    return rest.length + 1
  }
}

/**
 * Stops everything the session started that runs outside its turn: each
 * subagent's background commands and then the subagent, deepest first, and
 * last the session's own background commands. One failure stops nothing else
 * from being tried. Returns how many items could not be stopped.
 */
const stopRunningWork = async (target: ContinueTarget, snapshot: ContinueSnapshot, deps: ContinueDeps): Promise<number> => {
  let failed = 0
  for (const subagent of snapshot.subagents) {
    failed += await stopBackgroundShellsOf({ sessionID: subagent.sessionID, directory: subagent.directory }, snapshot.shells, deps)
    try {
      await deps.stopSubagent(subagent)
    } catch {
      failed += 1
    }
  }
  failed += await stopBackgroundShellsOf({ sessionID: target.sessionId, directory: target.directory }, snapshot.shells, deps)
  return failed
}

/**
 * Stops the session's turn and continues it on `selection`.
 *
 * `keep` first moves the calls the turn waits on to the background and waits
 * until OpenCode has handed each one off; a call stopped mid-handoff would lose
 * its result, so a handoff that does not show up stops nothing. Then both
 * modes interrupt, switch the model, add the note and send the prompt, so the
 * next turn runs on the new model and starts from the note and "Continue".
 * `stop` stops the background work last: a stopped command or subagent reports
 * back into the session, and that report then lands in the new turn instead
 * of starting a turn of its own ahead of the prompt. The work is stopped even
 * when the prompt fails, because the user asked for it either way.
 */
export async function continueWithModel(input: {
  target: ContinueTarget
  mode: ContinueWorkMode
  selection: ContinueSelection
  prompt: string
  snapshot: ContinueSnapshot
}, deps: ContinueDeps): Promise<ContinueResult> {
  const { target, mode, selection, snapshot } = input
  if (inFlight.has(target.sessionId)) return { status: "busy" }
  inFlight.add(target.sessionId)
  let stopped = false
  let step: ContinueStep = "background"
  try {
    if (mode === "keep") {
      await deps.moveBlockingWorkToBackground(target)
      step = "handoff"
      if (snapshot.blocking && !(await deps.waitForBlockingCalls(target, snapshot.blocking))) {
        return { status: "failed", step, stopped }
      }
    }
    if (!deps.isRuntimeCurrent()) return { status: "runtime-changed", stopped }

    step = "interrupt"
    await deps.interrupt(target)
    stopped = true
    await deps.clearInterruptedPermissions(target, "session")
    if (!deps.isRuntimeCurrent()) return { status: "runtime-changed", stopped }

    step = "switch"
    await deps.switchSelection(target, selection)

    step = "note"
    await deps.admitNote(target, modelHandoffNote({
      from: snapshot.from,
      to: { providerID: selection.providerID, modelID: selection.modelID, variant: selection.variant ?? undefined },
      stop: snapshot.stop,
      mode,
      work: handoffWork(snapshot, target.sessionId),
    }))
    if (!deps.isRuntimeCurrent()) return { status: "runtime-changed", stopped }

    step = "send"
    let sendFailure: ContinueResult | null = null
    try {
      await deps.sendContinue(target, input.prompt, selection)
    } catch (error) {
      sendFailure = { status: "failed", step, stopped, error }
    }
    let failedStops = 0
    if (mode === "stop") {
      failedStops = await stopRunningWork(target, snapshot, deps)
      await deps.clearInterruptedPermissions(target, "tree")
    }
    return sendFailure ?? { status: "continued", failedStops }
  } catch (error) {
    return { status: "failed", step, stopped, error }
  } finally {
    inFlight.delete(target.sessionId)
  }
}

/**
 * Whether a session can be continued with another model. A subagent belongs to
 * the turn of the session that launched it: continuing it alone would fail
 * that session's call, so the action lives on the top-level session.
 */
export function canContinueWithAnotherModel(session: { id: string; parentID?: string } | null | undefined): boolean {
  return Boolean(session?.id) && !session?.parentID
}
