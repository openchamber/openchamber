/**
 * The two views the export renders from.
 *
 * The readable view is what a person reads: whole messages, compact tool
 * rows, and a subagent's own headline and findings. The detailed view is the
 * same history without omissions: every tool input, every tool output, every
 * part.
 *
 * Both are projections over the same events, so the three formats cannot
 * disagree about what happened. The difference is how much of each event
 * reaches the page, never which events exist.
 */

import { executeOutputTruncation, normalizeToolName } from '@/lib/opencode/tools';
import type { JsonValue } from '@/lib/opencode/model';
import { readTextField } from './values';
import { exportText, findingText } from './i18n';
import type { ExportEvent, ExportShellResult, ExportToolCall, ExportTimeline } from './events';
import type { ConcurrentWork, ExportNode, ExportTree } from './order';

/** How a tool call appears in the readable view. */
export type ProjectedTool = {
  /** The tool's name, as the provider called it. */
  name: string;
  /** A short description of what the call did. */
  description?: string;
  /** The call's status, as the source recorded it. */
  status: ExportToolCall['status'];
  /** The file the call touched, when it named one. */
  target?: string;
  /** The command the call ran, when it ran one. */
  command?: string;
  /** The failure text, when the call failed. */
  error?: string;
  /** A short excerpt of the result, when the result is short enough to show. */
  output?: string;
  /** Whether the result was cut down for the readable view. */
  outputTruncated: boolean;
  /**
   * The runtime's own cut of the result, and where it put the rest.
   *
   * The runtime truncates a long tool result itself and keeps the prefix in
   * the record, so the document says so where the reader sees the output: a
   * reader must not take the part the runtime kept for the whole result.
   */
  runtimeTruncation?: {
    /** The file the runtime wrote the rest to, when it named one. */
    outputPath?: string;
  };
  /** When the call started, when the source recorded it. */
  startedAt?: number;
  /** When the call settled, when the source recorded it. */
  endedAt?: number;
  /** The child session this call started, when it started one. */
  childSessionID?: string;
  /** The prompt the call carried, when it had one. */
  prompt?: string;
  /** The agent the call asked for, when it asked for one. */
  agent?: string;
  /** The call's description, as the model wrote it. */
  descriptionText?: string;
  /** The call's arguments, verbatim. The detailed view shows them. */
  input: Record<string, JsonValue>;
  /** The call's result metadata, verbatim, when the runtime reported it. */
  metadata?: Record<string, JsonValue>;
  /** The call's own identifier, as the runtime recorded it. */
  callID?: string;
};

/** One projected entry of the export. */
export type ProjectedEntry =
  | {
      kind: 'message';
      event: ExportEvent;
      role: string;
      text: string;
      attachments?: Array<{ filename?: string; mime: string; url: string }>;
      agent?: string;
      model?: string;
      variant?: string;
      timestamp?: number;
      depth: number;
      /** The shell record's own result, when the record is a shell record. */
      shell?: ExportShellResult;
    }
  | {
      kind: 'tool';
      event: ExportEvent;
      tool: ProjectedTool;
      depth: number;
      timestamp?: number;
    }
  | {
      kind: 'reasoning';
      event: ExportEvent;
      text: string;
      depth: number;
      timestamp?: number;
    }
  | {
      kind: 'subagent-result';
      event: ExportEvent;
      childSessionID: string;
      state: string;
      description?: string;
      output: string;
      /** Whether the result was cut down for the readable view. */
      outputTruncated: boolean;
      depth: number;
      timestamp?: number;
    }
  | {
      kind: 'gap';
      event: ExportEvent;
      reason: string;
      detail: string;
      depth: number;
      timestamp?: number;
    };

/** A subagent's block, projected. */
export type ProjectedSubagent = {
  kind: 'subagent';
  childSessionID: string;
  title: string;
  agent?: string;
  depth: number;
  startedAt?: number;
  endedAt?: number;
  dispatchedBy?: {
    sessionID: string;
    timestamp?: number;
    /** The task the call carried, when it had one. */
    task?: string;
    /** How the call itself ended. */
    status?: string;
    /** The failure text of the call, when it failed. */
    error?: string;
    /** The result the call returned, when it returned one. */
    output?: string;
    /** When the call settled, when the source recorded it. */
    endedAt?: number;
    /** The call itself, so the detailed view can show it in full. */
    call?: ProjectedTool;
  };
  resumedBy?: Array<{ sessionID: string; timestamp?: number }>;
  concurrentWith?: ConcurrentWork[];
  /**
   * The agent the call named, when the call recorded one.
   *
   * The session's own agent label and the agent the call asked for can
   * differ: the call names the agent it wanted, the session records the one
   * that ran. Both are shown, so the reader sees which is which.
   */
  invokedAs?: string;
  /** The description the call recorded, when it recorded one. */
  invokedDescription?: string;
  /**
   * The task the subagent was given.
   *
   * It is the subagent's own first prompt where the child session recorded
   * one, and the call's prompt otherwise: the child session knows what it was
   * asked, and the call only knows what it asked for.
   */
  task?: string;
  /**
   * The task's own record, when the child session recorded one.
   *
   * The task is the child's first prompt. Keeping the record itself means
   * the task's attachments, its time and its role survive into the export
   * instead of being reduced to its text.
   */
  taskEntry?: ProjectedEntry & { kind: 'message' };
  /**
   * The subagent's own history, in order.
   *
   * The sequence is mixed: the subagent's own records and the blocks of the
   * subagents it started share one list, so a nested block sits at the call
   * that started it rather than after everything the parent said.
   */
  entries: ProjectedNode[];
  /**
   * The subagents this one started, in the order they were started.
   *
   * The blocks are also in `entries`, at the place they belong. This list
   * names them on their own, for a reader that wants the tree rather than
   * the thread.
   */
  children: ProjectedSubagent[];
};

