
import type {
  ConfigEntry,
  JsonValue,
  Project as ProjectWire,
  PromptFileAttachment,
  VcsInfo,
  SessionInboxSyntheticPayload,
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
  type Metadata,
  type Part,
  type Project,
  type Session,
  type ToolPart,
  type ToolState,
  type SyntheticMessage,
  type UserMessage,
  type Vcs,
} from "./model"
import { formatModelSelection, parseModelSelection } from "../modelIdentifier"
import { workflowAgentParentId } from "../sessionWorkflowMetadata"
import { operatorChildParentId } from "../sessionOperatorChild"

export type AssistantContentItem = SessionMessageAssistant["content"][number]
export type AssistantToolItem = Extract<AssistantContentItem, { type: "tool" }>


const linkedParentID = (metadata: Session["metadata"]): string | undefined => (
  workflowAgentParentId(metadata) ?? operatorChildParentId(metadata)
)

export const sessionParentID = (record: { parentID?: string; metadata?: Session["metadata"] }): string | undefined => (
  record.parentID ?? linkedParentID(record.metadata)
)

export function withSessionMetadata(session: Session, metadata: Metadata): Session {
  const next: Session = { ...session, metadata }
  if (session.parentID !== linkedParentID(session.metadata)) return next
  const parentID = linkedParentID(metadata)
  if (parentID) next.parentID = parentID
  else delete next.parentID
  return next
}

