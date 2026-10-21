/**
 * Turning source records into the export's event model.
 *
 * Two things happen here, and they are kept apart on purpose:
 *
 * - **Normalizing** reads each session's records and produces one event per
 *   message, part and reported run. The events carry the source order they
 *   were recorded in, so nothing depends on wall-clock time alone.
 * - **Resolving** joins a subagent call to the child session it started. The
 *   join uses recorded identities only — the call's metadata, its output, the
 *   report the runtime appended, the session's own parent. Position in a list
 *   is never used, because two subagents can start at the same moment and the
 *   export must not guess which is which.
 */

import { z } from 'zod';
import type { JsonValue, Message, Part } from '@/lib/opencode/model';
import { readJsonRecord, readTextField, readTimestamp } from './values';
import { hasParts } from '@/lib/opencode/model';
import { readContextPart } from '@/lib/messages/contextParts';
import { formatContextMessage, formatMessageText } from '@/lib/messages/messageMarkdown';
import {
  isSubagentTool,
  subagentAgent,
  subagentDescription,
  subagentSessionId,
} from '@/lib/opencode/tools';
import { readSubagentRun, readBackgroundSubagentChildID } from '@/lib/opencode/subagent-run';
import { readDispatchedSessionResult } from '@/lib/opencode/dispatched-session';
import { readTaskSessionIdFromOutput, readTaskSessionIdFromRecord } from '@/components/chat/message/parts/taskToolModel';
import type {
  ExportEvent,
  ExportFinding,
  ExportPart,
  ExportRole,
  ExportSessionInfo,
  ExportTimeline,
  ExportToolCall,
} from './events';
import type { CollectedSession, MissingSession } from './collect';

/** The message roles the export knows how to present. */
/**
 * The text of a message that carries its text in the record itself.
 *
 * Every role that says something in the record says it here, so a compaction
 * carries its summary, a shell record its command, and a notice what it
 * reported. A role with nothing to say carries nothing.
 */
const messageTextOf = (message: Message): string => {
  switch (message.role) {
    case 'system':
    case 'skill':
    case 'synthetic':
      return message.text;
    case 'compaction':
      return message.summary;
    case 'shell':
      return message.command;
    case 'agent-switched':
      return message.agent;
    case 'model-switched':
      return `${message.model.providerID}/${message.model.id}`;
    case 'location-switched':
      return message.directory;
    case 'idle':
      return message.error
        ? `${message.outcome}: ${message.error.message}`
        : message.outcome;
    default:
      return '';
  }
};

/** The model an assistant message ran with, and the level it ran at. */
type ModelIdentity = {
  /** The model, with the thinking level when the user picked one. */
  model?: string;
  /** The thinking level, when the user picked one. */
  variant?: string;
};

const KNOWN_ROLES = new Set<ExportRole>([
  'user',
  'assistant',
  'context',
  'system',
  'skill',
  'shell',
  'compaction',
  'agent-switched',
  'model-switched',
  'location-switched',
  'idle',
]);

/**
 * The role a message carries, in the export's own vocabulary.
 *
 * The model's role union is closed, so a role the export does not know is
 * unreachable for the type checker. It is still handled: the runtime may
 * write a role the model does not name yet, and a message that disappears is
 * a message the reader can no longer account for.
 */
const roleOf = (message: Message): ExportRole | undefined => {
  switch (message.role) {
    case 'user':
    case 'assistant':
    case 'system':
    case 'skill':
    case 'shell':
    case 'compaction':
    case 'agent-switched':
    case 'model-switched':
    case 'location-switched':
    case 'idle':
      return message.role;
    case 'synthetic':
      return 'context';
    default:
      return undefined;
  }
};

/** The text of a value, when it holds text. */
const asText = (value: JsonValue | undefined): string | undefined => readTextField(value);

/**
 * The model and thinking level an assistant message ran with.
 *
 * OpenCode records `default` when no level was picked; like the chat footer,
 * the export names only a level the user chose.
 */
const modelOf = (message: Message): ModelIdentity => {
  if (message.role !== 'assistant') return {};
  const providerID = message.providerID.trim();
  const modelID = message.modelID.trim();
  const model = providerID && modelID ? `${providerID}/${modelID}` : (modelID || providerID);
  if (!model) return {};

  const variant = message.variant?.trim();
  if (!variant || ['default', 'none'].includes(variant.toLowerCase())) {
    return { model };
  }
  return { model: `${model}, thinking: ${variant}`, variant };
};