/** One projected entry of the export, or a subagent's block. */
export type ProjectedNode = ProjectedEntry | ProjectedSubagent;

/** How much of each event reaches the page. */
export type ProjectionMode = 'readable' | 'detailed';

/** How much of a tool result the readable view keeps. */
const MAX_READABLE_OUTPUT = 600;

/** How much of a subagent's result the readable view keeps. */
const MAX_READABLE_SUBAGENT_RESULT = 800;

/** A tool result and whether it was cut down. */
type TrimmedOutput = {
  /** The text as it is shown. */
  text: string;
  /** Whether the text was cut down. */
  truncated: boolean;
};

const trimOutput = (text: string, limit: number): TrimmedOutput => {
  if (text.length <= limit) return { text, truncated: false };
  return { text: `${text.slice(0, limit)}\n\n… [${text.length - limit} more characters]`, truncated: true };
};

/** A text field of a call's input, when the call wrote one. */
const textField = (value: JsonValue | undefined): string | undefined => readTextField(value);

/** The file a call touched, from its own input. */
const targetOf = (call: ExportToolCall): string | undefined => {
  const input = call.input;
  return textField(input.path)
    ?? textField(input.filePath)
    ?? textField(input.file_path)
    ?? textField(input.directory);
};

/** The command a call ran, from its own input. */
const commandOf = (call: ExportToolCall): string | undefined => {
  const command = textField(call.input.command);
  return command ? command.split('\n')[0].trim() : undefined;
};
/** A one-line description of what a call did. */
const describeCall = (
  call: ExportToolCall,
  target: string | undefined,
  command: string | undefined,
): string | undefined => {
  const name = normalizeToolName(call.name);
  if (name === 'subagent') {
    // The call named no task and no agent: the document says what kind of
    // call it was, in the reader's language.
    return call.description ?? call.agent ?? exportText('export.dialog.subagentLabel');
  }
  if (name === 'shell') return command;
  if (target) return target;
  return textField(call.input.description)
    ?? textField(call.input.query)
    ?? textField(call.input.pattern)
    ?? textField(call.input.url);
};

/** Projects one tool call. */
const projectTool = (call: ExportToolCall, mode: ProjectionMode): ProjectedTool => {
  const descriptionText = call.description;
  // The call's own target and command are read once. The description and the
  // rows below show the same two fields, and a call names its file in one of
  // four.
  const target = targetOf(call);
  const command = commandOf(call);
  const projected: ProjectedTool = {
    name: call.name,
    status: call.status,
    description: describeCall(call, target, command),
    error: call.error,
    startedAt: call.startedAt,
    endedAt: call.endedAt,
    childSessionID: call.childSessionID,
    prompt: call.prompt,
    agent: call.agent,
    descriptionText,
    input: call.input,
    metadata: call.metadata,
    callID: call.callID,
    outputTruncated: false,
  };

  if (target) projected.target = target;
  if (command) projected.command = command;

  if (call.output) {
    if (mode === 'readable') {
      const trimmed = trimOutput(call.output, MAX_READABLE_OUTPUT);
      projected.output = trimmed.text;
      projected.outputTruncated = trimmed.truncated;
    } else {
      // The detailed view carries the recorded result as it is. The runtime
      // cuts a long result itself and keeps the prefix, so a cut here would
      // only lose what the runtime kept, and the promise of the full result
      // would be ours to keep instead of the runtime's.
      projected.output = call.output;
    }
  }

  // The runtime's own cut, when it made one. It is a property of the
  // record, not something the export could not establish, so it belongs
  // where the reader sees the output.
  const truncation = executeOutputTruncation(call.metadata);
  if (truncation) projected.runtimeTruncation = truncation;

  return projected;
};

