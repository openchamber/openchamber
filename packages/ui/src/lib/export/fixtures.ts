/**
 * Fixtures for the export tests.
 *
 * The shapes here mirror what the runtime records: a message with ordered
 * parts, a tool call whose metadata names the child session it started, a
 * subagent report appended to the parent when a background run finished.
 */

import { z } from 'zod';
import type { Message, Metadata, Part } from '@/lib/opencode/model';

export type Record_ = { info: Message; parts: Part[] };

/**
 * A part the domain model does not name.
 *
 * The runtime may write a part type the model does not know yet, and the
 * export has to carry it rather than drop it. The fixture builds the part
 * the way such a record arrives: as a parsed record, not as a model value.
 */
const futurePartSchema = z.object({
  id: z.string(),
  sessionID: z.string(),
  messageID: z.string(),
  type: z.string(),
});

export const futurePart = (messageID: string): Part => {
  const parsed = futurePartSchema.parse({
    id: `${messageID}-future`,
    sessionID: 'ses_root',
    messageID,
    type: 'future',
  });
  // SAFETY: the fixture stands in for a record the runtime wrote with a
  // part type the domain model does not name yet. The export reads the
  // type off the record and carries the part as unknown.
  return parsed as Part;
};

export const textPart = (messageID: string, content: string, id?: string): Part => ({
  id: id ?? `${messageID}-text`,
  sessionID: 'ses_root',
  messageID,
  type: 'text',
  text: content,
});

/**
 * A text part that says when it was written.
 *
 * The time of a text part is what places a message among the parts of its
 * own record: an answer that came after the work it describes says so.
 */
export const timedTextPart = (
  messageID: string,
  content: string,
  start: number,
  id?: string,
): Part => ({
  id: id ?? `${messageID}-text`,
  sessionID: 'ses_root',
  messageID,
  type: 'text',
  text: content,
  time: { start },
});

export const userMessage = (sessionID: string, id: string, created: number, content: string): Record_ => ({
  info: { id, sessionID, role: 'user', time: { created } },
  parts: [{ ...textPart(id, content), sessionID }],
});

export const assistantMessage = (
  sessionID: string,
  id: string,
  created: number,
  content: string,
  options: { agent?: string; model?: string; variant?: string } = {},
): Record_ => ({
  info: {
    id,
    sessionID,
    role: 'assistant',
    agent: options.agent ?? 'build',
    providerID: 'anthropic',
    modelID: options.model ?? 'claude-opus-4-1',
    variant: options.variant,
    time: { created, completed: created + 1000 },
  },
  parts: [{ ...textPart(id, content), sessionID }],
});

/** A subagent call whose metadata names the child session it started. */
export const subagentCall = (
  messageID: string,
  options: {
    sessionID?: string;
    childSessionID?: string;
    description?: string;
    prompt?: string;
    agent?: string;
    status?: 'running' | 'completed' | 'error';
    startedAt?: number;
    endedAt?: number;
    output?: string;
    error?: string;
    /** The metadata the runtime reported for the call. */
    metadata?: Metadata;
  } = {},
): Part => {
  const status = options.status ?? 'completed';
  const childID = options.childSessionID;
  const base = {
    id: `${messageID}-subagent`,
    sessionID: options.sessionID ?? 'ses_root',
    messageID,
    type: 'tool' as const,
    callID: `${messageID}-call`,
    tool: 'subagent',
  };
  const input = {
    description: options.description ?? 'Review the change',
    prompt: options.prompt ?? 'Review the whole change',
    agent: options.agent ?? 'reviewer',
  };
  const reported: Metadata = options.metadata ? { ...options.metadata } : {};
  if (childID) reported.sessionID = childID;
  const metadata = Object.keys(reported).length > 0 ? reported : undefined;

  if (status === 'running') {
    return {
      ...base,
      state: {
        status: 'running',
        input,
        metadata,
        time: { start: options.startedAt ?? 1000 },
      },
    };
  }
  if (status === 'error') {
    return {
      ...base,
      state: {
        status: 'error',
        input,
        error: options.error ?? 'The subagent failed',
        metadata,
        time: { start: options.startedAt ?? 1000, end: options.endedAt ?? 2000 },
      },
    };
  }
  return {
    ...base,
    state: {
      status: 'completed',
      input,
      output: options.output ?? 'The review found blocking defects.',
      metadata,
      time: { start: options.startedAt ?? 1000, end: options.endedAt ?? 2000 },
    },
  };
};

/** An ordinary tool call, for the compact tool presentation. */
export const shellCall = (messageID: string, command: string, startedAt = 1000, endedAt = 1500): Part => ({
  id: `${messageID}-shell`,
  sessionID: 'ses_root',
  messageID,
  type: 'tool',
  callID: `${messageID}-shell-call`,
  tool: 'shell',
  state: {
    status: 'completed',
    input: { command },
    output: 'ok',
    time: { start: startedAt, end: endedAt },
  },
});

/**
 * The report the runtime appends to the parent when a dispatched session
 * finishes.
 *
 * A dispatch is not a sub-agent call: the parent asked for a session to be
 * created, and the runtime appends this report when that session is done.
 * The report names the session, so it is a line of relationship like a call.
 */
export const dispatchedSessionReport = (
  sessionID: string,
  id: string,
  created: number,
  options: {
    childSessionID: string;
    state?: 'completed' | 'error' | 'cancelled';
    title?: string;
    output?: string;
  },
): Record_ => {
  const metadata: Metadata = {
    source: 'openchamber-session',
    sessionID: options.childSessionID,
    state: options.state ?? 'completed',
  };
  if (options.title) metadata.title = options.title;

  return {
    info: {
      id,
      sessionID,
      role: 'synthetic',
      time: { created },
      text: `<openchamber-session>\n${options.output ?? 'The result.'}\n</openchamber-session>`,
      description: options.title,
      metadata,
    },
    parts: [],
  };
};

/**
 * The report the runtime appends to the parent when a background subagent
 * finishes.
 */
export const subagentReport = (
  sessionID: string,
  id: string,
  created: number,
  options: {
    childSessionID: string;
    state?: 'running' | 'completed' | 'error' | 'cancelled';
    agent?: string;
    description?: string;
    output?: string;
  },
): Record_ => {
  const metadata: Metadata = {
    source: 'subagent',
    childID: options.childSessionID,
    state: options.state ?? 'completed',
  };
  if (options.agent) metadata.agent = options.agent;

  return {
    info: {
      id,
      sessionID,
      role: 'synthetic',
      time: { created },
      text: `<subagent>\n${options.output ?? 'The result.'}\n</subagent>`,
      description: options.description,
      metadata,
    },
    parts: [],
  };
};
