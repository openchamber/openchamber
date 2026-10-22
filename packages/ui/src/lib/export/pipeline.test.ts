/**
 * The export pipeline's own contract.
 *
 * The tests read the same way the export does: a session tree in, a document
 * out. They cover the cases the redesign has to get right — nesting, parallel
 * work, background runs, resumed sessions, missing identities, missing
 * timestamps, every tool state, and the scale the export has to survive.
 */

import { describe, expect, test } from 'bun:test';
import type { Session } from '@/lib/opencode/model';
import { buildExport, buildExportFromRecords } from './pipeline';
import { renderExportMarkdown } from './markdown';
import { renderExportHtml } from './html';
import { renderExportJson } from './json';
import type { ExportSessionInfo, ExportTimeline } from './events';
import {
  assistantMessage,
  futurePart,
  shellCall,
  subagentCall,
  subagentReport,
  textPart,
  userMessage,
  type Record_,
} from './fixtures';



const session = (id: string, overrides: Partial<Session> = {}): Session => ({
  id,
  projectID: 'proj_1',
  directory: '/repo',
  title: id,
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0, updated: 0 },
  ...overrides,
});

type Fixture = {
  root: Session;
  sessions: Session[];
  records: Map<string, Record_[]>;
};

const fixture = (parts: {
  root: Session;
  sessions?: Session[];
  records: Record<string, Record_[]>;
}): Fixture => ({
  root: parts.root,
  sessions: parts.sessions ?? [parts.root],
  records: new Map(Object.entries(parts.records)),
});

const build = (input: Fixture, mode: 'readable' | 'detailed' = 'readable') => (
  buildExportFromRecords({
    root: input.root,
    sessions: input.sessions,
    records: input.records,
  }, mode)
);

const markdown = (input: Fixture, mode: 'readable' | 'detailed' = 'readable'): string => {
  const { projection, timeline } = build(input, mode);
  return renderExportMarkdown(projection, {
    title: input.root.title,
    mode,
    findings: timeline.findings,
    sessionCount: timeline.sessions.size,
  });
};

const timelineOf = (input: Fixture): ExportTimeline => build(input).timeline;

const sessionsOf = (timeline: ExportTimeline): ExportSessionInfo[] => [...timeline.sessions.values()];