/** Projects one event. */
const projectEvent = (event: ExportEvent, mode: ProjectionMode): ProjectedEntry | null => {
  switch (event.kind) {
    case 'message':
      return {
        kind: 'message',
        event,
        role: event.role,
        text: event.text,
        attachments: event.attachments,
        agent: event.agent,
        model: event.model,
        variant: event.variant,
        timestamp: event.timestamp,
        depth: event.depth,
        shell: event.shell,
      };
    case 'tool':
      return {
        kind: 'tool',
        event,
        tool: projectTool(event.call, mode),
        depth: event.depth,
        timestamp: event.timestamp,
      };
    case 'reasoning':
      return {
        kind: 'reasoning',
        event,
        text: event.text,
        depth: event.depth,
        timestamp: event.timestamp,
      };
    case 'subagent-result': {
      // The readable view's own cut of the subagent's result, the way it
      // cuts a tool result: the cut is the export's own, so it has to stay
      // marked where the reader sees the result. The detailed view carries
      // the result as the history recorded it, so it has nothing to mark.
      const trimmed = event.output.trim();
      const truncated = mode === 'readable' && trimmed.length > MAX_READABLE_SUBAGENT_RESULT;
      return {
        kind: 'subagent-result',
        event,
        childSessionID: event.childSessionID,
        state: event.state,
        description: event.description,
        output: truncated ? trimmed.slice(0, MAX_READABLE_SUBAGENT_RESULT) : event.output,
        outputTruncated: truncated,
        depth: event.depth,
        timestamp: event.timestamp,
      };
    }
    case 'gap':
      return {
        kind: 'gap',
        event,
        reason: event.reason,
        detail: findingText(event.messageKey, event.messageParams),
        depth: event.depth,
        timestamp: event.timestamp,
      };
  }
};

/**
 * Projects a node of the export tree.
 *
 * A subagent's block keeps one sequence: its own records and the blocks of
 * the subagents it started share it, so a reader follows one thread down
 * instead of jumping between sections.
 */
const projectNode = (node: ExportNode, mode: ProjectionMode): ProjectedNode | null => {
  if (node.kind === 'event') {
    return projectEvent(node.event, mode);
  }

  const sequence: ProjectedNode[] = [];
  const children: ProjectedSubagent[] = [];
  for (const child of node.children) {
    const projected = projectNode(child, mode);
    if (!projected) continue;
    if (projected.kind === 'subagent') children.push(projected);
    sequence.push(projected);
  }

  // The subagent's first prompt is the task it was given. It is shown as
  // the task, not as a second message, so the delegation reads as one thing.
  // The record itself is kept, so the task's attachments, its time and its
  // role survive into the export — a prompt that carried only a file is
  // still a task.
  const first = sequence[0];
  const taskEntry = first && first.kind === 'message' && first.role === 'user'
    ? first
    : undefined;
  const task = taskEntry
    ? taskEntry.text
    : node.dispatchedBy?.task;
  const rest = taskEntry
    ? sequence.slice(1)
    : sequence;

  return {
    kind: 'subagent',
    childSessionID: node.childSessionID,
    title: node.session.title,
    agent: node.session.agent,
    depth: node.depth,
    startedAt: node.startedAt,
    endedAt: node.endedAt,
    dispatchedBy: node.dispatchedBy
      ? {
          ...node.dispatchedBy,
          call: node.dispatchedBy.call
            ? projectTool(node.dispatchedBy.call.call, mode)
            : undefined,
        }
      : undefined,
    resumedBy: node.resumedBy,
    concurrentWith: node.concurrentWith,
    invokedAs: node.session.invokedAs,
    invokedDescription: node.session.invokedDescription,
    task: task || undefined,
    taskEntry,
    entries: rest,
    children,
  };
};

/**
 * The export as a list of projected entries and subagent blocks.
 */
export const projectExport = (tree: ExportTree, mode: ProjectionMode): ProjectedNode[] => {
  return tree.nodes
    .map((node) => projectNode(node, mode))
    .filter((node): node is ProjectedNode => node !== null);
};

/**
 * The agent the exported session ran, when the history names one.
 *
 * The session's own agent is the name the document uses. A session that
 * recorded none still has messages that recorded the agent that answered
 * them, and that name is used rather than a neutral word: the document says
 * who spoke, and the history says who did.
 */
export const readRootAgent = (timeline: ExportTimeline): string | undefined => {
  const session = timeline.sessions.get(timeline.rootSessionID);
  const fromSession = session?.agent?.trim();
  if (fromSession) return fromSession;

  for (const event of timeline.events) {
    if (event.sessionID !== timeline.rootSessionID) continue;
    if (event.kind !== 'message' || event.role !== 'assistant') continue;
    const fromMessage = event.agent?.trim();
    if (fromMessage) return fromMessage;
  }
  return undefined;
};