/**
 * The text of a message, in the form the export shows it.
 *
 * A synthetic message is either context the user attached to the next prompt
 * or plumbing a server plugin injected. Plumbing is not something the user
 * wrote or the agent said, so it stays out of the transcript entirely.
 */
const messageText = (message: Message, parts: readonly Part[]): string => {
  if (message.role === 'synthetic') {
    if (!readContextPart(message)) return '';
    return formatContextMessage(message).trim();
  }
  if (!hasParts(message)) return '';
  return formatMessageText(parts, { user: message.role === 'user' });
};

/**
 * The type a part carries, as the record wrote it.
 *
 * A part type is a name. A record that does not carry one is reported as
 * unknown rather than dropped.
 */
const partTypeSchema = z.string().min(1);

/**
 * Whether the export's model covers a part.
 *
 * A part it does not cover is still carried, as an unknown part with its type
 * named, and reported once.
 */
const isKnownPart = (part: Part): boolean => (
  part.type === 'text'
  || part.type === 'file'
  || part.type === 'agent'
  || part.type === 'reasoning'
  || part.type === 'tool'
);

/**
 * The parts of a message, as the export carries them.
 *
 * A part the model does not cover is carried as an `unknown` part with its
 * type named, so the export never loses a part it did not understand. The
 * JSON export keeps the untouched part in `source` as well.
 *
 * The model's part union is closed, so the unknown branch is unreachable for
 * the type checker. It is still written: the runtime may hand the export a
 * part type the model does not name yet, and a part that vanishes is a part
 * the reader can no longer account for.
 */
const exportParts = (parts: readonly Part[]): ExportPart[] => parts.map((part): ExportPart => {
  switch (part.type) {
    case 'text':
      return { type: 'text', id: part.id, text: part.text, metadata: part.metadata };
    case 'file':
      return { type: 'file', id: part.id, filename: part.filename, mime: part.mime, url: part.url };
    case 'agent':
      return { type: 'agent', id: part.id, name: part.name };
    case 'reasoning':
      return { type: 'reasoning', id: part.id, text: part.text };
    case 'tool':
      return { type: 'tool', id: part.id, callID: part.callID, tool: part.tool, state: part.state.status };
    default:
      return unknownPart(part);
  }
});

/**
 * A part the model does not cover, as the export carries it.
 *
 * The part's own type is read from the record rather than from the type
 * checker, because the type checker only knows the part types the model
 * names today. The read is a parse, not a guess: a field that does not hold
 * a type name is reported as unknown.
 */
const unknownPart = (part: Part): ExportPart => ({
  type: 'unknown',
  id: part.id,
  partType: readPartType(part),
});

/** The type a part carries, as the record wrote it. */
const readPartType = (part: Part): string => partTypeSchema.safeParse(part.type).success
  ? part.type
  : 'unknown';

/** The tool call a part carries, as the export sees it. */
const exportToolCall = (part: Extract<Part, { type: 'tool' }>): ExportToolCall => {
  const state = part.state;
  const call: ExportToolCall = {
    name: part.tool,
    callID: part.callID,
    input: readJsonRecord(state.input),
    status: state.status,
  };

  const metadata = 'metadata' in state ? readJsonRecord(state.metadata) : undefined;
  if (metadata) call.metadata = metadata;


  if (state.status === 'completed') {
    call.output = state.output;
    call.startedAt = state.time.start;
    call.endedAt = state.time.end;
  } else if (state.status === 'error') {
    call.output = state.output;
    call.error = state.error;
    call.startedAt = state.time.start;
    call.endedAt = state.time.end;
  } else if (state.status === 'running') {
    call.startedAt = state.time.start;
  }

  if (isSubagentTool(part.tool)) {
    call.agent = subagentAgent(state.input);
    call.description = subagentDescription(state.input);
    const prompt = asText(readJsonRecord(state.input).prompt);
    if (prompt) call.prompt = prompt;
  }

  return call;
};

/**
 * The child session a subagent call started, from every identity the runtime
 * recorded for it. The order matters: the call's own metadata is the
 * authoritative join, the output envelope is the older fallback, and the
 * session's parent link is the last resort.
 */
