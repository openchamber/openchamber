import type fs from 'node:fs/promises';
import type pathModule from 'node:path';

import type { DispatchOutcome } from '../dispatch-results/runtime.js';
import { isPlainObject, isString } from '../shared/guards.js';
import type { createLimiter } from './limiter.js';
import type { summarizeRun } from './runtime.js';
import type { runWorkflowSandbox } from './sandbox.js';
import type { WorkflowRunStore, WorkflowRun, WorkflowAgent } from './store.js';

interface WorkflowAgentSessions {
  start: (input: {
    directory: string;
    parentSessionId: string;
    title: string;
    agent?: string | undefined;
    model?: string | undefined;
    allowTools?: string[];
    text: string;
    signal: AbortSignal;
    onSession: (id: string) => void | Promise<void>;
  }) => Promise<{ sessionId: string; outcome: DispatchOutcome }>;
  followUp: (input: { directory: string; sessionId: string; text: string; signal: AbortSignal }) => Promise<DispatchOutcome>;
  interrupt: (directory: string, sessionId: string) => Promise<void>;
  readUsage: (input: { directory: string; sessionId: string }) => Promise<{
    model: string | null;
    usage: NonNullable<WorkflowAgent['usage']>;
  } | null>;
  createSession: (input: { directory: string; title: string }) => Promise<string>;
}

export type WorkflowText = Pick<string, 'length' | 'slice'>;

export interface WorkflowSchema {
  type?: unknown;
}

interface AgentOptionsInput {
  label?: unknown;
  agent?: unknown;
  model?: unknown;
  schema?: unknown;
}

export type AgentOptions = Pick<WorkflowAgent, 'agent' | 'model'> & { label?: string; schema?: WorkflowSchema };
export type RunInput = { runId?: unknown };

export interface WorkflowInput extends RunInput {
  name?: unknown;
  script?: unknown;
  args?: unknown;
  agent?: unknown;
  answer?: unknown;
  overwrite?: unknown;
}

export interface WorkflowScope {
  sessionId?: string | null;
  directory?: string | null | undefined;
  scriptDirectory?: string | null;
}

export interface AnswerSlot {
  schema: WorkflowSchema;
  submitted: boolean;
  value: unknown;
}

export interface Execution {
  controller: AbortController;
  limiter: ReturnType<typeof createLimiter>;
  sessions: Set<string>;
  inflight: Set<Promise<WorkflowAgent['result']>>;
  completed: Map<string, WorkflowAgent>;
  consumed: Set<string>;
  occurrences: Map<string, number>;
  stopReason: string | null;
  sandbox: ReturnType<typeof runWorkflowSandbox> | null;
}

export interface Ending {
  state: 'completed' | 'stopped' | 'failed' | 'declined';
  error?: string;
  result?: unknown;
  resume: boolean;
}

export interface SyntheticMessage {
  id: string;
  text: string;
  description: string;
  metadata: Record<string, string>;
  delivery: string;
  resume: boolean;
}

interface SyntheticReport extends SyntheticMessage {
  metadata: { source: string; runId: string; name: string; state: WorkflowRun['state'] };
}

export interface WorkflowRuntimeOptions {
  store: WorkflowRunStore;
  agentSessions: WorkflowAgentSessions;
  postSynthetic: (sessionId: string, body: SyntheticReport) => Promise<void>;
  broadcast?: (event: { type: 'openchamber:workflow-run'; properties: { run: ReturnType<typeof summarizeRun> } }
    | { type: 'openchamber:workflow-run-removed'; properties: { runId: string; parentSessionId: string } }) => void;
  isEnabled?: () => Promise<boolean>;
  startsWithoutApproval?: () => Promise<boolean>;
  fsPromises: Pick<typeof fs, 'readFile' | 'access' | 'mkdir' | 'writeFile' | 'readdir'>;
  path: Pick<typeof pathModule, 'join' | 'relative' | 'dirname'>;
  now?: () => number;
  sleep?: (duration: number) => Promise<void>;
  maxConcurrentAgents?: number;
  maxAgentsPerRun?: number;
  pid?: number;
  isProcessAlive?: (pid: number) => boolean;
  readProcessStart?: (pid: number) => Promise<string | null>;
}

export const isAgentOptions = (value: unknown): value is AgentOptionsInput => isPlainObject(value);
export const isWorkflowSchema = (value: unknown): value is WorkflowSchema => isPlainObject(value);
export const isAnswerWrapper = (value: unknown): value is { value?: unknown } => isPlainObject(value);
export const isWorkflowText = (value: unknown): value is WorkflowText => isString(value);
export const hasErrorCode = (value: unknown): value is { code?: unknown } =>
  value !== null && value !== undefined && 'code' in Object(value);
export const hasErrorStatus = (value: unknown): value is { status?: unknown } =>
  value !== null && value !== undefined && 'status' in Object(value);
export const hasErrorMessage = (value: unknown): value is { message?: unknown } =>
  value !== null && value !== undefined && 'message' in Object(value);
