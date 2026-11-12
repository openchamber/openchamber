import { describe, expect, test } from 'bun:test';

import {
  groupWorkflowAgentsByPhase,
  workflowAgentDetailSchema,
  workflowRunSchema,
  workflowRunTotals,
  type WorkflowAgent,
  type WorkflowRun,
} from './model';
import { readWorkflowReport } from './report';
import type { SyntheticMessage } from '@/lib/opencode/model';
import { isBackgroundReportEntry } from '@/components/chat/lib/timelineRoles';

const agent = (key: string, phase: string | null, state: WorkflowAgent['state']): WorkflowAgent => ({ key, label: key, phase, state });

const run = (agents: WorkflowAgent[], phases: string[]): WorkflowRun => workflowRunSchema.parse({
  id: 'wf_one',
  parentSessionId: 'ses_parent',
  directory: '/repo',
  name: 'audit-routes',
  description: 'Audit every route',
  state: 'running',
  attempt: 1,
  createdAt: 1,
  currentPhase: 'Audit',
  phases,
  agents,
  logs: [],
});

describe('groupWorkflowAgentsByPhase', () => {
  test('keeps the planned order, adds phases named on the way and agents outside a phase last', () => {
    const groups = groupWorkflowAgentsByPhase(run([
      agent('a', 'Audit', 'completed'),
      agent('b', 'Audit', 'running'),
      agent('c', null, 'failed'),
      agent('d', 'Extra', 'completed'),
    ], ['Find', 'Audit']));

    expect(groups.map((group) => [group.title, group.agents.length, group.done, group.running, group.failed])).toEqual([
      ['Find', 0, 0, 0, 0],
      ['Audit', 2, 1, 1, 0],
      [null, 1, 0, 0, 1],
      ['Extra', 1, 1, 0, 0],
    ]);
  });
});

describe('workflow panel data', () => {
  test('reads an answer as text or as a JSON value', () => {
    expect(workflowAgentDetailSchema.parse({ key: 'k', prompt: 'p', result: '## Found 2' }).result).toEqual({ kind: 'text', text: '## Found 2' });
    expect(workflowAgentDetailSchema.parse({ key: 'k', prompt: 'p', result: { findings: [{ file: 'a.ts', line: 3 }] } }).result).toEqual({
      kind: 'json',
      value: { findings: [{ file: 'a.ts', line: 3 }] },
      // Laid out as a list of records: one card per finding.
      tree: {
        kind: 'record',
        entries: [['findings', { kind: 'list', items: [{ kind: 'record', entries: [
          ['file', { kind: 'scalar', text: 'a.ts', tone: 'string' }],
          ['line', { kind: 'scalar', text: '3', tone: 'number' }],
        ] }] }]],
      },
    });
    expect(workflowAgentDetailSchema.parse({ key: 'k', prompt: 'p' }).result).toBeUndefined();
  });

  test('totals what the measured agents spent, leaving replayed answers and cache reads out', () => {
    const usage = { cost: 0.5, input: 100, output: 20, reasoning: 5, cacheRead: 10_000, cacheWrite: 50 };
    const totals = workflowRunTotals(run([
      { ...agent('a', 'Audit', 'completed'), usage },
      { ...agent('b', 'Audit', 'completed'), usage, replayed: true },
      agent('c', 'Audit', 'running'),
    ], ['Audit']));
    expect(totals).toEqual({ tokens: 175, cost: 0.5, measured: 1 });
  });
});

describe('readWorkflowReport', () => {
  // The shape `web/server/lib/workflows` admits into the session that proposed the run.
  const message = (overrides: Partial<SyntheticMessage> = {}): SyntheticMessage => ({
    id: 'msg_report',
    sessionID: 'ses_parent',
    role: 'synthetic',
    time: { created: 5 },
    text: '<openchamber-workflow runId="wf_one" name="audit-routes" state="completed">\nAgents: 2 completed.\n</openchamber-workflow>',
    description: 'audit-routes',
    metadata: { source: 'openchamber-workflow', runId: 'wf_one', name: 'audit-routes', state: 'completed' },
    ...overrides,
  });

  test('reads the run and the report without its envelope', () => {
    expect(readWorkflowReport(message())).toEqual({ runId: 'wf_one', name: 'audit-routes', state: 'completed', output: 'Agents: 2 completed.' });
    // It opens a turn of its own, like a dispatched session's result.
    expect(isBackgroundReportEntry(message())).toBe(true);
  });

  test('ignores other synthetic messages', () => {
    expect(readWorkflowReport(message({ metadata: { source: 'openchamber-session', sessionID: 'ses_1', state: 'completed' } }))).toBeUndefined();
  });
});
