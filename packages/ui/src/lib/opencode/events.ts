
import type { OpenCodeEvent } from "@opencode/client"
import type { WorkflowRun } from "@/lib/workflows/model"
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
  type SessionOutcome,
  type StructuredError,
  type TokenUsageInfo,
} from "./model"
import { projectInboxMessage, sessionParentID, structuredErrorText, toolAttachments, toolOutputText } from "./projection"
import { runningShellFromWire, type RunningShell, type ShellEnd } from "./background-shell"
import { imageJobUpdate, type ImageJobUpdate } from "./background-image"


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
  metadata?: Metadata
  time?: Partial<Omit<Session["time"], "archived">> & { archived?: number | null }
}

export type MessagePatch = {
  time?: { created?: number; firstToken?: number; streamed?: number; completed?: number }
  finish?: Extract<Message, { role: "assistant" }>["finish"]
  error?: StructuredError
  cost?: number
  tokens?: TokenUsageInfo
  snapshot?: { start?: string; end?: string; files?: string[] }
  retry?: Extract<Message, { role: "assistant" }>["retry"] | null
  shell?: { status: "running" | "exited" | "timeout" | "killed"; exit?: number; signal?: string; output?: Extract<Message, { role: "shell" }>["output"] }
}

export type ToolTransition =
  | { kind: "input"; raw: string }
  | { kind: "called"; input: Record<string, JsonValue>; executed: boolean; start: number }
  | { kind: "progress"; metadata: Metadata }
  | { kind: "success"; output: string; attachments?: FilePart[]; metadata?: Metadata; executed: boolean; end: number }
  | { kind: "failed"; error: string; errorType?: string; output?: string; metadata?: Metadata; executed: boolean; end: number }

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
  | "websearch"

export type SessionTurnStart = { at: number; source: "host" | "live" }

export const hostTurnStart = (startedAt: number, hostNow: number): SessionTurnStart => ({
  at: Date.now() - Math.max(0, hostNow - startedAt),
  source: "host",
})

export type SyncEvent =
  | { type: "server.connected"; properties: Record<never, never> }
  | { type: "installation.update-available"; properties: { version: string } }
  | { type: "session.created"; properties: { info: Session } }
  | { type: "session.patched"; properties: { sessionID: string; patch: SessionPatch } }
  | { type: "session.deleted"; properties: { sessionID: string } }
  // external: https://github.com/anomalyco/opencode/tree/v2.3.0/packages/core/src/session Fork events carry IDs without a session.created event; sync fetches the fork record.
  | { type: "session.forked"; properties: { sessionID: string; parentID: string } }
  // external: https://github.com/anomalyco/opencode/tree/v2.3.0/packages/core/src/session Committing a revert removes the boundary and later messages without message.removed events.
  | { type: "session.revert.committed"; properties: { sessionID: string; to: string } }
  | { type: "session.status"; properties: { sessionID: string; status: SessionStatus; turnStart?: SessionTurnStart } }
  | { type: "session.idle"; properties: { sessionID: string; outcome?: SessionOutcome } }
  | { type: "session.error"; properties: { sessionID: string; error: StructuredError } }
  | { type: "message.updated"; properties: { info: Message } }
  | { type: "message.patched"; properties: { sessionID: string; messageID: string; patch: MessagePatch } }
  | { type: "message.removed"; properties: { sessionID: string; messageID: string } }
  | { type: "message.part.updated"; properties: { sessionID: string; part: Part } }
  | { type: "message.part.delta"; properties: { sessionID: string; messageID: string; partID: string; field: "text" | "raw"; delta: string } }
  | { type: "message.tool.transition"; properties: { sessionID: string; messageID: string; partID: string; transition: ToolTransition } }
  | { type: "message.parts.replaced"; properties: { sessionID: string; messageID: string; parts: Part[]; whilePending?: true } }
  | { type: "message.compaction.delta"; properties: { sessionID: string; delta: string } }
  | { type: "permission.asked"; properties: PermissionRequest }
  | { type: "permission.replied"; properties: { sessionID: string; requestID: string } }
  | { type: "form.created"; properties: { form: FormRequest } }
  | {
    type: "form.settled"
    properties: {
      sessionID: string
      formID: string
      disposition?: "replied" | "cancelled"
    }
  }
  | { type: "shell.started"; properties: { shell: RunningShell } }
  | { type: "shell.ended"; properties: { shellID: string; end: ShellEnd; endedAt: number } }
  | { type: "image.job.updated"; properties: ImageJobUpdate }
  | { type: "vcs.branch.updated"; properties: { branch?: string } }
  | { type: "filesystem.changed"; properties: { file: string } }
  | { type: "mcp.status.changed"; properties: { server: string } }
  | { type: "catalog.updated"; properties: { kind: CatalogKind } }
  | { type: "location.shutdown"; properties: Record<never, never> }
  | { type: "openchamber.notification"; properties: OpenchamberNotification }
  | { type: "openchamber.permission-auto-accept"; properties: { sessions: Record<string, boolean>; modes?: Record<string, "ask" | "safety" | "auto">; revision?: number; spaceId?: string } }
  | { type: "openchamber.permission-left-for-user"; properties: { permissionId: string; sessionId: string; directory: string | null; spaceId?: string } }
  | { type: "openchamber.page-waiting"; properties: { sessionID: string; directory: string | null; page: { id: string; title: string } } }
  | { type: "openchamber.page-settled"; properties: { sessionID: string; pageID: string } }
  | { type: "openchamber.session-assist"; properties: { sessionID: string; directory: string | null; pending: boolean } }
  | { type: "openchamber.workflow-run"; properties: { run: WorkflowRun } }
  | { type: "openchamber.workflow-run-removed"; properties: { runId: string; parentSessionId: string } }

