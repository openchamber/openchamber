/**
 * Projection of OpenCode v2 wire shapes into the OpenChamber domain model.
 *
 * Two consumers share this module: the client wrapper (projected pages of
 * sessions and messages) and the event reducer (one event at a time). Both
 * must produce identical parts for the same message, which is why every part
 * id and every tool-state conversion lives here and nowhere else.
 */

import type {
  ConfigEntry,
  JsonValue,
  Project as ProjectWire,
  PromptFileAttachment,
  VcsInfo,
  SessionInboxUserPayload,
  SessionInfo,
  SessionMessageAssistant,
  SessionMessageInfo,
  SessionStructuredError,
  ToolContent,
  AgentInfo,
} from "@opencode/client"
import {
  compact,
  partIds,
  type Agent,
  type AssistantMessage,
  type Config,
  type ConfigDocument,
  type FilePart,
  type Message,
  type Part,
  type Project,
  type Session,
  type ToolPart,
  type ToolState,
  type UserMessage,
  type Vcs,
} from "./model"

/** One item of an assistant message's ordered content. */
export type AssistantContentItem = SessionMessageAssistant["content"][number]
export type AssistantToolItem = Extract<AssistantContentItem, { type: "tool" }>

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export function projectSession(info: SessionInfo): Session {
  return compact({
    id: info.id,
    parentID: info.parentID,
    projectID: info.projectID,
    directory: info.location.directory,
    subpath: info.subpath,
    title: info.title ?? "",
    agent: info.agent,
    model: info.model,
    cost: info.cost,
    tokens: info.tokens,
    outcome: info.outcome,
    time: compact({ ...info.time }),
    metadata: info.metadata,
    permissions: info.permissions,
    revert: info.revert,
    fork: info.fork,
  })
}

export function projectProject(info: ProjectWire): Project {
  return compact({
    id: info.id,
    worktree: info.canonical,
    vcs: info.vcs,
    name: info.name,
    icon: info.icon,
    commands: info.commands,
    time: info.time,
    sandboxes: [...info.sandboxes],
  })
}

export function projectVcs(info: VcsInfo): Vcs {
  return compact({ branch: info.branch.current, defaultBranch: info.branch.default })
}

// ---------------------------------------------------------------------------
// Tool state
// ---------------------------------------------------------------------------

export function toolOutputText(content: readonly ToolContent[] | undefined): string {
  if (!content || content.length === 0) return ""
  return content
    .filter((item): item is Extract<ToolContent, { type: "text" }> => item.type === "text")
    .map((item) => item.text)
    .join("\n")
}

export function toolAttachments(
  content: readonly ToolContent[] | undefined,
  owner: { sessionID: string; messageID: string; callID: string },
): FilePart[] | undefined {
  if (!content) return undefined
  const files = content.filter((item): item is Extract<ToolContent, { type: "file" }> => item.type === "file")
  if (files.length === 0) return undefined
  return files.map((file, index) =>
    compact<FilePart>({
      id: `${owner.callID}:file:${index}`,
      sessionID: owner.sessionID,
      messageID: owner.messageID,
      type: "file",
      mime: file.mime,
      filename: file.name ?? undefined,
      url: file.uri,
    }),
  )
}

export function structuredErrorText(error: SessionStructuredError): string {
  return error.message || error.type
}

/**
 * Converts one wire tool item into a domain tool part. `time.ran` marks the
 * start of execution; before that the call is still being streamed by the
 * model and has no start time worth showing.
 */
export function projectToolPart(
  tool: AssistantToolItem,
  owner: { sessionID: string; messageID: string },
): ToolPart {
  const start = tool.time.ran ?? tool.time.created
  const end = tool.time.completed ?? start
  const identity = { sessionID: owner.sessionID, messageID: owner.messageID, callID: tool.id }
  let state: ToolState
  switch (tool.state.status) {
    case "streaming":
      state = { status: "pending", input: {}, raw: tool.state.input }
      break
    case "running":
      state = compact({
        status: "running",
        input: tool.state.input,
        metadata: tool.state.metadata,
        time: { start },
      })
      break
    case "completed":
      state = compact({
        status: "completed",
        input: tool.state.input,
        output: toolOutputText(tool.state.content),
        metadata: tool.state.metadata,
        time: { start, end },
        attachments: toolAttachments(tool.state.content, identity),
      })
      break
    case "error":
      state = compact({
        status: "error",
        input: tool.state.input,
        error: structuredErrorText(tool.state.error),
        output: toolOutputText(tool.state.content) || undefined,
        metadata: tool.state.metadata,
        time: { start, end },
      })
      break
  }
  return compact({
    id: partIds.tool(tool.id),
    sessionID: owner.sessionID,
    messageID: owner.messageID,
    type: "tool",
    callID: tool.id,
    tool: tool.name,
    state,
    executed: tool.executed,
  })
}