const readInvocationChildSessionID = (part: Extract<Part, { type: 'tool' }>): string | undefined => {
  if (!isSubagentTool(part.tool)) return undefined;
  const state = part.state;
  if (state.status === 'pending') return undefined;

  const metadata = 'metadata' in state ? state.metadata : undefined;
  const fromMetadata = subagentSessionId(metadata);
  if (fromMetadata) return fromMetadata;

  const fromRecord = readTaskSessionIdFromRecord(metadata);
  if (fromRecord) return fromRecord;

  if (state.status === 'completed') {
    const fromOutput = readTaskSessionIdFromOutput(state.output);
    if (fromOutput) return fromOutput;
  }

  const fromInput = readTaskSessionIdFromRecord(state.input);
  if (fromInput) return fromInput;

  return undefined;
};

/**
 * The child session a background subagent call left running. The call settles
 * at once with the child in its metadata; the report arrives later.
 */
const readBackgroundChildID = (part: Extract<Part, { type: 'tool' }>): string | undefined => {
  const background = readBackgroundSubagentChildID(part);
  if (background) return background;
  if (part.state.status === 'completed' && isSubagentTool(part.tool)) {
    const metadata = readJsonRecord(part.state.metadata);
    if (metadata?.status === 'running') {
      const sessionID = asText(metadata.sessionID);
      if (sessionID) return sessionID;
    }
  }
  return undefined;
};

type NormalizeResult = {
  timeline: ExportTimeline;
};

/**
 * Builds the export's timeline from the collected sessions.
 *
 * The root session's records come first, then the descendants. Every event
 * keeps the source order it was recorded in, so the ordering step can use
 * timestamps where they exist and fall back to the source order where they do
 * not.
 *
 * A descendant whose history could not be loaded becomes a gap event and a
 * finding: the export says the sub-agent is missing instead of leaving a
 * hole that reads as a complete history.
 */