export function projectSession(info: SessionInfo): Session {
  return compact({
    id: info.id,
    parentID: sessionParentID(info),
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
        errorType: tool.state.error.type,
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


export function projectAssistantContent(
  content: readonly AssistantContentItem[],
  owner: { sessionID: string; messageID: string; created: number; completed?: number },
): Part[] {
  const parts: Part[] = []
  let textOrdinal = 0
  let reasoningOrdinal = 0
  for (const [index, item] of content.entries()) {
    switch (item.type) {
      case "text": {
        const ordinal = textOrdinal
        textOrdinal += 1
        const followed = index < content.length - 1
        parts.push({
          id: partIds.text(owner.messageID, ordinal),
          sessionID: owner.sessionID,
          messageID: owner.messageID,
          type: "text",
          text: item.text,
          time: compact({ start: owner.created, end: owner.completed ?? (followed ? owner.created : undefined) }),
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


function fileAttachmentUrl(file: PromptFileAttachment): string {
  if (file.source.type === "uri") return file.source.uri
  return `data:${file.mime};base64,${file.data}`
}

export type InboxMessageItem =
  | { type: "user"; payload: SessionInboxUserPayload }
  | { type: "synthetic"; payload: SessionInboxSyntheticPayload }
  | { type: "compaction" | "move" }

export function projectInboxMessage(
  item: InboxMessageItem,
  owner: { sessionID: string; messageID: string; created: number },
): { info: UserMessage | SyntheticMessage; parts: Part[] | null } | null {
  if (item.type === "user") {
    return {
      info: compact({
        id: owner.messageID,
        sessionID: owner.sessionID,
        role: "user",
        time: { created: owner.created },
        skills: projectUserSkills(item.payload),
        metadata: item.payload.metadata,
      }),
      parts: projectUserParts(item.payload, owner),
    }
  }
  if (item.type === "synthetic") {
    return {
      info: compact({
        id: owner.messageID,
        sessionID: owner.sessionID,
        role: "synthetic",
        time: { created: owner.created },
        text: item.payload.text,
        description: item.payload.description,
        metadata: item.payload.metadata,
        pending: true,
      }),
      parts: null,
    }
  }
  return null
}

function projectUserSkills(payload: SessionInboxUserPayload): UserMessage["skills"] {
  if (!payload.skills?.length) return undefined
  return payload.skills.map((skill) => ({ id: skill.id, name: skill.name }))
}

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


export type ProjectedMessage = {
  message: Message
  parts: Part[]
}

export function projectMessage(info: SessionMessageInfo, sessionID: string): ProjectedMessage {
  const metadata = info.metadata
  switch (info.type) {
    case "user": {
      const message: UserMessage = compact({ id: info.id, sessionID, role: "user", time: { ...info.time }, skills: projectUserSkills(info), metadata })
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
          model: info.status === "completed" ? info.model : undefined,
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
        message: compact({
          id: info.id,
          sessionID,
          role: "idle",
          time: { ...info.time },
          outcome: info.outcome,
          error: info.error,
          metadata,
        }),
        parts: [],
      }
  }
}

function finiteExit(exit: number | "Infinity" | "-Infinity" | "NaN" | undefined): number | undefined {
  return exit === "Infinity" || exit === "-Infinity" || exit === "NaN" ? undefined : exit
}

export function projectMessages(items: readonly SessionMessageInfo[], sessionID: string): ProjectedMessage[] {
  return items.map((item) => projectMessage(item, sessionID))
}


const isDocument = (entry: ConfigEntry): entry is ConfigDocument => entry.type === "document"

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

function documentPolicies(entry: ConfigDocument) {
  return [...(entry.info.experimental?.policies ?? []), ...(entry.info.policies ?? [])]
}

export function deniesAnyProvider(entries: readonly ConfigEntry[]): boolean {
  return entries.some((entry) => isDocument(entry)
    && documentPolicies(entry).some((policy) => policy.action === "provider.use" && policy.effect === "deny"))
}

export type IntegrationPolicy = { resource: string; effect: "allow" | "deny"; path: string | null }

function integrationResource(policy: { action: string; resource: string }): string | null {
  if (policy.action === "mcp.use") return `mcp:${policy.resource}`
  if (policy.action === "skill.use") return `skill:${policy.resource}`
  if (policy.action === "plugin.use") return `plugin:${policy.resource}`
  if (policy.action === "integration.use" && /^(mcp|skill|plugin):/.test(policy.resource)) return policy.resource
  return null
}

export function readIntegrationPolicies(entries: readonly ConfigEntry[]): IntegrationPolicy[] {
  return entries
    .filter(isDocument)
    .reverse()
    .flatMap((entry) => documentPolicies(entry).flatMap((policy) => {
      const resource = integrationResource(policy)
      return resource === null ? [] : [{ resource, effect: policy.effect, path: entry.path ?? null }]
    }))
}

function matchesWildcard(input: string, pattern: string): boolean {
  let escaped = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")
  if (escaped.endsWith(" .*")) escaped = `${escaped.slice(0, -3)}( .*)?`
  return new RegExp(`^${escaped}$`, "s").test(input.replaceAll("\\", "/"))
}

export function findIntegrationPolicy(policies: readonly IntegrationPolicy[], resource: string): IntegrationPolicy | null {
  for (let index = policies.length - 1; index >= 0; index -= 1) {
    if (matchesWildcard(resource, policies[index].resource)) return policies[index]
  }
  return null
}

export function isIntegrationDenied(policies: readonly IntegrationPolicy[], resource: string): boolean {
  return findIntegrationPolicy(policies, resource)?.effect === "deny"
}

function isPlainRecord(value: Config[keyof Config]): value is Record<string, JsonValue> {
  return Object.prototype.toString.call(value) === "[object Object]"
}

const isStringValue = (value: Config["model"]): value is string =>
  Object.prototype.toString.call(value) === "[object String]"

export function configModelIdentifier(value: Config["model"]): string | undefined {
  if (isStringValue(value)) {
    return formatModelSelection(parseModelSelection(value)) ?? undefined
  }
  if (!value) {
    return undefined
  }
  return formatModelSelection({
    providerID: value.providerID,
    modelID: value.model,
    variant: value.variant,
  }) ?? undefined
}

export const projectAgent = (info: AgentInfo): Agent => ({ ...info, name: info.id, displayName: info.name })