// ---------------------------------------------------------------------------
// Assistant content
// ---------------------------------------------------------------------------

/**
 * Assistant content is an ordered list of text / reasoning / tool items. Text
 * and reasoning ordinals count per kind in content order, matching the
 * `ordinal` the live stream sends with `session.text.*` and
 * `session.reasoning.*`.
 */
export function projectAssistantContent(
  content: readonly AssistantContentItem[],
  owner: { sessionID: string; messageID: string; created: number; completed?: number },
): Part[] {
  const parts: Part[] = []
  let textOrdinal = 0
  let reasoningOrdinal = 0
  for (const item of content) {
    switch (item.type) {
      case "text": {
        const ordinal = textOrdinal
        textOrdinal += 1
        parts.push({
          id: partIds.text(owner.messageID, ordinal),
          sessionID: owner.sessionID,
          messageID: owner.messageID,
          type: "text",
          text: item.text,
          time: compact({ start: owner.created, end: owner.completed }),
        })
        break
      }
      case "reasoning": {
        const ordinal = reasoningOrdinal
        reasoningOrdinal += 1
        parts.push({
          id: partIds.reasoning(owner.messageID, ordinal),
          sessionID: owner.sessionID,
          messageID: owner.messageID,
          type: "reasoning",
          text: item.text,
          time: compact({ start: item.time?.created ?? owner.created, end: item.time?.completed }),
        })
        break
      }
      case "tool":
        parts.push(projectToolPart(item, owner))
        break
    }
  }
  return parts
}

function projectAssistantMessage(info: SessionMessageAssistant, sessionID: string): AssistantMessage {
  return compact({
    id: info.id,
    sessionID,
    role: "assistant",
    time: compact({ ...info.time }),
    agent: info.agent,
    providerID: info.model.providerID,
    modelID: info.model.id,
    variant: info.model.variant,
    finish: info.finish,
    error: info.error,
    cost: info.cost,
    tokens: info.tokens,
    snapshot: info.snapshot,
    retry: info.retry,
    metadata: info.metadata,
  })
}

// ---------------------------------------------------------------------------
// User prompts
// ---------------------------------------------------------------------------

function fileAttachmentUrl(file: PromptFileAttachment): string {
  if (file.source.type === "uri") return file.source.uri
  return `data:${file.mime};base64,${file.data}`
}

/**
 * A user message on the wire is one text plus attachments. The timeline still
 * renders it as parts (text, files, agent mentions) so the chat components
 * treat both roles alike.
 */