export type OpenchamberNotification = {
  kind?: string
  sessionId?: string
  directory?: string
  title?: string
  body?: string
  tag?: string
  requireHidden?: boolean
  showWhenFocused?: boolean
  toastOnly?: boolean
  desktopNotificationDelivered?: boolean
  desktopStdoutActive?: boolean
}

export type RoutedSyncEvent = {
  directory: string
  event: SyncEvent
}

export const GLOBAL_EVENT_DIRECTORY = "global"


const ZERO_TOKENS: TokenUsageInfo = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

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


export function translateWireEvent(event: OpenCodeEvent): SyncEvent[] {
  switch (event.type) {
    case "server.connected":
      return [{ type: "server.connected", properties: {} }]

    case "installation.update-available":
      return [{ type: "installation.update-available", properties: { version: event.data.version } }]


    case "session.created": {
      const info: Session = compact({
        id: event.data.sessionID,
        parentID: sessionParentID(event.data),
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
    case "session.forked":
      return [{ type: "session.forked", properties: { sessionID: event.data.sessionID, parentID: event.data.parentID } }]
    case "session.renamed":
      return [sessionEvent(event.data.sessionID, { title: event.data.title, time: { updated: event.created } })]
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
        sessionEvent(event.data.sessionID, { agent: event.data.agent, time: { updated: event.created } }),
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
        sessionEvent(event.data.sessionID, { model: event.data.model, time: { updated: event.created } }),
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
      return [sessionEvent(event.data.sessionID, { time: { viewed: event.data.idle } })]
    case "session.archived":
      return [sessionEvent(event.data.sessionID, { time: { archived: event.created, updated: event.created } })]
    case "session.unarchived":
      return [sessionEvent(event.data.sessionID, { time: { archived: null, updated: event.created } })]
    case "session.revert.staged":
      return [sessionEvent(event.data.sessionID, { revert: event.data.revert })]
    case "session.revert.cleared":
      return [sessionEvent(event.data.sessionID, { revert: null })]
    case "session.revert.committed":
      return [
        { type: "session.revert.committed", properties: { sessionID: event.data.sessionID, to: event.data.to } },
        sessionEvent(event.data.sessionID, { revert: null }),
      ]


    case "session.status":
      return [{ type: "session.status", properties: { sessionID: event.data.sessionID, status: event.data.status } }]
    case "session.idle":
      return [{ type: "session.idle", properties: { sessionID: event.data.sessionID } }]
    case "session.execution.started":
      return [{
        type: "session.status",
        properties: { sessionID: event.data.sessionID, status: { type: "busy" }, turnStart: { at: Date.now(), source: "live" } },
      }]
    case "session.execution.succeeded":
      return [
        sessionEvent(event.data.sessionID, { outcome: "succeeded", time: { idle: event.created, updated: event.created } }),
        { type: "session.idle", properties: { sessionID: event.data.sessionID, outcome: "succeeded" } },
      ]
    case "session.execution.interrupted":
      // external: https://github.com/anomalyco/opencode/tree/v2.3.0/packages/core/src/session Shutdown retains the execution claim for restart; reconnect status remains authoritative.
      if (event.data.reason === "shutdown") return []
      return [
        sessionEvent(event.data.sessionID, { outcome: "interrupted", time: { idle: event.created, updated: event.created } }),
        { type: "session.idle", properties: { sessionID: event.data.sessionID, outcome: "interrupted" } },
      ]
    case "session.execution.failed":
      return [
        sessionEvent(event.data.sessionID, { outcome: "failed", time: { idle: event.created, updated: event.created } }),
        { type: "session.error", properties: { sessionID: event.data.sessionID, error: event.data.error } },
      ]


    case "session.inbox.enqueued": {
      const projected = projectInboxMessage(event.data.item, {
        sessionID: event.data.sessionID,
        messageID: event.data.inboxID,
        created: event.created,
      })
      if (!projected) return []
      const updated: SyncEvent = { type: "message.updated", properties: { info: projected.info } }
      if (!projected.parts) return [updated]
      return [
        updated,
        {
          type: "message.parts.replaced",
          properties: { sessionID: event.data.sessionID, messageID: event.data.inboxID, parts: projected.parts, whilePending: true },
        },
      ]
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
              metadata: event.data.metadata,
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
              metadata: { notice: "instructions", instructionSources: Object.keys(event.data.delta ?? {}) },
            },
          },
        },
      ]
    }


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
    case "session.step.first-token":
      return [messagePatch(event.data.sessionID, event.data.assistantMessageID, { time: { firstToken: event.created } })]
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
            errorType: event.data.error.type,
            output: toolOutputText(event.data.content) || undefined,
            metadata: event.data.metadata,
            executed: event.data.executed,
            end: event.created,
          }),
        ),
      ]


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
              model: event.data.model,
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


    case "permission.asked":
      return [{ type: "permission.asked", properties: compact({ ...event.data }) }]
    case "permission.replied":
      return [{ type: "permission.replied", properties: { sessionID: event.data.sessionID, requestID: event.data.requestID } }]
    case "form.created":
      return [{ type: "form.created", properties: { form: event.data.form } }]
    case "form.replied":
      return [{ type: "form.settled", properties: { sessionID: event.data.sessionID, formID: event.data.id, disposition: "replied" } }]
    case "form.cancelled":
      return [{ type: "form.settled", properties: { sessionID: event.data.sessionID, formID: event.data.id, disposition: "cancelled" } }]


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
    case "provider.updated":
      return [{ type: "catalog.updated", properties: { kind: "provider" } }]
    case "model.updated":
      return [{ type: "catalog.updated", properties: { kind: "model" } }]
    case "websearch.updated":
      return [{ type: "catalog.updated", properties: { kind: "websearch" } }]

    // external: https://github.com/anomalyco/opencode/tree/v2.3.0/packages/core/src Integration changes also publish provider.updated and model.updated; handling both doubles catalog reads.
    case "integration.updated":
    case "session.inbox.delivery.changed":
    case "installation.updated":
    case "models-dev.refreshed":
    case "reference.updated":
    case "mcp.resources.changed":
    case "experimental.mcp.event":
      return []
    case "filesystem.changed":
      return [{ type: "filesystem.changed", properties: { file: event.data.file } }]
    case "worktree.updated":
    case "worktree.resolved":
      return []

    case "shell.created": {
      const shell = runningShellFromWire(event.data.info)
      return shell ? [{ type: "shell.started", properties: { shell } }] : []
    }
    case "shell.exited": {
      const { status } = event.data
      if (status === "running") return []
      const end: ShellEnd = compact({ kind: "exited", status, exit: event.data.exit })
      return [{ type: "shell.ended", properties: { shellID: event.data.id, end, endedAt: event.created } }]
    }
    case "shell.deleted":
      return [{ type: "shell.ended", properties: { shellID: event.data.id, end: { kind: "removed" }, endedAt: event.created } }]

    case "pty.created":
    case "pty.updated":
    case "pty.deleted":
    case "pty.exited":
    case "persistent-pty.added":
    case "persistent-pty.removed":
    case "persistent-pty.updated":
    case "artifact.updated":
      return []
    case "experimental.job.updated": {
      const update = imageJobUpdate(event.data?.info)
      return update ? [{ type: "image.job.updated", properties: update }] : []
    }

    case "tui.command.execute":
    case "tui.prompt.append":
    case "tui.session.select":
    case "tui.toast.show":
      return []

    default: {
      const remaining: `rpc.${string}` | "experimental.push.updated" = event.type
      void remaining
      return []
    }
  }
}

export function routeWireEvent(event: OpenCodeEvent): RoutedSyncEvent[] {
  const directory = eventDirectory(event)
  return translateWireEvent(event).map((translated) => ({ directory, event: translated }))
}

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
