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

import { normalizeToolName } from '@/lib/opencode/tools';
import type { JsonValue } from '@/lib/opencode/model';
import { readTextField } from './values';
import type { ExportEvent, ExportToolCall } from './events';
import type { ExportNode, ExportTree } from './order';

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
  /** Whether the result is shown in full, as the detailed view shows it. */
  outputOmitted: boolean;
  /** When the call started, when the source recorded it. */
  startedAt?: number;
  /** When the call settled, when the source recorded it. */
  endedAt?: number;
  /** The child session this call started, when it started one. */
  childSessionID?: string;
  /** The prompt the call carried, when it had one. */
  prompt?: string;
  /** The agent the call ran, when it ran one. */
  agent?: string;
  /** The call's description, as the model wrote it. */
  descriptionText?: string;
  /** The call's arguments, verbatim. The detailed view shows them. */
  input: Record<string, JsonValue>;
  /** The call's result metadata, verbatim, when the runtime reported it. */
  metadata?: Record<string, JsonValue>;
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
  };
  resumedBy?: Array<{ sessionID: string; timestamp?: number }>;
  concurrentWith?: string[];
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
  /** The entries, without the message the task came from. */
  entries: ProjectedEntry[];
  children: ProjectedSubagent[];
};

/** One projected entry of the export, or a subagent's block. */
export type ProjectedNode = ProjectedEntry | ProjectedSubagent;

/** How much of each event reaches the page. */
export type ProjectionMode = 'readable' | 'detailed';

/** How much of a tool result the readable view keeps. */
const MAX_READABLE_OUTPUT = 600;
/** How much of a tool result the detailed view keeps before it points at the file. */
const MAX_DETAILED_OUTPUT = 200_000;

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
const describeCall = (call: ExportToolCall): string | undefined => {
  const name = normalizeToolName(call.name);
  if (name === 'subagent') {
    return call.description ?? call.agent ?? 'sub-agent';
  }
  if (name === 'shell') return commandOf(call);
  const target = targetOf(call);
  if (target) return target;
  return textField(call.input.description)
    ?? textField(call.input.query)
    ?? textField(call.input.pattern)
    ?? textField(call.input.url);
};

/** Projects one tool call. */
const projectTool = (call: ExportToolCall, mode: ProjectionMode): ProjectedTool => {
  const descriptionText = call.description;
  const projected: ProjectedTool = {
    name: call.name,
    status: call.status,
    description: describeCall(call),
    error: call.error,
    startedAt: call.startedAt,
    endedAt: call.endedAt,
    childSessionID: call.childSessionID,
    prompt: call.prompt,
    agent: call.agent,
    descriptionText,
    input: call.input,
    metadata: call.metadata,
    outputTruncated: false,
    outputOmitted: false,
  };

  const target = targetOf(call);
  if (target) projected.target = target;
  const command = commandOf(call);
  if (command) projected.command = command;

  if (call.output) {
    if (mode === 'readable') {
      const trimmed = trimOutput(call.output, MAX_READABLE_OUTPUT);
      projected.output = trimmed.text;
      projected.outputTruncated = trimmed.truncated;
      projected.outputOmitted = false;
    } else {
      const trimmed = trimOutput(call.output, MAX_DETAILED_OUTPUT);
      projected.output = trimmed.text;
      projected.outputTruncated = trimmed.truncated;
      projected.outputOmitted = trimmed.truncated;
    }
  }

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
    case 'subagent-result':
      return {
        kind: 'subagent-result',
        event,
        childSessionID: event.childSessionID,
        state: event.state,
        description: event.description,
        output: event.output,
        depth: event.depth,
        timestamp: event.timestamp,
      };
    case 'gap':
      return {
        kind: 'gap',
        event,
        reason: event.reason,
        detail: event.detail,
        depth: event.depth,
        timestamp: event.timestamp,
      };
  }
};

/**
 * Projects a node of the export tree.
 *
 * A subagent's block keeps its own entries and its own subagents apart, so a
 * reader follows one thread down instead of jumping between sections.
 */
const projectNode = (node: ExportNode, mode: ProjectionMode): ProjectedNode | null => {
  if (node.kind === 'event') {
    return projectEvent(node.event, mode);
  }

  const entries: ProjectedEntry[] = [];
  const children: ProjectedSubagent[] = [];
  for (const child of node.children) {
    const projected = projectNode(child, mode);
    if (!projected) continue;
    if (projected.kind === 'subagent') children.push(projected);
    else entries.push(projected);
  }

  // The subagent's first prompt is the task it was given. It is shown as
  // the task, not as a second message, so the delegation reads as one thing.
  const first = entries[0];
  const task = first && first.kind === 'message' && first.role === 'user'
    ? first.text
    : node.dispatchedBy?.task;
  const rest = first && first.kind === 'message' && first.role === 'user'
    ? entries.slice(1)
    : entries;

  return {
    kind: 'subagent',
    childSessionID: node.childSessionID,
    title: node.session.title,
    agent: node.session.agent,
    depth: node.depth,
    startedAt: node.startedAt,
    endedAt: node.endedAt,
    dispatchedBy: node.dispatchedBy,
    resumedBy: node.resumedBy,
    concurrentWith: node.concurrentWith,
    invokedAs: node.session.invokedAs,
    invokedDescription: node.session.invokedDescription,
    task: task || undefined,
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
