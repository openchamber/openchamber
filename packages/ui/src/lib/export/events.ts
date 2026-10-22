/**
 * The normalized event model every session export renders from.
 *
 * A session's history is a set of sessions (the one the user opened and the
 * subagent sessions below it), each a list of messages with ordered parts. The
 * export needs three things the raw records do not give:
 *
 * - A single sequence across sessions, so a subagent's work sits at the point
 *   in the conversation where it happened instead of at the end.
 * - The relationships between a subagent call and the child session it
 *   started, resolved from recorded identities rather than from position.
 * - An honest statement of what could not be resolved, so a partial export
 *   never reads as a complete one.
 *
 * The model keeps both halves: every event points at the source record it came
 * from, so the JSON export can hand back the original data, and the renderers
 * read only the projection fields.
 */

import type { JsonValue, Message, Part } from '@/lib/opencode/model';
import type { I18nKey, I18nParams } from '@/lib/i18n';

/** A session's identity and the labels a reader needs to recognize it. */
export type ExportSessionInfo = {
  id: string;
  title: string;
  agent?: string;
  /** The session this one was started from, when the source recorded it. */
  parentID?: string;
  /** The session's own creation time, used when a child has no other trace. */
  createdAt?: number;
  /** The agent label the invocation named, when the call recorded it. */
  invokedAs?: string;
  /** The call's own description, when the call recorded it. */
  invokedDescription?: string;
  /** How the export reached this session. */
  origin: 'root' | 'subagent';
};

/** Where an event sits in the source material. */
type ExportEventOrigin = {
  sessionID: string;
  messageID: string;
  /** The part's id, or the message id for a message-level event. */
  partID: string;
  /**
   * The position of the source record in the source list, and the position of
   * the part inside it.
   *
   * Both halves are one number, so every kind of event sorts on one scale:
   * the record's place times a thousand, plus the part's place inside it. A
   * message-level event and a tool call of the same record therefore keep the
   * order the source gave them, whichever of the two the record holds first.
   */
  sourceOrder: number;
};

/**
 * The scale one source record occupies in the source order.
 *
 * A record holds a handful of parts, so a thousand is more than any record
 * needs and keeps a part's order inside its own record.
 */
const SOURCE_ORDER_PART_SCALE = 1000;

/**
 * The place of an event in the source order.
 *
 * The scale is one for the whole export: the record's place times the part
 * scale, and the part's place inside the record is added to it. An event
 * that belongs to the record itself, and not to one of its parts, sits at
 * the start of the record's place, so a record without parts and a record
 * with parts keep the order the source gave them.
 */
export const sourceOrderOf = (recordOrder: number, partPosition: number): number =>
  recordOrder * SOURCE_ORDER_PART_SCALE + partPosition;

/** The kind of role a message carries, in the export's own vocabulary. */
export type ExportRole =
  | 'user'
  | 'assistant'
  | 'context'
  | 'system'
  | 'skill'
  | 'shell'
  | 'compaction'
  | 'agent-switched'
  | 'model-switched'
  | 'location-switched'
  | 'idle';

/** A tool call as the export sees it. */
export type ExportToolCall = {
  /** The tool's name as the provider called it. */
  name: string;
  /**
   * The call's own identifier, as the runtime recorded it.
   *
   * It is the join between the derived call and the source part it came
   * from, so a reader can match a call in the document to the record in
   * `source` without guessing.
   */
  callID: string;
  /** The call's arguments, verbatim. */
  input: Record<string, JsonValue>;
  /** The call's result metadata, verbatim, when the runtime reported it. */
  metadata?: Record<string, JsonValue>;
  /** The result text, verbatim, for a call that produced one. */
  output?: string;
  /** The failure text, verbatim, for a call that failed. */
  error?: string;
  status: 'pending' | 'running' | 'completed' | 'error';
  /** When the call started, in milliseconds since the epoch. */
  startedAt?: number;
  /** When the call settled, in milliseconds since the epoch. */
  endedAt?: number;
  /** The child session this call started, when the call recorded it. */
  childSessionID?: string;
  /** The call's own description, as the model wrote it. */
  description?: string;
  /** The agent the call ran, as the model wrote it. */
  agent?: string;
  /** The prompt the call carried, when it had one. */
  prompt?: string;
  /**
   * Whether the call went to the background.
   *
   * A background call settles at once and its child keeps running, so the
   * call's own span says nothing about when the work was done. The child
   * reports its own completion later.
   */
  background?: boolean;
};

type ExportEventBase = {
  id: string;
  origin: ExportEventOrigin;
  /** The event's own timestamp, when the source recorded one. */
  timestamp?: number;
  /** The session the event belongs to. */
  sessionID: string;
  /** The depth of the session below the exported root: 0 for the root itself. */
  depth: number;
  /** The agent that produced the event, when the source recorded it. */
  agent?: string;
  /** The model that produced the event, when the source recorded it. */
  model?: string;
  /** The thinking level the model ran with, when the user picked one. */
  variant?: string;
};

