/**
 * Sync events: the vocabulary the sync layer reduces.
 *
 * OpenCode v2 publishes a durable event log (`session.text.delta`,
 * `session.tool.called`, `session.step.ended`, ...). The sync stores keep
 * working in terms of messages and parts, so every wire event is translated
 * here into one or more `SyncEvent`s that name the store field they touch:
 * a message appeared, a part grew, a tool call changed state. The reducer
 * never sees wire shapes, and this translation is pure (no store access), so
 * the pipeline can coalesce deltas before the reducer runs.
 *
 * Part identity follows `partIds` in `./model`: text and reasoning items are
 * addressed by `(assistantMessageID, ordinal)`, tool calls by their call id.
 */

import type { OpenCodeEvent } from "@opencode/client"
import {
  compact,
  partIds,
  type FilePart,
  type FormRequest,
  type JsonValue,
  type Message,
  type Metadata,
  type ModelRef,
  type Part,
  type PermissionRequest,
  type PermissionRuleset,
  type Session,
  type SessionStatus,
  type StructuredError,
  type TokenUsageInfo,
} from "./model"
import { projectUserParts, structuredErrorText, toolAttachments, toolOutputText } from "./projection"

// ---------------------------------------------------------------------------
// Event vocabulary
// ---------------------------------------------------------------------------

/** Fields of a session that change after creation. `null` clears a value. */
export type SessionPatch = {
  title?: string
  directory?: string
  projectID?: string
  subpath?: string | null
  agent?: string
  model?: ModelRef
  cost?: number
  tokens?: TokenUsageInfo
  permissions?: PermissionRuleset
  revert?: Session["revert"] | null
  outcome?: Session["outcome"]
  /** Full replacement of the session's metadata. */
  metadata?: Metadata
  /** `archived: null` restores an archived session. */
  time?: Partial<Omit<Session["time"], "archived">> & { archived?: number | null }
}

/** Fields of a message that change after it appeared. */
export type MessagePatch = {
  time?: { created?: number; streamed?: number; completed?: number }
  finish?: Extract<Message, { role: "assistant" }>["finish"]
  error?: StructuredError
  cost?: number
  tokens?: TokenUsageInfo
  snapshot?: { start?: string; end?: string; files?: string[] }
  retry?: Extract<Message, { role: "assistant" }>["retry"] | null
  /** Shell messages: exit status and captured output. */
  shell?: { status: "running" | "exited" | "timeout" | "killed"; exit?: number; output?: Extract<Message, { role: "shell" }>["output"] }
}

/** State transitions of a tool call that need the part's existing state to apply. */
export type ToolTransition =
  | { kind: "input"; raw: string }
  | { kind: "called"; input: Record<string, JsonValue>; executed: boolean; start: number }
  | { kind: "progress"; metadata: Metadata }
  | { kind: "success"; output: string; attachments?: FilePart[]; metadata?: Metadata; executed: boolean; end: number }
  | { kind: "failed"; error: string; output?: string; metadata?: Metadata; executed: boolean; end: number }

/**
 * What OpenCode rebuilt. v2 watches its own config files and announces the
 * rebuilt slice without saying which entry changed, so each kind names the
 * lists that have to be re-read.
 */
export type CatalogKind =
  | "config"
  | "agent"
  | "command"
  | "skill"
  | "plugin"
  | "provider"
  | "model"
  | "credential"
  | "project"
  /** Web search providers or the default choice changed (`websearch.updated`). */
  | "websearch"

