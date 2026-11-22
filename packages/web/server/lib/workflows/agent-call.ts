import crypto from 'node:crypto';

import { asNonEmptyString } from '../shared/guards.js';
import { isAgentOptions, isWorkflowSchema } from './contracts.js';
import type { AgentOptions, Execution } from './contracts.js';
import { MAX_CALL_NAME_LENGTH } from './sandbox.js';
import type { WorkflowAgentCall } from './sandbox.js';
import type { WorkflowAgent } from './store.js';

export const callKey = (prompt: string, options: AgentOptions & { forkFromSessionId?: string }) => crypto.createHash('sha256').update(JSON.stringify([prompt, options])).digest('hex').slice(0, 24);

export const readAgentOptions = (raw: WorkflowAgentCall['options']) => {
  const source = isAgentOptions(raw) ? raw : {};
  const label = asNonEmptyString(source.label);
  const agent = asNonEmptyString(source.agent);
  const model = asNonEmptyString(source.model);
  const options: AgentOptions = {};
  if (label) options.label = label.trim().slice(0, 120);
  if (agent) options.agent = agent.trim();
  if (model) options.model = model.trim();
  if (isWorkflowSchema(source.schema)) options.schema = source.schema;
  for (const name of ['id', 'forkFrom'] as const) {
    if (source[name] === undefined) continue;
    const value = asNonEmptyString(source[name]);
    if (!value || value.trim().length > MAX_CALL_NAME_LENGTH) throw new TypeError(`${name} must be a non-empty string of at most ${MAX_CALL_NAME_LENGTH} characters`);
    options[name] = value.trim();
  }
  return options;
};

export const resolveForkSource = (named: Execution['named'], options: AgentOptions) => {
  if (options.id && named.has(options.id)) throw new TypeError(`Duplicate agent id "${options.id}"`);
  const forkFromSessionId = options.forkFrom ? named.get(options.forkFrom) : null;
  if (options.forkFrom && !forkFromSessionId) {
    throw new TypeError(`forkFrom "${options.forkFrom}" must name a successfully completed agent in this run; await its agent() call first`);
  }
  if (options.id) named.set(options.id, null);
  return forkFromSessionId ?? null;
};

export const publishCallName = (named: Execution['named'], options: AgentOptions, record: WorkflowAgent) => {
  if (options.id && record?.state === 'completed' && record.sessionId) named.set(options.id, record.sessionId);
};
