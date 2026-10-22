/**
 * Turning source records into the export's event model.
 *
 * Two things happen here, and they are kept apart on purpose:
 *
 * - **Normalizing** reads each session's records and produces one event per
 *   part, per stretch of a message and per reported run. The events carry the
 *   source order they were recorded in, so nothing depends on wall-clock time
 *   alone.
 * - **Resolving** joins a subagent call to the child session it started. The
 *   join uses recorded identities only — the call's metadata, its output, the
 *   report the runtime appended, the session's own parent. Position in a list
 *   is never used, because two subagents can start at the same moment and the
 *   export must not guess which is which.
 */

import { z } from 'zod';
import type { JsonValue, Message, Part } from '@/lib/opencode/model';
import { readJsonRecord, readTextField, readTimestamp } from './values';
import { hasParts, type AssistantMessage, type UserMessage } from '@/lib/opencode/model';
import { readContextPart } from '@/lib/messages/contextParts';
import { formatContextMessage, formatMessageText } from '@/lib/messages/messageMarkdown';
import { isSubagentTool, subagentAgent, subagentDescription } from '@/lib/opencode/tools';
import { readSubagentRun } from '@/lib/opencode/subagent-run';
import { readDispatchedSessionResult } from '@/lib/opencode/dispatched-session';
import {
  readBackgroundChildID,
  readInvocationChildSessionID,
} from './childSession';
import type {
  ExportEvent,
  ExportFinding,
  ExportPart,
  ExportRole,
  ExportSessionInfo,
  ExportShellResult,
  ExportTimeline,
  ExportToolCall,
} from './events';
import { SOURCE_ORDER_FIRST_PLACE, sourceOrderOf, sourceOrderWidth } from './events';
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
 * Only a record with parts says something this way. A synthetic message is
 * context the user attached to the next prompt or plumbing a server plugin
 * injected, and it carries no parts: such a record is read with the records
 * that carry their text in the record itself.
 */
const messageText = (message: UserMessage | AssistantMessage, parts: readonly Part[]): string => (
  formatMessageText(parts, { user: message.role === 'user' })
);

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

/**
 * The shell record's own result, when the record is one.
 *
 * A shell record carries what the command printed, how it ended and the code
 * it exited with. Keeping them lets the readable view say that a command
 * failed instead of showing only the command.
 */
const shellResultOf = (message: Message): ExportShellResult | undefined => {
  if (message.role !== 'shell') return undefined;
  const shell: ExportShellResult = { status: message.status };
  if (message.exit !== undefined) shell.exit = message.exit;
  const output = message.output?.output;
  if (output) shell.output = output;
  return shell;
};

/**
 * One stretch of a record's parts: the message the record said in it.
 */
type MessageSegment = {
  /** The parts of the stretch, in the order the source recorded them. */
  parts: Part[];
  /**
   * The place of the stretch in the record: the place of its first part.
   *
   * The parts are numbered the way the record holds them, so a stretch and
   * the tool call next to it share one scale.
   */
  position: number;
  /** The time the stretch's last text part recorded, when it recorded one. */
  timestamp?: number;
};

/**
 * The record's parts, split into the stretches the export shows as messages.
 *
 * A part that has an event of its own — a tool call, a reasoning — is that
 * event, and it ends the stretch before it. The parts between two such parts
 * are the message the record said in that stretch: its text parts are glued
 * into one text, the way the readable view shows a message, and the files it
 * carried are its attachments.
 *
 * Every event of a record therefore sits at the place of the part it came
 * from, and the text the source wrote before a tool call stays before it. A
 * message glued across a tool call would move that text past the call, and
 * the source's order would be a claim the export cannot back.
 */
const messageSegments = (parts: readonly Part[]): MessageSegment[] => {
  const segments: MessageSegment[] = [];
  let current: Part[] = [];
  let position = 0;
  let timestamp: number | undefined;

  const close = () => {
    if (current.length === 0) return;
    segments.push({ parts: current, position, timestamp });
    current = [];
    timestamp = undefined;
  };

  for (const [index, part] of parts.entries()) {
    if (part.type === 'tool' || part.type === 'reasoning') {
      close();
      continue;
    }
    if (current.length === 0) position = index + 1;
    current.push(part);
    // The stretch is placed by the time its last text part recorded: an
    // answer that came after the work that produced it stays after that
    // work.
    if (part.type === 'text') timestamp = readTimestamp(part.time?.start);
  }
  close();

  return segments;
};