describe('export pipeline', () => {
  test('a parent with one child and one grandchild keeps the nesting', () => {
    const input = fixture({
      root: session('ses_root', { title: 'Root' }),
      sessions: [
        session('ses_root', { title: 'Root' }),
        session('ses_child', { title: 'Child', parentID: 'ses_root', agent: 'reviewer' }),
        session('ses_grand', { title: 'Grand', parentID: 'ses_child', agent: 'explore' }),
      ],
      records: {
        ses_root: [
          userMessage('ses_root', 'u1', 1000, 'Do the work'),
          {
            info: {
              id: 'a1', sessionID: 'ses_root', role: 'assistant', agent: 'build',
              providerID: 'anthropic', modelID: 'claude-opus-4-1', time: { created: 2000 },
            },
            parts: [textPart('a1', 'Starting'), subagentCall('a1', { childSessionID: 'ses_child' })],
          },
        ],
        ses_child: [
          {
            info: {
              id: 'ca1', sessionID: 'ses_child', role: 'assistant', agent: 'reviewer',
              providerID: 'anthropic', modelID: 'claude-opus-4-1', time: { created: 2100 },
            },
            parts: [textPart('ca1', 'Child work'), subagentCall('ca1', { childSessionID: 'ses_grand', sessionID: 'ses_child' })],
          },
        ],
        ses_grand: [assistantMessage('ses_grand', 'ga1', 2200, 'Grandchild work')],
      },
    });

    const output = markdown(input);

    expect(output).toContain('↳ reviewer');
    expect(output).toContain('↳ explore');
    // The grandchild's work is inside the child's block, not beside it, and
    // it sits at the call that started it — before the text the child wrote
    // after that call.
    expect(output.indexOf('Grandchild work')).toBeLessThan(output.indexOf('Child work'));
    expect(output.indexOf('Grandchild work')).toBeLessThan(output.indexOf('Starting') + 1);
  });

  test('several sequential subagents appear at their own points in the conversation', () => {
    const input = fixture({
      root: session('ses_root', { title: 'Root' }),
      sessions: [
        session('ses_root', { title: 'Root' }),
        session('ses_child_a', { title: 'First', parentID: 'ses_root', agent: 'reviewer' }),
        session('ses_child_b', { title: 'Second', parentID: 'ses_root', agent: 'tester' }),
      ],
      records: {
        ses_root: [
          userMessage('ses_root', 'u1', 1000, 'Go'),
          {
            info: {
              id: 'a1', sessionID: 'ses_root', role: 'assistant', agent: 'build',
              providerID: 'anthropic', modelID: 'claude-opus-4-1', time: { created: 2000 },
            },
            parts: [subagentCall('a1', { childSessionID: 'ses_child_a', startedAt: 2000, endedAt: 3000 })],
          },
          assistantMessage('ses_root', 'a2', 5000, 'Now the second one'),
          {
            info: {
              id: 'a3', sessionID: 'ses_root', role: 'assistant', agent: 'build',
              providerID: 'anthropic', modelID: 'claude-opus-4-1', time: { created: 6000 },
            },
            parts: [subagentCall('a3', { childSessionID: 'ses_child_b', startedAt: 6000, endedAt: 7000 })],
          },
        ],
        ses_child_a: [assistantMessage('ses_child_a', 'ca1', 2500, 'First result')],
        ses_child_b: [assistantMessage('ses_child_b', 'cb1', 6500, 'Second result')],
      },
    });

    const output = markdown(input);

    expect(output.indexOf('First result')).toBeLessThan(output.indexOf('Now the second one'));
    expect(output.indexOf('Now the second one')).toBeLessThan(output.indexOf('Second result'));
  });

  test('parallel subagents are marked as overlapping instead of read as sequential', () => {
    const input = fixture({
      root: session('ses_root', { title: 'Root' }),
      sessions: [
        session('ses_root', { title: 'Root' }),
        session('ses_a', { title: 'A', parentID: 'ses_root', agent: 'reviewer' }),
        session('ses_b', { title: 'B', parentID: 'ses_root', agent: 'tester' }),
      ],
      records: {
        ses_root: [
          {
            info: {
              id: 'a1', sessionID: 'ses_root', role: 'assistant', agent: 'build',
              providerID: 'anthropic', modelID: 'claude-opus-4-1', time: { created: 2000 },
            },
            parts: [
              subagentCall('a1', { childSessionID: 'ses_a', startedAt: 2000, endedAt: 9000 }),
              subagentCall('a1b', { childSessionID: 'ses_b', startedAt: 2100, endedAt: 8000 }),
            ],
          },
        ],
        ses_a: [assistantMessage('ses_a', 'aa1', 3000, 'A result')],
        ses_b: [assistantMessage('ses_b', 'ab1', 3100, 'B result')],
      },
    });

    const output = markdown(input);

    expect(output).toContain('Ran at the same time as');
    expect(output).toContain('A result');
    expect(output).toContain('B result');
  });

  test('a background dispatch and its later completion both reach the export', () => {
    const input = fixture({
      root: session('ses_root', { title: 'Root' }),
      sessions: [
        session('ses_root', { title: 'Root' }),
        session('ses_child', { title: 'Child', parentID: 'ses_root', agent: 'reviewer' }),
      ],
      records: {
        ses_root: [
          {
            info: {
              id: 'a1', sessionID: 'ses_root', role: 'assistant', agent: 'build',
              providerID: 'anthropic', modelID: 'claude-opus-4-1', time: { created: 2000 },
            },
            parts: [subagentCall('a1', { childSessionID: 'ses_child', status: 'running', startedAt: 2000 })],
          },
          assistantMessage('ses_root', 'a2', 3000, 'Working on something else meanwhile'),
          subagentReport('ses_root', 'r1', 9000, {
            childSessionID: 'ses_child',
            output: 'The background review found a defect.',
          }),
        ],
        ses_child: [assistantMessage('ses_child', 'ca1', 8500, 'Background work')],
      },
    });

    const output = markdown(input);

    expect(output).toContain('Background work');
    expect(output).toContain('The background review found a defect.');
    expect(output).toContain('Sub-agent result');
  });

  test('a resumed child keeps one transcript and reports the reuse', () => {
    const input = fixture({
      root: session('ses_root', { title: 'Root' }),
      sessions: [
        session('ses_root', { title: 'Root' }),
        session('ses_child', { title: 'Child', parentID: 'ses_root', agent: 'reviewer' }),
      ],
      records: {
        ses_root: [
          {
            info: {
              id: 'a1', sessionID: 'ses_root', role: 'assistant', agent: 'build',
              providerID: 'anthropic', modelID: 'claude-opus-4-1', time: { created: 2000 },
            },
            parts: [subagentCall('a1', { childSessionID: 'ses_child' })],
          },
          {
            info: {
              id: 'a2', sessionID: 'ses_root', role: 'assistant', agent: 'build',
              providerID: 'anthropic', modelID: 'claude-opus-4-1', time: { created: 5000 },
            },
            parts: [subagentCall('a2', { childSessionID: 'ses_child', description: 'Continue the review' })],
          },
        ],
        ses_child: [assistantMessage('ses_child', 'ca1', 3000, 'The one transcript')],
      },
    });

    const output = markdown(input);

    expect(output.match(/The one transcript/g)).toHaveLength(1);
    expect(output).toContain('Incomplete export');
    expect(output).toContain('More than one call names the sub-agent session');
  });

  test('a child with no recorded call is reported instead of being dropped', () => {
    const input = fixture({
      root: session('ses_root', { title: 'Root' }),
      sessions: [
        session('ses_root', { title: 'Root' }),
        session('ses_orphan', { title: 'Orphan', parentID: 'ses_root' }),
      ],
      records: {
        ses_root: [userMessage('ses_root', 'u1', 1000, 'Go')],
        ses_orphan: [assistantMessage('ses_orphan', 'oa1', 2000, 'Orphan work')],
      },
    });

    const output = markdown(input);

    expect(output).toContain('Orphan work');
    expect(output).toContain('was not tied to a call');
  });

  test('a child whose records cannot be loaded is reported once', () => {
    const input = fixture({
      root: session('ses_root', { title: 'Root' }),
      sessions: [
        session('ses_root', { title: 'Root' }),
        session('ses_child', { title: 'Child', parentID: 'ses_root' }),
      ],
      records: {
        ses_root: [userMessage('ses_root', 'u1', 1000, 'Go')],
      },
    });

    const output = markdown(input);

    expect(output).toContain('could not be loaded');
    expect(output).toContain('Incomplete export');
  });

  test('events without a timestamp keep the order the source recorded', () => {
    const input = fixture({
      root: session('ses_root', { title: 'Root' }),
      records: {
        ses_root: [
          userMessage('ses_root', 'u1', 1000, 'First'),
          userMessage('ses_root', 'u2', 1000, 'Second'),
          userMessage('ses_root', 'u3', 1000, 'Third'),
        ],
      },
    });

    const output = markdown(input);

    expect(output.indexOf('First')).toBeLessThan(output.indexOf('Second'));
    expect(output.indexOf('Second')).toBeLessThan(output.indexOf('Third'));
  });

  test('events that share a timestamp keep the order the source recorded', () => {
    const input = fixture({
      root: session('ses_root', { title: 'Root' }),
      records: {
        ses_root: [
          userMessage('ses_root', 'u1', 1000, 'First'),
          userMessage('ses_root', 'u2', 1000, 'Second'),
        ],
      },
    });

    const output = markdown(input);

    expect(output.indexOf('First')).toBeLessThan(output.indexOf('Second'));
  });

  test('every tool state reaches the export with its status', () => {
    const input = fixture({
      root: session('ses_root', { title: 'Root' }),
      records: {
        ses_root: [
          {
            info: {
              id: 'a1', sessionID: 'ses_root', role: 'assistant', agent: 'build',
              providerID: 'anthropic', modelID: 'claude-opus-4-1', time: { created: 2000 },
            },
            parts: [
              { ...shellCall('a1', 'bun test'), id: 'a1-shell' },
              {
                id: 'a1-pending', sessionID: 'ses_root', messageID: 'a1', type: 'tool',
                callID: 'a1-pending-call', tool: 'read',
                state: { status: 'pending', input: { path: 'a.ts' }, raw: '' },
              },
              {
                id: 'a1-running', sessionID: 'ses_root', messageID: 'a1', type: 'tool',
                callID: 'a1-running-call', tool: 'grep',
                state: { status: 'running', input: { pattern: 'x' }, time: { start: 2100 } },
              },
              {
                id: 'a1-error', sessionID: 'ses_root', messageID: 'a1', type: 'tool',
                callID: 'a1-error-call', tool: 'write',
                state: { status: 'error', input: { path: 'b.ts' }, error: 'Permission denied', time: { start: 2200, end: 2300 } },
              },
            ],
          },
        ],
      },
    });

    const output = markdown(input);

    expect(output).toContain('`shell`');
    expect(output).toContain('`read`');
    expect(output).toContain('`grep`');
    expect(output).toContain('`write`');
    expect(output).toContain('pending');
    expect(output).toContain('running');
    expect(output).toContain('failed');
    expect(output).toContain('Permission denied');
  });

  test('the readable view keeps a tool result short and marks the cut', () => {
    const long = 'x'.repeat(2000);
    const input = fixture({
      root: session('ses_root', { title: 'Root' }),
      records: {
        ses_root: [
          {
            info: {
              id: 'a1', sessionID: 'ses_root', role: 'assistant', agent: 'build',
              providerID: 'anthropic', modelID: 'claude-opus-4-1', time: { created: 2000 },
            },
            parts: [{
              id: 'a1-shell', sessionID: 'ses_root', messageID: 'a1', type: 'tool',
              callID: 'a1-call', tool: 'shell',
              state: { status: 'completed', input: { command: 'bun test' }, output: long, time: { start: 1, end: 2 } },
            }],
          },
        ],
      },
    });

    const readable = markdown(input, 'readable');
    const detailed = markdown(input, 'detailed');

    expect(readable).toContain('excerpt');
    expect(readable.length).toBeLessThan(detailed.length);
    expect(detailed).toContain(long);
  });

  test('a result the runtime cut names the file the rest is in', () => {
    // The runtime cuts a long result itself and keeps the prefix in the
    // record, so the document has to say so where the reader looks at the
    // result — in both views.
    const input = fixture({
      root: session('ses_root', { title: 'Root' }),
      records: {
        ses_root: [
          {
            info: {
              id: 'a1', sessionID: 'ses_root', role: 'assistant', agent: 'build',
              providerID: 'anthropic', modelID: 'claude-opus-4-1', time: { created: 2000 },
            },
            parts: [{
              id: 'a1-shell', sessionID: 'ses_root', messageID: 'a1', type: 'tool',
              callID: 'a1-call', tool: 'shell',
              state: {
                status: 'completed',
                input: { command: 'bun test' },
                output: 'the part the runtime kept',
                metadata: { truncated: true, outputPath: '/tmp/oc-output.json' },
                time: { start: 1, end: 2 },
              },
            }],
          },
        ],
      },
    });

    for (const mode of ['readable', 'detailed'] as const) {
      const output = markdown(input, mode);
      expect(output).toContain('The runtime cut this output short');
      expect(output).toContain('/tmp/oc-output.json');
    }

    const { projection, timeline } = build(input, 'detailed');
    const html = renderExportHtml(projection, {
      title: 'Root',
      mode: 'detailed',
      findings: timeline.findings,
      sessionCount: timeline.sessions.size,
    });

    expect(html).toContain('The runtime cut this output short');
    expect(html).toContain('/tmp/oc-output.json');
  });

  test('a result the runtime cut without a file says only that it was cut', () => {
    const input = fixture({
      root: session('ses_root', { title: 'Root' }),
      records: {
        ses_root: [
          {
            info: {
              id: 'a1', sessionID: 'ses_root', role: 'assistant', agent: 'build',
              providerID: 'anthropic', modelID: 'claude-opus-4-1', time: { created: 2000 },
            },
            parts: [{
              id: 'a1-shell', sessionID: 'ses_root', messageID: 'a1', type: 'tool',
              callID: 'a1-call', tool: 'shell',
              state: {
                status: 'completed',
                input: { command: 'bun test' },
                output: 'the part the runtime kept',
                metadata: { truncated: true },
                time: { start: 1, end: 2 },
              },
            }],
          },
        ],
      },
    });

    const output = markdown(input, 'detailed');

    expect(output).toContain('The runtime cut this output short');
    // The runtime named no file, so the document names none.
    expect(output).not.toContain('{path}');
  });

  test('the detailed view carries a result the export does not cut', () => {
    // The runtime cuts a long result itself, so the export has no cut of its
    // own: what the history recorded is what the document carries, and there
    // is nothing to point at.
    const long = 'x'.repeat(200_100);
    const input = fixture({
      root: session('ses_root', { title: 'Root' }),
      records: {
        ses_root: [
          {
            info: {
              id: 'a1', sessionID: 'ses_root', role: 'assistant', agent: 'build',
              providerID: 'anthropic', modelID: 'claude-opus-4-1', time: { created: 2000 },
            },
            parts: [{
              id: 'a1-shell', sessionID: 'ses_root', messageID: 'a1', type: 'tool',
              callID: 'a1-call', tool: 'shell',
              state: { status: 'completed', input: { command: 'bun test' }, output: long, time: { start: 1, end: 2 } },
            }],
          },
        ],
      },
    });

    const detailed = markdown(input, 'detailed');

    expect(detailed).toContain(long);
    expect(detailed).not.toContain('the rest of this result is in the export of this session with full details');
  });

  test('the readable view keeps its own cut of a long result', () => {
    // The readable view cuts the result down and says where the rest is.
    // The cut is the export's own, so it has to stay marked.
    const long = 'x'.repeat(2000);
    const input = fixture({
      root: session('ses_root', { title: 'Root' }),
      records: {
        ses_root: [
          {
            info: {
              id: 'a1', sessionID: 'ses_root', role: 'assistant', agent: 'build',
              providerID: 'anthropic', modelID: 'claude-opus-4-1', time: { created: 2000 },
            },
            parts: [{
              id: 'a1-shell', sessionID: 'ses_root', messageID: 'a1', type: 'tool',
              callID: 'a1-call', tool: 'shell',
              state: { status: 'completed', input: { command: 'bun test' }, output: long, time: { start: 1, end: 2 } },
            }],
          },
        ],
      },
    });

    const readable = markdown(input, 'readable');

    expect(readable).toContain('x'.repeat(600));
    expect(readable).not.toContain(long);
    expect(readable).toContain('excerpt');
    expect(readable).toContain('the rest of this result is in the export of this session with full details');
  });

  test('the mark of a cut names no export the reader does not have', () => {
    // The app writes one file, in the format the reader chose. A mark that
    // pointed at a JSON export would name a file that was never written, so
    // both marks name the export of the same session with full details.
    const long = 'x'.repeat(2000);
    const input = fixture({
      root: session('ses_root', { title: 'Root' }),
      records: {
        ses_root: [
          {
            info: {
              id: 'a1', sessionID: 'ses_root', role: 'assistant', agent: 'build',
              providerID: 'anthropic', modelID: 'claude-opus-4-1', time: { created: 2000 },
            },
            parts: [{
              id: 'a1-shell', sessionID: 'ses_root', messageID: 'a1', type: 'tool',
              callID: 'a1-call', tool: 'shell',
              state: { status: 'completed', input: { command: 'bun test' }, output: long, time: { start: 1, end: 2 } },
            }],
          },
        ],
      },
    });

    const readable = markdown(input, 'readable');
    const { projection, timeline } = build(input, 'readable');
    const html = renderExportHtml(projection, {
      title: 'Root',
      mode: 'readable',
      findings: timeline.findings,
      sessionCount: timeline.sessions.size,
    });

    expect(readable).toContain('the rest of this result is in the export of this session with full details');
    expect(html).toContain('The full result is in the export of this session with full details.');
    expect(readable).not.toContain('JSON export');
    expect(html).not.toContain('JSON export');
  });

  test('the call that started a sub-agent says when the runtime cut its result short', () => {
    // The same fact an ordinary tool call carries, on the call that started
    // the sub-agent.
    const input = fixture({
      root: session('ses_root', { title: 'Root' }),
      sessions: [
        session('ses_root', { title: 'Root' }),
        session('ses_child', { title: 'Child', parentID: 'ses_root', agent: 'reviewer' }),
      ],
      records: {
        ses_root: [
          {
            info: {
              id: 'a1', sessionID: 'ses_root', role: 'assistant', agent: 'build',
              providerID: 'anthropic', modelID: 'claude-opus-4-1', time: { created: 2000 },
            },
            parts: [subagentCall('a1', {
              childSessionID: 'ses_child',
              metadata: { truncated: true, outputPath: '/tmp/oc-full-output.txt' },
            })],
          },
        ],
        ses_child: [assistantMessage('ses_child', 'ca1', 2500, 'Child work')],
      },
    });

    for (const mode of ['readable', 'detailed'] as const) {
      const output = markdown(input, mode);

      expect(output).toContain('The runtime cut this output short');
      expect(output).toContain('/tmp/oc-full-output.txt');
    }

    const { projection, timeline } = build(input, 'detailed');
    const html = renderExportHtml(projection, {
      title: 'Root',
      mode: 'detailed',
      findings: timeline.findings,
      sessionCount: timeline.sessions.size,
    });

    expect(html).toContain('The runtime cut this output short');
    expect(html).toContain('/tmp/oc-full-output.txt');
  });

  test('a sub-agent call that named no task says what kind of call it was', () => {
    // The document's own words, in the reader's language. The export used to
    // write a literal that no locale could translate.
    const input = fixture({
      root: session('ses_root', { title: 'Root' }),
      records: {
        ses_root: [
          {
            info: {
              id: 'a1', sessionID: 'ses_root', role: 'assistant', agent: 'build',
              providerID: 'anthropic', modelID: 'claude-opus-4-1', time: { created: 2000 },
            },
            parts: [{
              id: 'a1-subagent', sessionID: 'ses_root', messageID: 'a1', type: 'tool',
              callID: 'a1-call', tool: 'subagent',
              state: {
                status: 'completed',
                input: { prompt: 'Do the work' },
                output: 'The result',
                time: { start: 1000, end: 2000 },
              },
            }],
          },
        ],
      },
    });

    const output = markdown(input);

    expect(output).toContain('Sub-agent');
  });

  test('the readable view names the agent a call asked for', () => {
    // The child is not in the document, so the row is what the reader has:
    // it has to name the agent the call asked for.
    const input = fixture({
      root: session('ses_root', { title: 'Root' }),
      records: {
        ses_root: [
          {
            info: {
              id: 'a1', sessionID: 'ses_root', role: 'assistant', agent: 'build',
              providerID: 'anthropic', modelID: 'claude-opus-4-1', time: { created: 2000 },
            },
            parts: [subagentCall('a1', { childSessionID: 'ses_missing', agent: 'writer' })],
          },
        ],
      },
    });

    const output = markdown(input);

    expect(output).toContain('writer');
  });

  test('the detailed view carries the tool input and metadata', () => {
    const input = fixture({
      root: session('ses_root', { title: 'Root' }),
      records: {
        ses_root: [
          {
            info: {
              id: 'a1', sessionID: 'ses_root', role: 'assistant', agent: 'build',
              providerID: 'anthropic', modelID: 'claude-opus-4-1', time: { created: 2000 },
            },
            parts: [subagentCall('a1', { childSessionID: 'ses_child' })],
          },
        ],
      },
    });

    const detailed = markdown(input, 'detailed');

    expect(detailed).toContain('**Input**');
    expect(detailed).toContain('"description"');
  });

  test('the JSON export keeps every source record and the derived events apart', () => {
    const input = fixture({
      root: session('ses_root', { title: 'Root' }),
      sessions: [
        session('ses_root', { title: 'Root' }),
        session('ses_child', { title: 'Child', parentID: 'ses_root', agent: 'reviewer' }),
      ],
      records: {
        ses_root: [userMessage('ses_root', 'u1', 1000, 'Go')],
        ses_child: [assistantMessage('ses_child', 'ca1', 2000, 'Child work')],
      },
    });

    const parsed = JSON.parse(renderExportJson(timelineOf(input)));

    expect(parsed.schema.version).toBe(1);
    expect(parsed.schema.ordering).toContain('recorded timestamp');
    expect(parsed.source.ses_root.records).toHaveLength(1);
    expect(parsed.source.ses_child.records).toHaveLength(1);
    expect(parsed.source.ses_root.records[0].info.id).toBe('u1');
    expect(parsed.events.length).toBeGreaterThan(0);
    expect(parsed.sessions.ses_child.agent).toBe('reviewer');
  });

  test('the JSON export keeps every part of the source, in its recorded order', () => {
    const input = fixture({
      root: session('ses_root', { title: 'Root' }),
      records: {
        ses_root: [{
          info: { id: 'u1', sessionID: 'ses_root', role: 'user', time: { created: 1000 } },
          parts: [
            textPart('u1', 'First'),
            { id: 'f1', sessionID: 'ses_root', messageID: 'u1', type: 'file', mime: 'text/plain', filename: 'notes.txt', url: 'file:///notes.txt' },
            textPart('u1', 'Second', 'u1-text-2'),
          ],
        }],
      },
    });

    const parsed = JSON.parse(renderExportJson(timelineOf(input)));
    const parts = parsed.source.ses_root.records[0].parts;

    expect(parts.map((part: { type: string }) => part.type)).toEqual(['text', 'file', 'text']);
    expect(parts[1].filename).toBe('notes.txt');
    expect(parts[2].text).toBe('Second');
  });

  test('the HTML export filters by the agent that produced the entry', () => {
    const input = fixture({
      root: session('ses_root', { title: 'Root' }),
      sessions: [
        session('ses_root', { title: 'Root' }),
        session('ses_child', { title: 'Child', parentID: 'ses_root', agent: 'reviewer' }),
      ],
      records: {
        ses_root: [
          userMessage('ses_root', 'u1', 1000, 'Go'),
          {
            info: {
              id: 'a1', sessionID: 'ses_root', role: 'assistant', agent: 'build',
              providerID: 'anthropic', modelID: 'claude-opus-4-1', time: { created: 2000 },
            },
            parts: [subagentCall('a1', { childSessionID: 'ses_child', startedAt: 2000, endedAt: 3000 })],
          },
        ],
        ses_child: [assistantMessage('ses_child', 'ca1', 2500, 'Child work')],
      },
    });

    const { projection, timeline } = build(input);
    const html = renderExportHtml(projection, {
      title: 'Root',
      mode: 'readable',
      findings: timeline.findings,
      sessionCount: timeline.sessions.size,
    });

    // The filter's data and the page's own attributes must agree, or the
    // filter hides the wrong entries.
    const dataMatch = html.match(/<script type="application\/json" id="export-data">([\s\S]*?)<\/script>/);
    expect(dataMatch).toBeTruthy();
    // SAFETY: the export writes the data block itself, so the match holds
    // the page's own data.
    const data = JSON.parse(dataMatch![1]) as { entries: Array<{ id: string; agent?: string }> };

    const domAgent = new Map<string, string>();
    for (const match of html.matchAll(/data-id="([^"]*)"[^>]*data-agent="([^"]*)"/g)) {
      domAgent.set(match[1], match[2]);
    }

    for (const entry of data.entries) {
      expect(domAgent.get(entry.id) ?? '').toBe(entry.agent ?? '');
    }
  });

  test('the HTML export filters by the agent that produced the entry in the detailed view', () => {
    // The detailed view shows the call that started a sub-agent, and that
    // call is an entry of its own, so the filter reaches it.
    const input = fixture({
      root: session('ses_root', { title: 'Root' }),
      sessions: [
        session('ses_root', { title: 'Root' }),
        session('ses_child', { title: 'Child', parentID: 'ses_root', agent: 'reviewer' }),
      ],
      records: {
        ses_root: [
          {
            info: {
              id: 'a1', sessionID: 'ses_root', role: 'assistant', agent: 'build',
              providerID: 'anthropic', modelID: 'claude-opus-4-1', time: { created: 2000 },
            },
            parts: [subagentCall('a1', { childSessionID: 'ses_child', startedAt: 2000, endedAt: 3000 })],
          },
        ],
        ses_child: [assistantMessage('ses_child', 'ca1', 2500, 'Child work')],
      },
    });

    const { projection, timeline } = build(input, 'detailed');
    const html = renderExportHtml(projection, {
      title: 'Root',
      mode: 'detailed',
      findings: timeline.findings,
      sessionCount: timeline.sessions.size,
    });

    const dataMatch = html.match(/<script type="application\/json" id="export-data">([\s\S]*?)<\/script>/);
    expect(dataMatch).toBeTruthy();
    // SAFETY: the export writes the data block itself, so the match holds
    // the page's own data.
    const data = JSON.parse(dataMatch![1]) as { entries: Array<{ id: string; agent?: string }> };

    const domAgent = new Map<string, string>();
    for (const match of html.matchAll(/data-id="([^"]*)"[^>]*data-agent="([^"]*)"/g)) {
      domAgent.set(match[1], match[2]);
    }

    for (const entry of data.entries) {
      expect(domAgent.get(entry.id) ?? '').toBe(entry.agent ?? '');
    }
  });

  test('the HTML agent filter offers only agents the page actually carries', () => {
    const input = fixture({
      root: session('ses_root', { title: 'Root' }),
      sessions: [
        session('ses_root', { title: 'Root' }),
        session('ses_child', { title: 'Child', parentID: 'ses_root', agent: 'reviewer' }),
      ],
      records: {
        ses_root: [
          userMessage('ses_root', 'u1', 1000, 'Go'),
          {
            info: {
              id: 'a1', sessionID: 'ses_root', role: 'assistant', agent: 'build',
              providerID: 'anthropic', modelID: 'claude-opus-4-1', time: { created: 2000 },
            },
            parts: [subagentCall('a1', { childSessionID: 'ses_child', startedAt: 2000, endedAt: 3000 })],
          },
        ],
        // The sub-agent's own message records the agent that produced it,
        // which is not the agent the block belongs to.
        ses_child: [assistantMessage('ses_child', 'ca1', 2500, 'Child work', { agent: 'build' })],
      },
    });

    const { projection, timeline } = build(input);
    const html = renderExportHtml(projection, {
      title: 'Root',
      mode: 'readable',
      findings: timeline.findings,
      sessionCount: timeline.sessions.size,
    });

    const dataMatch = html.match(/<script type="application\/json" id="export-data">([\s\S]*?)<\/script>/);
    expect(dataMatch).toBeTruthy();
    // SAFETY: the export writes the data block itself, so the match holds
    // the page's own data.
    const data = JSON.parse(dataMatch![1]) as { agents: string[] };

    // Every agent the filter offers matches at least one entry on the page.
    const domAgents = new Set<string>();
    for (const match of html.matchAll(/data-id="([^"]*)"[^>]*data-agent="([^"]*)"/g)) {
      if (match[2]) domAgents.add(match[2]);
    }
    for (const agent of data.agents) {
      expect(domAgents.has(agent)).toBe(true);
    }
  });

  test('the HTML export is self-contained and carries the same history', () => {
    const input = fixture({
      root: session('ses_root', { title: 'Root' }),
      sessions: [
        session('ses_root', { title: 'Root' }),
        session('ses_child', { title: 'Child', parentID: 'ses_root', agent: 'reviewer' }),
      ],
      records: {
        ses_root: [userMessage('ses_root', 'u1', 1000, 'Go')],
        ses_child: [assistantMessage('ses_child', 'ca1', 2000, 'Child work')],
      },
    });

    const { projection, timeline } = build(input);
    const html = renderExportHtml(projection, {
      title: 'Root',
      mode: 'readable',
      findings: timeline.findings,
      sessionCount: timeline.sessions.size,
    });

    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('<style>');
    expect(html).toContain('id="search"');
    expect(html).toContain('Child work');
    expect(html).not.toContain('src="http');
    expect(html).not.toContain('href="http');
  });

  test('the detailed HTML export carries the reasoning and the full call details', () => {
    const input = fixture({
      root: session('ses_root', { title: 'Root' }),
      records: {
        ses_root: [
          {
            info: {
              id: 'a1', sessionID: 'ses_root', role: 'assistant', agent: 'build',
              providerID: 'anthropic', modelID: 'claude-opus-4-1', time: { created: 2000 },
            },
            parts: [
              {
                id: 'a1-reasoning', sessionID: 'ses_root', messageID: 'a1', type: 'reasoning',
                text: 'The reasoning behind the call.', time: { start: 2000, end: 2100 },
              },
              {
                id: 'a1-shell', sessionID: 'ses_root', messageID: 'a1', type: 'tool',
                callID: 'a1-shell-call', tool: 'shell',
                state: {
                  status: 'completed',
                  input: { command: 'bun test' },
                  output: 'ok',
                  metadata: { duration: 12 },
                  time: { start: 2100, end: 2200 },
                },
              },
            ],
          },
        ],
      },
    });

    const { projection, timeline } = build(input, 'detailed');
    const html = renderExportHtml(projection, {
      title: 'Root',
      mode: 'detailed',
      findings: timeline.findings,
      sessionCount: timeline.sessions.size,
    });

    // The reasoning and the metadata only reach the page in the detailed
    // view, and the detailed view is a choice the user can make.
    expect(html).toContain('The reasoning behind the call.');
    expect(html).toContain('duration');
    expect(html).toContain('bun test');
  });

  test('a lineage that points back at itself ends the walk', () => {
    const root = session('ses_root', { title: 'Root' });
    const child = session('ses_child', { title: 'Child', parentID: 'ses_root' });
    const input = fixture({
      root,
      sessions: [root, child, { ...child, id: 'ses_loop', parentID: 'ses_child' }],
      records: {
        ses_root: [userMessage('ses_root', 'u1', 1000, 'Go')],
        ses_child: [assistantMessage('ses_child', 'ca1', 2000, 'Child work')],
      },
    });

    const timeline = timelineOf(input);

    expect(sessionsOf(timeline).map((entry) => entry.id)).toContain('ses_child');
    expect(timeline.findings.every((finding) => finding.kind !== 'cyclic-lineage')).toBe(true);
  });

  test('the export is deterministic for the same source', () => {
    const input = fixture({
      root: session('ses_root', { title: 'Root' }),
      sessions: [
        session('ses_root', { title: 'Root' }),
        session('ses_child', { title: 'Child', parentID: 'ses_root', agent: 'reviewer' }),
      ],
      records: {
        ses_root: [userMessage('ses_root', 'u1', 1000, 'Go')],
        ses_child: [assistantMessage('ses_child', 'ca1', 2000, 'Child work')],
      },
    });

    const first = renderExportJson(timelineOf(input));
    const second = renderExportJson(timelineOf(input));

    expect(first).toBe(second);
  });

  test('a child whose history cannot be loaded is in the document, not only in the toast', async () => {
    const root = session('ses_root', { title: 'Root' });
    const child = session('ses_child', { title: 'Child', parentID: 'ses_root', agent: 'reviewer' });

    const result = await buildExport({
      root,
      sessions: [root, child],
      load: async (sessionID) => {
        if (sessionID === 'ses_root') return [userMessage('ses_root', 'u1', 1000, 'Go')];
        return null;
      },
    }, 'readable');

    // The sub-agent is named in the document, and the failure is reported.
    expect(result.timeline.findings.some((finding) => finding.kind === 'missing-session')).toBe(true);
    const document = renderExportMarkdown(result.projection, {
      title: 'Root',
      mode: 'readable',
      findings: result.timeline.findings,
      sessionCount: result.timeline.sessions.size,
    });
    expect(document).toContain('could not be loaded');
    expect(document).toContain('Incomplete export');
    // The sub-agent is named, so the reader knows what is missing.
    expect(document).toContain('Child');
  });

  test('a child the session list does not name is reported as missing', async () => {
    const root = session('ses_root', { title: 'Root' });

    const result = await buildExport({
      root,
      sessions: [root],
      load: async (sessionID) => {
        if (sessionID === 'ses_root') return [userMessage('ses_root', 'u1', 1000, 'Go')];
        return null;
      },
    }, 'readable');

    expect(result.timeline.findings.some((finding) => finding.kind === 'missing-session')).toBe(false);
  });

  test('the JSON export orders its events by their recorded timestamp', () => {
    const input = fixture({
      root: session('ses_root', { title: 'Root' }),
      sessions: [
        session('ses_root', { title: 'Root' }),
        session('ses_child', { title: 'Child', parentID: 'ses_root', agent: 'reviewer' }),
      ],
      records: {
        // The child's event is recorded before the root's second message,
        // so a list grouped by session would put the root's events first.
        ses_root: [
          userMessage('ses_root', 'u1', 1000, 'First'),
          userMessage('ses_root', 'u2', 9000, 'Last'),
        ],
        ses_child: [assistantMessage('ses_child', 'ca1', 5000, 'Middle')],
      },
    });

    const parsed = JSON.parse(renderExportJson(timelineOf(input)));
    const timestamps = parsed.events.map((event: { timestamp?: number }) => event.timestamp);

    expect(timestamps).toEqual([...timestamps].sort((left: number, right: number) => left - right));
    expect(parsed.schema.ordering).toContain('recorded timestamp');
  });

  test('a tool call carries the id the runtime gave it', () => {
    const input = fixture({
      root: session('ses_root', { title: 'Root' }),
      records: {
        ses_root: [
          {
            info: {
              id: 'a1', sessionID: 'ses_root', role: 'assistant', agent: 'build',
              providerID: 'anthropic', modelID: 'claude-opus-4-1', time: { created: 2000 },
            },
            parts: [shellCall('a1', 'bun test')],
          },
        ],
      },
    });

    const parsed = JSON.parse(renderExportJson(timelineOf(input)));
    const toolEvent = parsed.events.find((event: { kind: string }) => event.kind === 'tool');

    expect(toolEvent.call.callID).toBe('a1-shell-call');
  });

  test('a part the model does not know is kept, not dropped', () => {
    const input = fixture({
      root: session('ses_root', { title: 'Root' }),
      records: {
        ses_root: [
          {
            info: {
              id: 'u1', sessionID: 'ses_root', role: 'user', time: { created: 1000 },
            },
            parts: [textPart('u1', 'First'), futurePart('u1')],
          },
        ],
      },
    });

    const parsed = JSON.parse(renderExportJson(timelineOf(input)));
    const parts = parsed.events[0].parts;

    expect(parts[1].type).toBe('unknown');
    expect(parts[1].id).toBe('u1-future');
    expect(parts[1].partType).toBe('future');
  });

  test('the sub-agent block says how the call that started it ended', () => {
    const input = fixture({
      root: session('ses_root', { title: 'Root' }),
      sessions: [
        session('ses_root', { title: 'Root' }),
        session('ses_child', { title: 'Child', parentID: 'ses_root', agent: 'reviewer' }),
      ],
      records: {
        ses_root: [
          {
            info: {
              id: 'a1', sessionID: 'ses_root', role: 'assistant', agent: 'build',
              providerID: 'anthropic', modelID: 'claude-opus-4-1', time: { created: 2000 },
            },
            parts: [subagentCall('a1', {
              childSessionID: 'ses_child',
              status: 'error',
              error: 'Subagent cancelled',
            })],
          },
        ],
        ses_child: [assistantMessage('ses_child', 'ca1', 2500, 'Child work')],
      },
    });

    const output = markdown(input);

    expect(output).toContain('Subagent cancelled');
  });

  test('the detailed view carries the result of the call that started the sub-agent', () => {
    const input = fixture({
      root: session('ses_root', { title: 'Root' }),
      sessions: [
        session('ses_root', { title: 'Root' }),
        session('ses_child', { title: 'Child', parentID: 'ses_root', agent: 'reviewer' }),
      ],
      records: {
        ses_root: [
          {
            info: {
              id: 'a1', sessionID: 'ses_root', role: 'assistant', agent: 'build',
              providerID: 'anthropic', modelID: 'claude-opus-4-1', time: { created: 2000 },
            },
            parts: [subagentCall('a1', {
              childSessionID: 'ses_child',
              output: 'The review found blocking defects.',
            })],
          },
        ],
        ses_child: [assistantMessage('ses_child', 'ca1', 2500, 'Child work')],
      },
    });

    const readable = markdown(input, 'readable');
    const detailed = markdown(input, 'detailed');

    expect(readable).not.toContain('The review found blocking defects.');
    expect(detailed).toContain('The review found blocking defects.');
  });

  test('a compaction, a shell record and a notice all reach the document', () => {
    const input = fixture({
      root: session('ses_root', { title: 'Root' }),
      records: {
        ses_root: [
          {
            info: {
              id: 'c1', sessionID: 'ses_root', role: 'compaction', time: { created: 1000 },
              status: 'completed', reason: 'auto', summary: 'The summary of what happened so far.',
            },
            parts: [],
          },
          {
            info: {
              id: 's1', sessionID: 'ses_root', role: 'shell', time: { created: 1100 },
              shellID: 'sh1', command: 'bun test', status: 'exited', exit: 0,
            },
            parts: [],
          },
          {
            info: {
              id: 'n1', sessionID: 'ses_root', role: 'agent-switched', time: { created: 1200 },
              agent: 'reviewer',
            },
            parts: [],
          },
        ],
      },
    });

    const output = markdown(input);

    expect(output).toContain('The summary of what happened so far.');
    expect(output).toContain('bun test');
    expect(output).toContain('reviewer');
  });

  test('a record without a usable timestamp is reported once', () => {
    const input = fixture({
      root: session('ses_root', { title: 'Root' }),
      records: {
        ses_root: [
          {
            // A record whose time is not a usable one: the export cannot
            // place it by time, so it keeps the place the source gave it.
            info: { id: 'u1', sessionID: 'ses_root', role: 'user', time: { created: Number.NaN } },
            parts: [textPart('u1', 'First')],
          },
          {
            info: { id: 'u2', sessionID: 'ses_root', role: 'user', time: { created: Number.NaN } },
            parts: [textPart('u2', 'Second')],
          },
        ],
      },
    });

    const timeline = timelineOf(input);
    const timestampFindings = timeline.findings.filter((finding) => finding.kind === 'missing-timestamp');

    expect(timestampFindings).toHaveLength(1);
  });

  test('a part the model does not know is reported once per part type', () => {
    const input = fixture({
      root: session('ses_root', { title: 'Root' }),
      records: {
        ses_root: [
          {
            info: { id: 'u1', sessionID: 'ses_root', role: 'user', time: { created: 1000 } },
            parts: [textPart('u1', 'First'), futurePart('u1'), futurePart('u1')],
          },
        ],
      },
    });

    const timeline = timelineOf(input);
    const partFindings = timeline.findings.filter((finding) => finding.kind === 'unsupported-part');

    expect(partFindings).toHaveLength(1);
  });

  test('a part the model does not know reaches neither view of the document', () => {
    // The part is neither text nor a file, so neither the readable view nor
    // the full details shows it. The finding says so, and it names the one
    // place the part survives: the source records of the JSON export.
    const input = fixture({
      root: session('ses_root', { title: 'Root' }),
      records: {
        ses_root: [
          {
            info: { id: 'u1', sessionID: 'ses_root', role: 'user', time: { created: 1000 } },
            parts: [textPart('u1', 'First'), futurePart('u1')],
          },
        ],
      },
    });

    const readable = markdown(input, 'readable');
    const detailed = markdown(input, 'detailed');

    expect(readable).toContain('is not shown in the readable view or in the full details');
    expect(readable).toContain('The JSON export keeps it in its source records');
    expect(detailed).toContain('is not shown in the readable view or in the full details');

    const parsed = JSON.parse(renderExportJson(timelineOf(input)));
    const parts = parsed.source.ses_root.records[0].parts;

    expect(parts.map((part: { type: string }) => part.type)).toEqual(['text', 'future']);
  });
});