type ExportMessageEvent = ExportEventBase & {
  kind: 'message';
  role: ExportRole;
  /** The message's text, as the model and the user wrote it. */
  text: string;
  /** The files the message carried, when it carried any. */
  attachments?: Array<{ filename?: string; mime: string; url: string }>;
  /**
   * The shell record's own result, when the message is a shell record.
   *
   * A shell record carries what the command printed, how it ended and the
   * code it exited with. The export keeps them, so the readable view can say
   * that a command failed instead of showing only the command.
   */
  shell?: ExportShellResult;
  /** The parts of the message, in their recorded order. */
  parts: ExportPart[];
};

/** A shell record's result, as the export carries it. */
export type ExportShellResult = {
  /** What the command printed, verbatim, when it printed anything. */
  output?: string;
  /** How the command ended, as the runtime recorded it. */
  status?: string;
  /** The code the command exited with, when it reported one. */
  exit?: number;
};

type ExportToolEvent = ExportEventBase & {
  kind: 'tool';
  call: ExportToolCall;
};

type ExportReasoningEvent = ExportEventBase & {
  kind: 'reasoning';
  text: string;
};

/**
 * A subagent's completion, as the parent session recorded it: the report the
 * runtime appended when a background run or a command finished.
 */
type ExportSubagentResultEvent = ExportEventBase & {
  kind: 'subagent-result';
  childSessionID: string;
  state: 'running' | 'completed' | 'error' | 'cancelled';
  /** The child's own description of the work, when it had one. */
  description?: string;
  /** The result text, without the runtime's envelope. */
  output: string;
};

/**
 * A session the export could not load, or could not place. The event keeps
 * the failure visible in the timeline instead of dropping it.
 */
type ExportGapEvent = ExportEventBase & {
  kind: 'gap';
  /** What the export knows about the missing session. */
  childSessionID?: string;
  reason: 'unavailable' | 'unresolved' | 'ambiguous';
  /** The text of the notice, in the reader's language. */
  messageKey: I18nKey;
  /** The values the notice's text names. */
  messageParams?: I18nParams;
};

export type ExportEvent =
  | ExportMessageEvent
  | ExportToolEvent
  | ExportReasoningEvent
  | ExportSubagentResultEvent
  | ExportGapEvent;

/** One part of a message, as the export carries it. */
export type ExportPart =
  | { type: 'text'; id: string; text: string; metadata?: Record<string, JsonValue> }
  | { type: 'file'; id: string; filename?: string; mime: string; url: string }
  | { type: 'agent'; id: string; name: string }
  | { type: 'tool'; id: string; callID: string; tool: string; state: ExportToolCall['status'] }
  | { type: 'reasoning'; id: string; text: string }
  | { type: 'unknown'; id: string; partType: string };

/**
 * Something the export could not establish. The findings are reported once, at
 * the end of the readable document, so an ordinary message never carries a
 * diagnostic line.
 */
export type ExportFinding = {
  kind:
    | 'missing-session'
    | 'unresolved-invocation'
    | 'ambiguous-invocation'
    | 'missing-timestamp'
    | 'unsupported-part'
    | 'unsupported-message-role'
    | 'resumed-session'
    | 'load-failure'
    | 'cyclic-lineage';
  /** The session the finding is about, when it names one. */
  sessionID?: string;
  /** The child session the finding is about, when it names one. */
  childSessionID?: string;
  /**
   * The text of the finding, in the reader's language.
   *
   * A finding is read by a person in the exported document, so it is written
   * in the app's language: the renderer resolves `messageKey` when it writes
   * the document, not when the pipeline records the finding.
   */
  messageKey: I18nKey;
  /** The values the finding's text names. */
  messageParams?: I18nParams;
};

/** The untouched source material of one session. */
export type ExportSourceSession = {
  sessionID: string;
  title: string;
  agent?: string;
  parentID?: string;
  records: Array<{ info: Message; parts: Part[] }>;
};

/**
 * The whole export: the events in their resolved order, the sessions they came
 * from, and what the export could not establish.
 */
export type ExportTimeline = {
  /** The session the user asked to export. */
  rootSessionID: string;
  /** Every session that contributed events, keyed by id. */
  sessions: Map<string, ExportSessionInfo>;
  /** The events, in resolved order. */
  events: ExportEvent[];
  /** What the export could not establish. */
  findings: ExportFinding[];
  /** The source records of every contributing session, keyed by session id. */
  sourceRecords: Map<string, ExportSourceSession>;
};