export type SyncEvent =
  | { type: "server.connected"; properties: Record<never, never> }
  | { type: "installation.update-available"; properties: { version: string } }
  | { type: "session.created"; properties: { info: Session } }
  | { type: "session.patched"; properties: { sessionID: string; patch: SessionPatch } }
  | { type: "session.deleted"; properties: { sessionID: string } }
  /**
   * A session was forked. OpenCode 2.x publishes no `session.created` for the
   * fork and this event carries ids only, so the sync layer reads the fork's
   * record and applies it as a `session.created`.
   */
  | { type: "session.forked"; properties: { sessionID: string; parentID: string } }
  /**
   * A staged revert became permanent: OpenCode deleted the boundary message
   * `to` and everything after it. The reducer trims the same range locally,
   * because no `message.removed` follows and a later fetch keeps whatever the
   * store still holds.
   */
  | { type: "session.revert.committed"; properties: { sessionID: string; to: string } }
  | { type: "session.status"; properties: { sessionID: string; status: SessionStatus } }
  | { type: "session.idle"; properties: { sessionID: string } }
  | { type: "session.error"; properties: { sessionID: string; error: StructuredError } }
  | { type: "message.updated"; properties: { info: Message } }
  | { type: "message.patched"; properties: { sessionID: string; messageID: string; patch: MessagePatch } }
  | { type: "message.removed"; properties: { sessionID: string; messageID: string } }
  | { type: "message.part.updated"; properties: { sessionID: string; part: Part } }
  | { type: "message.part.delta"; properties: { sessionID: string; messageID: string; partID: string; field: "text" | "raw"; delta: string } }
  | { type: "message.tool.transition"; properties: { sessionID: string; messageID: string; partID: string; transition: ToolTransition } }
  | { type: "message.parts.replaced"; properties: { sessionID: string; messageID: string; parts: Part[] } }
  /** Text appended to the summary of the compaction currently running in the session. */
  | { type: "message.compaction.delta"; properties: { sessionID: string; delta: string } }
  | { type: "permission.asked"; properties: PermissionRequest }
  | { type: "permission.replied"; properties: { sessionID: string; requestID: string } }
  | { type: "form.created"; properties: { form: FormRequest } }
  | { type: "form.settled"; properties: { sessionID: string; formID: string } }
  | { type: "vcs.branch.updated"; properties: { branch?: string } }
  | { type: "mcp.status.changed"; properties: { server: string } }
  | { type: "catalog.updated"; properties: { kind: CatalogKind } }
  /**
   * OpenCode dropped the cached services for this directory (idle eviction or
   * an explicit reload). Everything read from it is now suspect.
   */
  | { type: "location.shutdown"; properties: Record<never, never> }
  // OpenChamber's own server frames that ride the same stream.
  | { type: "openchamber.notification"; properties: OpenchamberNotification }
  | { type: "openchamber.permission-auto-accept"; properties: { sessions: Record<string, boolean>; revision?: number } }

/** Agent-completion / restart notices the OpenChamber server publishes for non-web runtimes. */
export type OpenchamberNotification = {
  kind?: string
  sessionId?: string
  directory?: string
  title?: string
  body?: string
  tag?: string
  requireHidden?: boolean
  desktopNotificationDelivered?: boolean
  desktopStdoutActive?: boolean
}

export type SyncEventType = SyncEvent["type"]

/** A translated event together with the directory it belongs to. */
export type RoutedSyncEvent = {
  directory: string
  event: SyncEvent
}

export const GLOBAL_EVENT_DIRECTORY = "global"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ZERO_TOKENS: TokenUsageInfo = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

/** Server events and the messages they create share one id space (`evt_` → `msg_`). */
export const messageIdFromEvent = (eventID: string): string => eventID.replace(/^evt_/, "msg_")

const eventDirectory = (event: OpenCodeEvent): string => event.location?.directory ?? GLOBAL_EVENT_DIRECTORY

const sessionEvent = (sessionID: string, patch: SessionPatch): SyncEvent => ({
  type: "session.patched",
  properties: { sessionID, patch },
})

const messagePatch = (sessionID: string, messageID: string, patch: MessagePatch): SyncEvent => ({
  type: "message.patched",
  properties: { sessionID, messageID, patch },
})

const partUpdated = (sessionID: string, part: Part): SyncEvent => ({
  type: "message.part.updated",
  properties: { sessionID, part },
})

const toolTransition = (sessionID: string, messageID: string, callID: string, transition: ToolTransition): SyncEvent => ({
  type: "message.tool.transition",
  properties: { sessionID, messageID, partID: partIds.tool(callID), transition },
})

const finiteExit = (exit: number | "Infinity" | "-Infinity" | "NaN" | undefined): number | undefined =>
  exit === "Infinity" || exit === "-Infinity" || exit === "NaN" ? undefined : exit

// ---------------------------------------------------------------------------
// Translation
// ---------------------------------------------------------------------------

/**
 * Translates one wire event. Returns nothing for events the sync layer does
 * not model (usage records, inbox delivery changes, TUI events, ...).
 */