/** The tool call a part carries, as the export sees it. */
const exportToolCall = (
  part: Extract<Part, { type: 'tool' }>,
): ExportToolCall => {
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
    // A call that went to the background settles at once while its child
    // keeps running. The call's own span says nothing about when the work
    // was done, so the export reads the child's own activity instead.
    if (readBackgroundChildID(part)) call.background = true;
  }

  return call;
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
  /**
   * Whether the export covers the sub-agent sessions at all.
   *
   * A caller that asked for the root session only does not report the
   * children it left out: they were excluded on purpose, not lost.
   */
  includeSubagents?: boolean;
}): NormalizeResult => {
  const { rootSessionID, sessions, missing, findings } = options;
  const includeSubagents = options.includeSubagents ?? true;

  const sessionsById = new Map<string, ExportSessionInfo>();
  const sourceRecords = new Map<string, ExportSourceSessionOfTimeline>();
  const events: ExportEvent[] = [];
  const localFindings: ExportFinding[] = [];

  /** The child session a call started, and the call that started it. */
  const invocationByChildID = new Map<string, { sessionID: string; partID: string; description?: string; agent?: string; timestamp?: number }>();
  /**
   * The child sessions a report named.
   *
   * A report is a recorded identity, like a call: it says which session the
   * work happened in. A child the parent names only by a report is still a
   * child the export read and shows, so the relationship is established even
   * though no call is there to establish it.
   */
  const childIDsByReport = new Set<string>();

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
    localFindings.push({
      kind: 'missing-session',
      sessionID: session.id,
      childSessionID: session.id,
      messageKey: 'export.finding.missingSession',
      messageParams: { title: session.title },
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
      messageKey: 'export.finding.missingSession',
      messageParams: { title: session.title },
    });
  }

  // First pass: the calls, so a child session knows which invocation started
  // it before its own events are read.
  //
  // The join is by recorded identity. A call names the child session it
  // started; a child the caller knows only by its description carries the id
  // of the call that recorded that description, and the join uses it.
  const invocationByCallID = new Map<string, { childSessionID: string; sessionID: string; partID: string; description?: string; agent?: string; timestamp?: number }>();
  /** The calls that named a child, whether the child was found or not. */
  const invocationsByCall = new Map<string, {
    childSessionID: string;
    sessionID: string;
    partID: string;
    callID: string;
    settled: boolean;
  }>();
  for (const collected of sessions) {
    for (const record of collected.records) {
      for (const part of record.parts) {
        if (part.type !== 'tool' || !isSubagentTool(part.tool)) continue;
        const childSessionID = readInvocationChildSessionID(part) ?? readBackgroundChildID(part);
        if (!childSessionID) {
          // A settled call that named no child at all: the export cannot
          // say which transcript, if any, belongs to it. The call is still
          // shown, and the export says the relationship is unresolved.
          const settled = part.state.status === 'completed' || part.state.status === 'error';
          if (!settled || !includeSubagents) continue;
          localFindings.push({
            kind: 'unresolved-invocation',
            sessionID: collected.sessionID,
            messageKey: 'export.finding.unnamedInvocation',
            messageParams: { id: part.callID },
          });
          continue;
        }
        if (invocationByChildID.has(childSessionID)) {
          // Two calls named the same child, so its transcript appears once.
          // A caller that left the transcripts out on purpose has no
          // transcript to keep, and nothing to report about it.
          if (includeSubagents) {
            localFindings.push({
              kind: 'resumed-session',
              sessionID: collected.sessionID,
              childSessionID,
              messageKey: 'export.finding.resumedSession',
              messageParams: { id: childSessionID },
            });
          }
          continue;
        }
        // A call names a child the export does not cover: the session is not
        // in the list, and no records were loaded for it. The call is still
        // shown, and the export says its transcript is missing — unless the
        // caller left the sub-agent sessions out on purpose.
        if (includeSubagents && !sessionsById.has(childSessionID) && !missingSessionIDs.has(childSessionID)) {
          localFindings.push({
            kind: 'ambiguous-invocation',
            sessionID: collected.sessionID,
            childSessionID,
            messageKey: 'export.finding.ambiguousInvocation',
            messageParams: { id: childSessionID },
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
        invocationsByCall.set(part.callID, {
          childSessionID,
          sessionID: collected.sessionID,
          partID: part.id,
          callID: part.callID,
          // A call that has not settled yet names a child that may still be
          // running. Its transcript is not missing; it is not there yet.
          settled: part.state.status === 'completed' || part.state.status === 'error',
        });
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

    // The place of the next record in this session's source order. Every
    // record takes a place of its own, as wide as the record needs, so the
    // parts of one record can never push the records after it out of order.
    let recordPlace = SOURCE_ORDER_FIRST_PLACE;
    for (const record of collected.records) {
      const message = record.info;
      const place = recordPlace;
      recordPlace += sourceOrderWidth(record.parts.length);
      const role = roleOf(message);
      const { model, variant } = modelOf(message);
      const base = {
        origin: { sessionID: collected.sessionID, messageID: message.id, partID: message.id, sourceOrder: sourceOrderOf(place, 0) },
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
          messageKey: 'export.finding.unsupportedMessageRole',
          messageParams: { role: message.role },
        });
        continue;
      }

      // A record without a recorded time cannot be placed in the timeline by
      // time. It keeps the place the source gave it, and the export says so
      // once — for every role, not only for the ones that carry parts.
      const reportMissingTimestamp = (timestamp: number | undefined) => {
        if (timestamp !== undefined || reportedMissingTimestamp) return;
        reportedMissingTimestamp = true;
        localFindings.push({
          kind: 'missing-timestamp',
          sessionID: collected.sessionID,
          messageKey: 'export.finding.missingTimestamp',
        });
      };
      reportMissingTimestamp(base.timestamp);

      const run = readSubagentRun(message);
      if (run) {
        // The completion report carries the time the report arrived, so that
        // is the time the event is placed by.
        const reportedAt = readTimestamp(run.reportedAt);
        reportMissingTimestamp(reportedAt);
        childIDsByReport.add(run.childSessionID);
        events.push({
          ...base,
          id: `${collected.sessionID}:${message.id}:run`,
          kind: 'subagent-result',
          childSessionID: run.childSessionID,
          state: run.state,
          description: run.description,
          output: run.output,
          timestamp: reportedAt,
        });
        continue;
      }

      const dispatched = readDispatchedSessionResult(message);
      if (dispatched) {
        const reportedAt = readTimestamp(dispatched.reportedAt);
        reportMissingTimestamp(reportedAt);
        childIDsByReport.add(dispatched.sessionID);
        events.push({
          ...base,
          id: `${collected.sessionID}:${message.id}:dispatched`,
          kind: 'subagent-result',
          childSessionID: dispatched.sessionID,
          state: dispatched.state,
          description: dispatched.title,
          output: dispatched.output,
          timestamp: reportedAt,
        });
        continue;
      }

      if (hasParts(message)) {
        // The record's parts become events at the places they held inside
        // it. A tool call and a reasoning part are events of their own, and
        // the parts between them are the message the record said in that
        // stretch. The stretch sits at its first part, so the text the
        // source wrote before a tool call stays before it.
        for (const segment of messageSegments(record.parts)) {
          const text = messageText(message, segment.parts);
          const attachments = segment.parts
            .filter((part): part is Extract<Part, { type: 'file' }> => part.type === 'file')
            .map((part) => ({ filename: part.filename, mime: part.mime, url: part.url }));
          if (!text && attachments.length === 0) continue;
          events.push({
            ...base,
            id: `${collected.sessionID}:${message.id}:message:${segment.position}`,
            origin: {
              ...base.origin,
              sourceOrder: sourceOrderOf(place, segment.position),
            },
            kind: 'message',
            role,
            text,
            attachments: attachments.length > 0 ? attachments : undefined,
            parts: exportParts(segment.parts),
            timestamp: segment.timestamp ?? base.timestamp,
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
            messageKey: 'export.finding.unsupportedPart',
            messageParams: { partType },
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
              origin: { ...base.origin, partID: part.id, sourceOrder: sourceOrderOf(place, partOrder) },
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
              origin: { ...base.origin, partID: part.id, sourceOrder: sourceOrderOf(place, partOrder) },
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
      const shell = shellResultOf(message);
      if (plainText.trim() || shell) {
        events.push({
          ...base,
          id: `${collected.sessionID}:${message.id}:message`,
          kind: 'message',
          role,
          text: plainText.trim(),
          shell,
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
    // The parent's own report named this child, so the history does establish
    // the relationship: the child is shown, and there is nothing to report.
    if (childIDsByReport.has(collected.sessionID)) continue;
    localFindings.push({
      kind: 'unresolved-invocation',
      sessionID: collected.sessionID,
      childSessionID: collected.sessionID,
      messageKey: 'export.finding.unresolvedInvocation',
      messageParams: { title: collected.title },
    });
  }

  // A settled call whose child the export could not tie to any transcript is
  // a relationship the export could not establish. A call that is still
  // running names a child that is not there yet, which is not a gap.
  for (const invocation of invocationsByCall.values()) {
    if (!invocation.settled) continue;
    if (sessionsById.has(invocation.childSessionID)) continue;
    if (missingSessionIDs.has(invocation.childSessionID)) continue;
    if (!includeSubagents) continue;
    localFindings.push({
      kind: 'unresolved-invocation',
      sessionID: invocation.sessionID,
      childSessionID: invocation.childSessionID,
      messageKey: 'export.finding.unresolvedInvocation',
      messageParams: { title: invocation.childSessionID },
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