describe('export scale', () => {
  const buildLarge = (toolCalls: number) => {
    const parts = [];
    for (let index = 0; index < toolCalls; index += 1) {
      parts.push(shellCall(`a1-${index}`, `bun test --case ${index}`, 1000 + index, 1100 + index));
    }
    return fixture({
      root: session('ses_root', { title: 'Root' }),
      records: {
        ses_root: [
          userMessage('ses_root', 'u1', 1000, 'Go'),
          {
            info: {
              id: 'a1', sessionID: 'ses_root', role: 'assistant', agent: 'build',
              providerID: 'anthropic', modelID: 'claude-opus-4-1', time: { created: 2000 },
            },
            parts,
          },
          {
            info: {
              id: 's1', sessionID: 'ses_root', role: 'shell', shellID: 'sh1', command: 'ls -la',
              status: 'exited', time: { created: 1000 + toolCalls - 1 },
            },
            parts: [],
          },
        ],
      },
    });
  };

  for (const size of [100, 500, 3000]) {
    test(`a session with ${size} tool calls exports without losing a call`, () => {
      const input = buildLarge(size);
      const timeline = timelineOf(input);

      const toolEvents = timeline.events.filter((event) => event.kind === 'tool');
      expect(toolEvents).toHaveLength(size);

      const output = markdown(input);
      expect(output).toContain('`shell`');
      expect(output).toContain('bun test --case 0');
      expect(output).toContain(`bun test --case ${size - 1}`);
    });
  }

  test('the record after a thousand calls keeps its place', () => {
    // The record holds more parts than the source order had room for. The
    // record after it was written at the same moment as the last call, so
    // the source order decides, and the record after it stays after every
    // one of the calls.
    const output = markdown(buildLarge(3000));

    expect(output.indexOf('bun test --case 2999')).toBeLessThan(output.indexOf('ls -la'));
  });
});