export function translateWireEvent(event: OpenCodeEvent): SyncEvent[] {
  switch (event.type) {
    case "server.connected":
      return [{ type: "server.connected", properties: {} }]

    case "installation.update-available":
      return [{ type: "installation.update-available", properties: { version: event.data.version } }]

    // --- sessions -----------------------------------------------------------

    case "session.created": {
      const info: Session = compact({
        id: event.data.sessionID,
        parentID: event.data.parentID,
        projectID: event.data.projectID,
        directory: event.data.location.directory,
        subpath: event.data.subpath,
        title: event.data.title ?? "",
        agent: event.data.agent,
        model: event.data.model,
        cost: 0,
        tokens: ZERO_TOKENS,
        time: { created: event.created, updated: event.created },
        metadata: event.data.metadata,
        permissions: event.data.permissions,
      })
      return [{ type: "session.created", properties: { info } }]
    }
    case "session.deleted":
      return [{ type: "session.deleted", properties: { sessionID: event.data.sessionID } }]
    // No `session.created` follows a fork in 2.x; see the sync event's doc.
    case "session.forked":
      return [{ type: "session.forked", properties: { sessionID: event.data.sessionID, parentID: event.data.parentID } }]
    case "session.renamed":
      return [sessionEvent(event.data.sessionID, { title: event.data.title, time: { updated: event.created } })]
    // OpenCode's record holds the full metadata, so this replaces it.
    case "session.metadata.updated":
      return [sessionEvent(event.data.sessionID, { metadata: event.data.metadata })]
    case "session.moved":
      return [
        sessionEvent(event.data.sessionID, {
          directory: event.data.location.directory,
          projectID: event.data.projectID,
          subpath: event.data.subpath ?? null,
          time: { updated: event.created },
        }),
        {
          type: "message.updated",
          properties: {
            info: {
              id: messageIdFromEvent(event.id),
              sessionID: event.data.sessionID,
              role: "location-switched",
              time: { created: event.created },
              directory: event.data.location.directory,
            },
          },
        },
      ]
    case "session.agent.selected":
      return [
        sessionEvent(event.data.sessionID, { agent: event.data.agent }),
        {
          type: "message.updated",
          properties: {
            info: compact({
              id: messageIdFromEvent(event.id),
              sessionID: event.data.sessionID,
              role: "agent-switched",
              time: { created: event.created },
              agent: event.data.agent,
              previous: event.data.previous,
            }),
          },
        },
      ]
    case "session.model.selected":
      return [
        sessionEvent(event.data.sessionID, { model: event.data.model }),
        {
          type: "message.updated",
          properties: {
            info: compact({
              id: messageIdFromEvent(event.id),
              sessionID: event.data.sessionID,
              role: "model-switched",
              time: { created: event.created },
              model: event.data.model,
              previous: event.data.previous,
            }),
          },
        },
      ]
    case "session.usage.updated":
      return [sessionEvent(event.data.sessionID, { cost: event.data.cost, tokens: event.data.tokens, time: { updated: event.created } })]
    case "session.permissions":
      return [sessionEvent(event.data.sessionID, { permissions: event.data.permissions })]
    case "session.viewed":
      return [sessionEvent(event.data.sessionID, { time: { viewed: event.created } })]
    case "session.revert.staged":
      return [sessionEvent(event.data.sessionID, { revert: event.data.revert })]
    case "session.revert.cleared":
      return [sessionEvent(event.data.sessionID, { revert: null })]
    case "session.revert.committed":
      // Trim first, then drop the marker; the global session list only needs
      // the marker gone.
      return [
        { type: "session.revert.committed", properties: { sessionID: event.data.sessionID, to: event.data.to } },
        sessionEvent(event.data.sessionID, { revert: null }),
      ]

    // --- live status --------------------------------------------------------

    case "session.status":
      return [{ type: "session.status", properties: { sessionID: event.data.sessionID, status: event.data.status } }]
    case "session.idle":
      return [{ type: "session.idle", properties: { sessionID: event.data.sessionID } }]
    case "session.execution.started":
      return [{ type: "session.status", properties: { sessionID: event.data.sessionID, status: { type: "busy" } } }]
    case "session.execution.succeeded":
      return [
        sessionEvent(event.data.sessionID, { outcome: "succeeded", time: { idle: event.created, updated: event.created } }),
        { type: "session.idle", properties: { sessionID: event.data.sessionID } },
      ]
    case "session.execution.interrupted":
      // `shutdown` is OpenCode itself going away mid-turn. It keeps the
      // execution claim and resumes the drain on restart, records no idle
      // outcome and leaves the assistant message open, so the UI must not
      // settle the session or mark the turn interrupted either: the status
      // snapshot after reconnect is the authority. Every other reason is a
      // real stop.
      if (event.data.reason === "shutdown") return []
      return [
        sessionEvent(event.data.sessionID, { outcome: "interrupted", time: { idle: event.created, updated: event.created } }),
        { type: "session.idle", properties: { sessionID: event.data.sessionID } },
      ]
    case "session.execution.failed":
      return [
        sessionEvent(event.data.sessionID, { outcome: "failed", time: { idle: event.created, updated: event.created } }),
        { type: "session.error", properties: { sessionID: event.data.sessionID, error: event.data.error } },
      ]

    // --- user input ---------------------------------------------------------

    case "session.inbox.enqueued": {
      const item = event.data.item
      const messageID = event.data.inboxID
      if (item.type === "user") {
        return [
          {
            type: "message.updated",
            properties: {
              info: compact({
                id: messageID,
                sessionID: event.data.sessionID,
                role: "user",
                time: { created: event.created },
                metadata: item.payload.metadata,
              }),
            },
          },
          {
            type: "message.parts.replaced",
            properties: {
              sessionID: event.data.sessionID,
              messageID,
              parts: projectUserParts(item.payload, { sessionID: event.data.sessionID, messageID, created: event.created }),
            },
          },
        ]
      }
      if (item.type === "synthetic") {
        return [
          {
            type: "message.updated",
            properties: {
              info: compact({
                id: messageID,
                sessionID: event.data.sessionID,
                role: "synthetic",
                time: { created: event.created },
                text: item.payload.text,
                description: item.payload.description,
                metadata: item.payload.metadata,
              }),
            },
          },
        ]
      }
      return []
    }
    case "session.inbox.delivered":
      return [messagePatch(event.data.sessionID, event.data.inboxID, { time: { created: event.created } })]
    case "session.inbox.cancelled":
      return [{ type: "message.removed", properties: { sessionID: event.data.sessionID, messageID: event.data.inboxID } }]
    case "session.synthetic":
      return [
        {
          type: "message.updated",
          properties: {
            info: compact({
              id: messageIdFromEvent(event.id),
              sessionID: event.data.sessionID,
              role: "synthetic",
              time: { created: event.created },
              text: event.data.text,
              description: event.data.description,
            }),
          },
        },
      ]
    case "session.skill.activated":
      return [
        {
          type: "message.updated",
          properties: {
            info: {
              id: messageIdFromEvent(event.id),
              sessionID: event.data.sessionID,
              role: "skill",
              time: { created: event.created },
              skill: event.data.id,
              name: event.data.name,
              text: event.data.text,
            },
          },
        },
      ]
    case "session.instructions.updated": {
      if (event.data.text === undefined) return []
      return [
        {
          type: "message.updated",
          properties: {
            info: {
              id: messageIdFromEvent(event.id),
              sessionID: event.data.sessionID,
              role: "system",
              time: { created: event.created },
              text: event.data.text,
              description: `Instructions updated: ${Object.keys(event.data.delta ?? {}).join(", ")}`,
            },
          },
        },
      ]
    }

    // --- assistant steps ----------------------------------------------------

    case "session.step.started":
      return [
        {
          type: "message.updated",
          properties: {
            info: compact({
              id: event.data.assistantMessageID,
              sessionID: event.data.sessionID,
              role: "assistant",
              time: { created: event.created },
              agent: event.data.agent,
              providerID: event.data.model.providerID,
              modelID: event.data.model.id,
              variant: event.data.model.variant,
              snapshot: event.data.snapshot ? { start: event.data.snapshot } : undefined,
            }),
          },
        },
      ]
    case "session.step.streamed":
      return [messagePatch(event.data.sessionID, event.data.assistantMessageID, { time: { streamed: event.created } })]
    case "session.step.ended":
      return [
        messagePatch(
          event.data.sessionID,
          event.data.assistantMessageID,
          compact({
            time: { completed: event.created },
            finish: event.data.finish,
            cost: event.data.cost,
            tokens: event.data.tokens,
            snapshot: event.data.snapshot ? { end: event.data.snapshot, files: event.data.files } : undefined,
            retry: null,
          }),
        ),
      ]
    case "session.step.failed":
      return [
        messagePatch(
          event.data.sessionID,
          event.data.assistantMessageID,
          compact({
            time: { completed: event.created },
            finish: event.data.finish ?? "error",
            error: event.data.error,
            cost: event.data.cost,
            tokens: event.data.tokens,
            retry: null,
          }),
        ),
      ]
    case "session.retry.scheduled":
      return [
        messagePatch(event.data.sessionID, event.data.assistantMessageID, {
          retry: { attempt: event.data.attempt, at: event.data.at, error: event.data.error },
        }),
      ]
    // --- text and reasoning -------------------------------------------------

    case "session.text.started":
      return [
        partUpdated(event.data.sessionID, {
          id: partIds.text(event.data.assistantMessageID, event.data.ordinal),
          sessionID: event.data.sessionID,
          messageID: event.data.assistantMessageID,
          type: "text",
          text: "",
          time: { start: event.created },
        }),
      ]
    case "session.text.delta":
      return [
        {
          type: "message.part.delta",
          properties: {
            sessionID: event.data.sessionID,
            messageID: event.data.assistantMessageID,
            partID: partIds.text(event.data.assistantMessageID, event.data.ordinal),
            field: "text",
            delta: event.data.delta,
          },
        },
      ]
    // `ended` carries no start; the reducer keeps the start it saw on
    // `started`, and this one only stands in when the stream was joined late.
    case "session.text.ended":
      return [
        partUpdated(event.data.sessionID, {
          id: partIds.text(event.data.assistantMessageID, event.data.ordinal),
          sessionID: event.data.sessionID,
          messageID: event.data.assistantMessageID,
          type: "text",
          text: event.data.text,
          time: { start: event.created, end: event.created },
        }),
      ]
    case "session.reasoning.started":
      return [
        partUpdated(event.data.sessionID, {
          id: partIds.reasoning(event.data.assistantMessageID, event.data.ordinal),
          sessionID: event.data.sessionID,
          messageID: event.data.assistantMessageID,
          type: "reasoning",
          text: "",
          time: { start: event.created },
        }),
      ]
    case "session.reasoning.delta":
      return [
        {
          type: "message.part.delta",
          properties: {
            sessionID: event.data.sessionID,
            messageID: event.data.assistantMessageID,
            partID: partIds.reasoning(event.data.assistantMessageID, event.data.ordinal),
            field: "text",
            delta: event.data.delta,
          },
        },
      ]
    case "session.reasoning.ended":
      return [
        partUpdated(event.data.sessionID, {
          id: partIds.reasoning(event.data.assistantMessageID, event.data.ordinal),
          sessionID: event.data.sessionID,
          messageID: event.data.assistantMessageID,
          type: "reasoning",
          text: event.data.text,
          time: { start: event.created, end: event.created },
        }),
      ]

    // --- tool calls ---------------------------------------------------------

    case "session.tool.input.started":
      return [
        partUpdated(event.data.sessionID, {
          id: partIds.tool(event.data.id),
          sessionID: event.data.sessionID,
          messageID: event.data.assistantMessageID,
          type: "tool",
          callID: event.data.id,
          tool: event.data.name,
          state: { status: "pending", input: {}, raw: "" },
        }),
      ]
    case "session.tool.input.delta":
      return [
        {
          type: "message.part.delta",
          properties: {
            sessionID: event.data.sessionID,
            messageID: event.data.assistantMessageID,
            partID: partIds.tool(event.data.id),
            field: "raw",
            delta: event.data.delta,
          },
        },
      ]
    case "session.tool.input.ended":
      return [toolTransition(event.data.sessionID, event.data.assistantMessageID, event.data.id, { kind: "input", raw: event.data.text })]
    case "session.tool.called":
      return [
        toolTransition(event.data.sessionID, event.data.assistantMessageID, event.data.id, {
          kind: "called",
          input: event.data.input,
          executed: event.data.executed,
          start: event.created,
        }),
      ]
    case "session.tool.progress":
      return [toolTransition(event.data.sessionID, event.data.assistantMessageID, event.data.id, { kind: "progress", metadata: event.data.metadata })]
    case "session.tool.success":
      return [
        toolTransition(
          event.data.sessionID,
          event.data.assistantMessageID,
          event.data.id,
          compact({
            kind: "success",
            output: toolOutputText(event.data.content),
            attachments: toolAttachments(event.data.content, {
              sessionID: event.data.sessionID,
              messageID: event.data.assistantMessageID,
              callID: event.data.id,
            }),
            metadata: event.data.metadata,
            executed: event.data.executed,
            end: event.created,
          }),
        ),
      ]
    case "session.tool.failed":
      return [
        toolTransition(
          event.data.sessionID,
          event.data.assistantMessageID,
          event.data.id,
          compact({
            kind: "failed",
            error: structuredErrorText(event.data.error),
            output: toolOutputText(event.data.content) || undefined,
            metadata: event.data.metadata,
            executed: event.data.executed,
            end: event.created,
          }),
        ),
      ]

    // --- shell and compaction -------------------------------------------------

    case "session.shell.started":
      return [
        {
          type: "message.updated",
          properties: {
            info: compact({
              id: messageIdFromEvent(event.id),
              sessionID: event.data.sessionID,
              role: "shell",
              time: { created: event.created },
              shellID: event.data.shell.id,
              command: event.data.shell.command,
              status: event.data.shell.status,
              exit: finiteExit(event.data.shell.exit),
            }),
          },
        },
      ]
    case "session.shell.ended":
      // The shell message id is derived from the started event, which we
      // cannot recover here; the reducer matches shell messages by shellID.
      return [
        {
          type: "message.patched",
          properties: {
            sessionID: event.data.sessionID,
            messageID: `shell:${event.data.shell.id}`,
            patch: {
              time: { completed: event.created },
              shell: compact({ status: event.data.shell.status, exit: finiteExit(event.data.shell.exit), output: event.data.output }),
            },
          },
        },
      ]
    case "session.compaction.started":
      return [
        {
          type: "message.updated",
          properties: {
            info: {
              id: event.data.inputID ?? messageIdFromEvent(event.id),
              sessionID: event.data.sessionID,
              role: "compaction",
              time: { created: event.created },
              status: "running",
              reason: event.data.reason,
              summary: "",
            },
          },
        },
      ]
    // The summary streams into the running compaction record; the event names
    // only the session, so the reducer finds that record itself.
    case "session.compaction.delta":
      return [{ type: "message.compaction.delta", properties: { sessionID: event.data.sessionID, delta: event.data.text } }]
    case "session.compaction.ended":
      return [
        {
          type: "message.updated",
          properties: {
            info: compact({
              id: messageIdFromEvent(event.id),
              sessionID: event.data.sessionID,
              role: "compaction",
              time: { created: event.created },
              status: "completed",
              reason: event.data.reason,
              summary: event.data.text,
              cost: event.data.cost,
              tokens: event.data.tokens,
            }),
          },
        },
      ]
    case "session.compaction.failed":
      return [
        {
          type: "message.updated",
          properties: {
            info: compact({
              id: event.data.inputID ?? messageIdFromEvent(event.id),
              sessionID: event.data.sessionID,
              role: "compaction",
              time: { created: event.created },
              status: "failed",
              reason: event.data.reason,
              summary: "",
              error: event.data.error,
              cost: event.data.cost,
              tokens: event.data.tokens,
            }),
          },
        },
      ]

    // --- requests to the user -------------------------------------------------

    case "permission.asked":
      return [{ type: "permission.asked", properties: compact({ ...event.data }) }]
    case "permission.replied":
      return [{ type: "permission.replied", properties: { sessionID: event.data.sessionID, requestID: event.data.requestID } }]
    case "form.created":
      return [{ type: "form.created", properties: { form: event.data.form } }]
    case "form.replied":
    case "form.cancelled":
      return [{ type: "form.settled", properties: { sessionID: event.data.sessionID, formID: event.data.id } }]

    // --- location-level notices ------------------------------------------------

    case "vcs.branch.updated":
      return [{ type: "vcs.branch.updated", properties: compact({ branch: event.data.branch }) }]
    case "mcp.status.changed":
      return [{ type: "mcp.status.changed", properties: { server: event.data.server } }]
    case "location.shutdown":
      return [{ type: "location.shutdown", properties: {} }]
    case "config.updated":
      return [{ type: "catalog.updated", properties: { kind: "config" } }]
    case "agent.updated":
      return [{ type: "catalog.updated", properties: { kind: "agent" } }]
    case "command.updated":
      return [{ type: "catalog.updated", properties: { kind: "command" } }]
    case "skill.updated":
      return [{ type: "catalog.updated", properties: { kind: "skill" } }]
    case "plugin.updated":
      return [{ type: "catalog.updated", properties: { kind: "plugin" } }]
    case "credential.updated":
    case "credential.switched":
      return [{ type: "catalog.updated", properties: { kind: "credential" } }]
    case "project.updated":
      return [{ type: "catalog.updated", properties: { kind: "project" } }]
    // 2.0.8 replaced the `catalog.updated` storm with two deduplicated
    // announcements: the provider list changed, and the model list it
    // materialises changed. Both re-read the provider/model lists.
    case "provider.updated":
      return [{ type: "catalog.updated", properties: { kind: "provider" } }]
    case "model.updated":
      return [{ type: "catalog.updated", properties: { kind: "model" } }]
    case "websearch.updated":
      return [{ type: "catalog.updated", properties: { kind: "websearch" } }]

    // --- known events the sync layer deliberately does not model -------------
    //
    // Every wire event is listed so a new one in a future OpenCode fails the
    // type-check here instead of being silently dropped.

    // A login or logout changes the integration list; OpenCode republishes
    // `provider.updated` (and then `model.updated`) for the same change, so
    // acting here too would only double every read.
    case "integration.updated":
      return []
    // Queue-vs-steer placement of a pending inbox item is not shown.
    case "session.inbox.delivery.changed":
      return []
    // The update is applied by the desktop/CLI updater, not by the UI;
    // `installation.update-available` is the one the UI acts on.
    case "installation.updated":
      return []
    // Catalogs OpenChamber does not surface as lists of their own.
    case "models-dev.refreshed":
    case "reference.updated":
      return []
    // Resources of an MCP server; OpenChamber shows connection status only
    // (`mcp.status.changed`).
    case "mcp.resources.changed":
      return []
    // OpenChamber watches the filesystem through its own server routes.
    case "filesystem.changed":
      return []
    // Worktrees go through OpenChamber's own git API, not OpenCode's.
    case "worktree.updated":
    case "worktree.resolved":
      return []
    // Free-standing shells and PTYs are the TUI's and the terminal panel's
    // own transports; neither reads them from this stream.
    case "shell.created":
    case "shell.deleted":
    case "shell.exited":
    case "pty.created":
    case "pty.updated":
    case "pty.deleted":
    case "pty.exited":
    case "persistent-pty.added":
    case "persistent-pty.removed":
      return []
    // Never framed onto the public stream in 2.0.8, so they cannot reach here
    // and are not listed above: `session.message.content.updated` (replay-only
    // for transcripts written by older releases), `session.usage.recorded`
    // (side-channel spend; the session totals arrive as `session.usage.updated`)
    // and `log.synced` (durable-log bookkeeping).

    // Addressed to the TUI client.
    case "tui.command.execute":
    case "tui.prompt.append":
    case "tui.session.select":
    case "tui.toast.show":
      return []

    default: {
      // Exhaustiveness: only the open-ended `rpc.*` frames (addressed to a
      // plugin's RPC endpoint, never to us) may reach here.
      const remaining: `rpc.${string}` = event.type
      void remaining
      return []
    }
  }
}