export function projectUserParts(
  payload: SessionInboxUserPayload,
  owner: { sessionID: string; messageID: string; created: number },
): Part[] {
  const parts: Part[] = []
  if (payload.text.length > 0) {
    parts.push({
      id: partIds.userText(owner.messageID),
      sessionID: owner.sessionID,
      messageID: owner.messageID,
      type: "text",
      text: payload.text,
      time: { start: owner.created, end: owner.created },
    })
  }
  payload.files?.forEach((file, index) => {
    parts.push(
      compact<FilePart>({
        id: partIds.userFile(owner.messageID, index),
        sessionID: owner.sessionID,
        messageID: owner.messageID,
        type: "file",
        mime: file.mime,
        filename: file.name,
        url: fileAttachmentUrl(file),
      }),
    )
  })
  payload.agents?.forEach((agent, index) => {
    parts.push({
      id: partIds.userAgent(owner.messageID, index),
      sessionID: owner.sessionID,
      messageID: owner.messageID,
      type: "agent",
      name: agent.name,
    })
  })
  return parts
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export type ProjectedMessage = {
  message: Message
  parts: Part[]
}

export function projectMessage(info: SessionMessageInfo, sessionID: string): ProjectedMessage {
  const metadata = info.metadata
  switch (info.type) {
    case "user": {
      const message: UserMessage = compact({ id: info.id, sessionID, role: "user", time: { ...info.time }, metadata })
      return {
        message,
        parts: projectUserParts(info, { sessionID, messageID: info.id, created: info.time.created }),
      }
    }
    case "assistant":
      return {
        message: projectAssistantMessage(info, sessionID),
        parts: projectAssistantContent(info.content, {
          sessionID,
          messageID: info.id,
          created: info.time.created,
          completed: info.time.completed,
        }),
      }
    case "synthetic":
      return {
        message: compact({
          id: info.id,
          sessionID,
          role: "synthetic",
          time: { ...info.time },
          text: info.text,
          description: info.description,
          metadata,
        }),
        parts: [],
      }
    case "system":
      return {
        message: compact({
          id: info.id,
          sessionID,
          role: "system",
          time: { ...info.time },
          text: info.text,
          description: info.description,
          metadata,
        }),
        parts: [],
      }
    case "skill":
      return {
        message: compact({
          id: info.id,
          sessionID,
          role: "skill",
          time: { ...info.time },
          skill: info.skill,
          name: info.name,
          text: info.text,
          metadata,
        }),
        parts: [],
      }
    case "shell":
      return {
        message: compact({
          id: info.id,
          sessionID,
          role: "shell",
          time: compact({ ...info.time }),
          shellID: info.shellID,
          command: info.command,
          status: info.status,
          exit: finiteExit(info.exit),
          output: info.output,
          metadata,
        }),
        parts: [],
      }
    case "compaction":
      return {
        message: compact({
          id: info.id,
          sessionID,
          role: "compaction",
          time: { ...info.time },
          status: info.status,
          reason: info.reason,
          summary: info.status === "failed" ? "" : info.summary,
          error: info.status === "failed" ? info.error : undefined,
          cost: info.status === "running" ? undefined : info.cost,
          tokens: info.status === "running" ? undefined : info.tokens,
          metadata,
        }),
        parts: [],
      }
    case "agent-switched":
      return {
        message: compact({
          id: info.id,
          sessionID,
          role: "agent-switched",
          time: { ...info.time },
          agent: info.agent,
          previous: info.previous,
          metadata,
        }),
        parts: [],
      }
    case "model-switched":
      return {
        message: compact({
          id: info.id,
          sessionID,
          role: "model-switched",
          time: { ...info.time },
          model: info.model,
          previous: info.previous,
          metadata,
        }),
        parts: [],
      }
    case "location-switched":
      return {
        message: compact({
          id: info.id,
          sessionID,
          role: "location-switched",
          time: { ...info.time },
          directory: info.location.directory,
          previous: info.previous?.location.directory,
          metadata,
        }),
        parts: [],
      }
    case "idle":
      return {
        message: compact({ id: info.id, sessionID, role: "idle", time: { ...info.time }, outcome: info.outcome, metadata }),
        parts: [],
      }
  }
}

/** Shell exit codes travel as JSON-safe numbers; the sentinel strings mean "no finite code". */
function finiteExit(exit: number | "Infinity" | "-Infinity" | "NaN" | undefined): number | undefined {
  return exit === "Infinity" || exit === "-Infinity" || exit === "NaN" ? undefined : exit
}

export function projectMessages(items: readonly SessionMessageInfo[], sessionID: string): ProjectedMessage[] {
  return items.map((item) => projectMessage(item, sessionID))
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const isDocument = (entry: ConfigEntry): entry is ConfigDocument => entry.type === "document"

/**
 * `/api/config` returns every discovered source from lowest to highest
 * priority. The UI wants one effective document: later entries win per key,
 * and record-valued keys (agents, commands, providers, mcp) merge by name so a
 * project file adding one agent does not hide the global ones.
 */
export function mergeConfigDocuments(entries: readonly ConfigEntry[]): Config {
  const merged: Record<string, Config[keyof Config]> = {}
  for (const entry of entries) {
    if (!isDocument(entry)) continue
    for (const [key, value] of Object.entries(entry.info) as Array<[keyof Config, Config[keyof Config]]>) {
      if (value === undefined) continue
      const previous = merged[key]
      merged[key] = isPlainRecord(previous) && isPlainRecord(value) ? { ...previous, ...value } : value
    }
  }
  // SAFETY: every key came from a Config document and kept that key's value
  // type (records of one key only merge with records of the same key).
  return merged as Config
}

function isPlainRecord(value: Config[keyof Config]): value is Record<string, JsonValue> {
  return Object.prototype.toString.call(value) === "[object Object]"
}

/** See `Agent` in `./model`: the wire `name` is display-only; `id` is the key the server expects back. */
export const projectAgent = (info: AgentInfo): Agent => ({ ...info, name: info.id, displayName: info.name })