export const normalizeExportTimeline = (options: {
  rootSessionID: string;
  sessions: CollectedSession[];
  missing: MissingSession[];
  findings: ExportFinding[];
}): NormalizeResult => {
  const { rootSessionID, sessions, missing, findings } = options;

  const sessionsById = new Map<string, ExportSessionInfo>();
  const sourceRecords = new Map<string, ExportSourceSessionOfTimeline>();
  const events: ExportEvent[] = [];
  const localFindings: ExportFinding[] = [];

  /** The child session a call started, and the call that started it. */
  const invocationByChildID = new Map<string, { sessionID: string; partID: string; description?: string; agent?: string; timestamp?: number }>();
  /** The child sessions a session's calls started, in the order they were recorded. */
  const invocationsBySessionID = new Map<string, string[]>();

  for (const collected of sessions) {
    const info: ExportSessionInfo = {
      id: collected.sessionID,
      title: collected.title,
      agent: collected.agent,
      parentID: collected.parentID,
      createdAt: collected.createdAt,
      origin: collected.depth === 0 ? 'root' : 'subagent',
    };
    sessionsById.set(collected.sessionID, info);
    sourceRecords.set(collected.sessionID, {
      sessionID: collected.sessionID,
      title: collected.title,
      agent: collected.agent,
      parentID: collected.parentID,
      records: collected.records,
    });
  }

  // A descendant whose history could not be loaded is a hole in the history,
  // not a detail the reader may skip. The session is still named, so the
  // reader knows what is missing, and the gap sits where the sub-agent's own
  // events would have sat.
  const missingSessionIDs = new Set(missing.map((entry) => entry.session.id));
  /** The part types the export has already reported as unknown. */
  const reportedPartTypes = new Set<string>();
  /** Whether the export has already reported a record without a timestamp. */
  let reportedMissingTimestamp = false;
  for (const { session, depth } of missing) {
    const detail = `The history of the sub-agent session "${session.title}" could not be loaded.`;
    localFindings.push({
      kind: 'missing-session',
      sessionID: session.id,
      childSessionID: session.id,
      detail,
    });
    sessionsById.set(session.id, {
      id: session.id,
      title: session.title,
      agent: session.agent,
      parentID: session.parentID,
      createdAt: session.createdAt,
      origin: 'subagent',
    });
    events.push({
      id: `${session.id}:gap`,
      origin: { sessionID: session.id, messageID: session.id, partID: session.id, sourceOrder: 0 },
      timestamp: session.createdAt,
      sessionID: session.id,
      depth,
      kind: 'gap',
      childSessionID: session.id,
      reason: 'unavailable',
      detail,
    });
  }

  // First pass: the calls, so a child session knows which invocation started
  // it before its own events are read.
  //
  // The join is by recorded identity. A call names the child session it
  // started; a child the caller knows only by its description carries the id
  // of the call that recorded that description, and the join uses it.
  const invocationByCallID = new Map<string, { childSessionID: string; sessionID: string; partID: string; description?: string; agent?: string; timestamp?: number }>();
  for (const collected of sessions) {
    let order = 0;
    for (const record of collected.records) {
      order += 1;
      for (const part of record.parts) {
        if (part.type !== 'tool' || !isSubagentTool(part.tool)) continue;
        const childSessionID = readInvocationChildSessionID(part) ?? readBackgroundChildID(part);
        if (!childSessionID) continue;
        if (invocationByChildID.has(childSessionID)) {
          localFindings.push({
            kind: 'resumed-session',
            sessionID: collected.sessionID,
            childSessionID,
            detail: `More than one call names the sub-agent session "${childSessionID}"; the export keeps one transcript for it.`,
          });
          continue;
        }
        // A call names a child the export does not cover: the session is not
        // in the list, and no records were loaded for it. The call is still
        // shown, and the export says its transcript is missing.
        if (!sessionsById.has(childSessionID) && !missingSessionIDs.has(childSessionID)) {
          localFindings.push({
            kind: 'ambiguous-invocation',
            sessionID: collected.sessionID,
            childSessionID,
            detail: `A call names the sub-agent session "${childSessionID}", which is not among the exported sessions; its transcript is not part of this export.`,
          });
        }
        const call = exportToolCall(part);
        invocationByChildID.set(childSessionID, {
          sessionID: collected.sessionID,
          partID: part.id,
          description: call.description,
          agent: call.agent,
          timestamp: call.startedAt,
        });
        invocationByCallID.set(part.callID, {
          childSessionID,
          sessionID: collected.sessionID,
          partID: part.id,
          description: call.description,
          agent: call.agent,
          timestamp: call.startedAt,
        });
        const invocations = invocationsBySessionID.get(collected.sessionID) ?? [];
        invocations.push(childSessionID);
        invocationsBySessionID.set(collected.sessionID, invocations);
      }
    }
  }

  // A child the caller knows only by its description has no session id of
  // its own. The call that recorded the description is the one that started
  // it, so the child's invocation is the one the call carries.
  for (const collected of sessions) {
    const callID = collected.invocationKey;
    if (!callID) continue;
    const invocation = invocationByCallID.get(callID);
    if (!invocation) continue;
    invocationByChildID.set(collected.sessionID, {
      sessionID: invocation.sessionID,
      partID: invocation.partID,
      description: invocation.description,
      agent: invocation.agent,
      timestamp: invocation.timestamp,
    });
  }
  // Second pass: the events.
  for (const collected of sessions) {
    const depth = collected.depth;
    const invocation = invocationByChildID.get(collected.sessionID);
    if (invocation) {
      const info = sessionsById.get(collected.sessionID);
      if (info) {
        info.invokedAs = invocation.agent;
        info.invokedDescription = invocation.description;
      }
    }

    let order = 0;
    for (const record of collected.records) {
      order += 1;
      const message = record.info;
      const role = roleOf(message);
      const { model, variant } = modelOf(message);
      const base = {
        origin: { sessionID: collected.sessionID, messageID: message.id, partID: message.id, sourceOrder: order },
        timestamp: readTimestamp(message.time?.created),
        sessionID: collected.sessionID,
        depth,
        agent: message.role === 'assistant' ? message.agent : undefined,
        model,
        variant,
      };

      if (role === undefined || !KNOWN_ROLES.has(role)) {
        localFindings.push({
          kind: 'unsupported-message-role',
          sessionID: collected.sessionID,
          detail: `A message with the role "${message.role}" is not represented in the export.`,
        });
        continue;
      }

      const run = readSubagentRun(message);
      if (run) {
        events.push({
          ...base,
          id: `${collected.sessionID}:${message.id}:run`,
          kind: 'subagent-result',
          childSessionID: run.childSessionID,
          state: run.state,
          description: run.description,
          output: run.output,
          timestamp: run.reportedAt,
        });
        continue;
      }

      const dispatched = readDispatchedSessionResult(message);
      if (dispatched) {
        events.push({
          ...base,
          id: `${collected.sessionID}:${message.id}:dispatched`,
          kind: 'subagent-result',
          childSessionID: dispatched.sessionID,
          state: dispatched.state,
          description: dispatched.title,
          output: dispatched.output,
          timestamp: dispatched.reportedAt,
        });
        continue;
      }

      if (hasParts(message)) {
        const text = messageText(message, record.parts);
        const attachments = record.parts
          .filter((part): part is Extract<Part, { type: 'file' }> => part.type === 'file')
          .map((part) => ({ filename: part.filename, mime: part.mime, url: part.url }));

        if (text || attachments.length > 0) {
          events.push({
            ...base,
            id: `${collected.sessionID}:${message.id}:message`,
            kind: 'message',
            role,
            text,
            attachments: attachments.length > 0 ? attachments : undefined,
            parts: exportParts(record.parts),
          });
        }

        // A part the model does not cover is carried in the event model as an
        // unknown part, and reported once per part type. The part itself is
        // in `source`.
        for (const part of record.parts) {
          if (isKnownPart(part)) continue;
          const partType = readPartType(part);
          if (reportedPartTypes.has(partType)) continue;
          reportedPartTypes.add(partType);
          localFindings.push({
            kind: 'unsupported-part',
            sessionID: collected.sessionID,
            detail: `A part of type "${partType}" is not represented in the readable export; it is kept in the JSON export.`,
          });
        }

        // A message without a recorded time cannot be placed in the timeline
        // by time. It keeps the place the source gave it, and the export says
        // so once.
        if (base.timestamp === undefined && !reportedMissingTimestamp) {
          reportedMissingTimestamp = true;
          localFindings.push({
            kind: 'missing-timestamp',
            sessionID: collected.sessionID,
            detail: 'Some records carry no timestamp; they keep the order the source recorded them in.',
          });
        }

        let partOrder = 0;
        for (const part of record.parts) {
          partOrder += 1;
          if (part.type === 'tool') {
            const call = exportToolCall(part);
            const childSessionID = readInvocationChildSessionID(part) ?? readBackgroundChildID(part);
            if (childSessionID) call.childSessionID = childSessionID;
            events.push({
              ...base,
              id: `${collected.sessionID}:${part.id}:tool`,
              origin: { ...base.origin, partID: part.id, sourceOrder: order * 1000 + partOrder },
              kind: 'tool',
              call,
              timestamp: call.startedAt ?? base.timestamp,
            });
            continue;
          }
          if (part.type === 'reasoning') {
            events.push({
              ...base,
              id: `${collected.sessionID}:${part.id}:reasoning`,
              origin: { ...base.origin, partID: part.id, sourceOrder: order * 1000 + partOrder },
              kind: 'reasoning',
              text: part.text,
              timestamp: part.time?.start ?? base.timestamp,
            });
            continue;
          }
          if (part.type === 'text' && part.metadata) {
            // A text part with metadata is a context attachment; the message
            // above already carries its readable form.
            continue;
          }
        }
        continue;
      }

      // A message without parts carries its text in the record itself. A
      // synthetic message is context the user attached to the next prompt
      // when it carries a context part, and prompt plumbing otherwise; the
      // plumbing is not something the user wrote or the agent said, so it
      // stays out of the transcript.
      const plainText = message.role === 'synthetic'
        ? (readContextPart(message) ? formatContextMessage(message).trim() : '')
        : messageTextOf(message);
      if (plainText.trim()) {
        events.push({
          ...base,
          id: `${collected.sessionID}:${message.id}:message`,
          kind: 'message',
          role,
          text: plainText.trim(),
          parts: [],
        });
      }
    }
  }

  // A call that named no child, while a child session names this session as
  // its parent, is a relationship the export cannot establish from the call
  // itself. The child is still shown; the ambiguity is reported once.
  for (const collected of sessions) {
    if (collected.depth === 0) continue;
    if (invocationByChildID.has(collected.sessionID)) continue;
    localFindings.push({
      kind: 'unresolved-invocation',
      sessionID: collected.sessionID,
      childSessionID: collected.sessionID,
      detail: `The sub-agent session "${collected.title}" was not tied to a call in the exported history.`,
    });
  }

  return {
    timeline: {
      rootSessionID,
      sessions: sessionsById,
      events,
      findings: [...findings, ...localFindings],
      sourceRecords,
    },
  };
};

/** The source records of one session, as the timeline carries them. */
type ExportSourceSessionOfTimeline = {
  sessionID: string;
  title: string;
  agent?: string;
  parentID?: string;
  records: Array<{ info: Message; parts: Part[] }>;
};