/** Translates a wire event and tags every resulting sync event with its directory. */
export function routeWireEvent(event: OpenCodeEvent): RoutedSyncEvent[] {
  const directory = eventDirectory(event)
  return translateWireEvent(event).map((translated) => ({ directory, event: translated }))
}

/** Session an event addresses, when it addresses one. */
export function syncEventSessionID(event: SyncEvent): string | undefined {
  switch (event.type) {
    case "session.created":
      return event.properties.info.id
    case "message.updated":
      return event.properties.info.sessionID
    case "permission.asked":
      return event.properties.sessionID
    case "form.created":
      return event.properties.form.sessionID
    case "session.patched":
    case "session.deleted":
    case "session.forked":
    case "session.revert.committed":
    case "session.status":
    case "session.idle":
    case "session.error":
    case "message.patched":
    case "message.removed":
    case "message.part.updated":
    case "message.part.delta":
    case "message.tool.transition":
    case "message.parts.replaced":
    case "message.compaction.delta":
    case "permission.replied":
    case "form.settled":
      return event.properties.sessionID
    default:
      return undefined
  }
}

/** Message an event addresses, when it addresses one. */
export function syncEventMessageID(event: SyncEvent): string | undefined {
  switch (event.type) {
    case "message.updated":
      return event.properties.info.id
    case "message.part.updated":
      return event.properties.part.messageID
    case "message.patched":
    case "message.removed":
    case "message.part.delta":
    case "message.tool.transition":
    case "message.parts.replaced":
      return event.properties.messageID
    default:
      return undefined
  }
}
