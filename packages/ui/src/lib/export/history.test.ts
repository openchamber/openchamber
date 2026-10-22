/**
 * The export's contract about the order and the coverage of the history.
 *
 * These tests read the way the export does: a session tree in, a document
 * out. They cover the cases the redesign has to get right — the place a
 * nested sub-agent's work sits, the order of an event without a timestamp,
 * the text that is glued into one event, the coverage of a session list that
 * does not name every child, and the shell record's own result.
 */

import { describe, expect, test } from 'bun:test';
import type { Session } from '@/lib/opencode/model';
import { buildExport, buildExportFromRecords } from './pipeline';
import { renderExportMarkdown } from './markdown';
import { renderExportHtml } from './html';
import { renderExportJson } from './json';
import type { ExportTimeline } from './events';
import {
  assistantMessage,
  shellCall,
  subagentCall,
  textPart,
  timedTextPart,
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

describe('a nested sub-agent sits where its call sat', () => {
  test('the grandchild work comes before the answer that depends on it', () => {
    // The child delegates, then answers. The grandchild's work belongs
    // between the delegation and the answer, not after the answer.
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
            parts: [subagentCall('a1', { childSessionID: 'ses_child', startedAt: 2000, endedAt: 5000 })],
          },
        ],
        ses_child: [
          {
            info: {
              id: 'ca1', sessionID: 'ses_child', role: 'assistant', agent: 'reviewer',
              providerID: 'anthropic', modelID: 'claude-opus-4-1', time: { created: 2100 },
            },
            parts: [
              textPart('ca1', 'The child speaks first'),
              subagentCall('ca1', { childSessionID: 'ses_grand', sessionID: 'ses_child', startedAt: 2200, endedAt: 3000 }),
            ],
          },
          assistantMessage('ses_child', 'ca2', 4000, 'The answer that depends on the grandchild'),
        ],
        ses_grand: [assistantMessage('ses_grand', 'ga1', 2500, 'Grandchild work')],
      },
    });

    const output = markdown(input);

    const grandchild = output.indexOf('Grandchild work');
    const answer = output.indexOf('The answer that depends on the grandchild');
    const child = output.indexOf('The child speaks first');

    // The grandchild's work sits between the child's own message and the
    // answer that depends on it.
    expect(child).toBeLessThan(grandchild);
    expect(grandchild).toBeLessThan(answer);
  });

  test('the HTML export puts the nested block at the same place', () => {
    const input = fixture({
      root: session('ses_root', { title: 'Root' }),
      sessions: [
        session('ses_root', { title: 'Root' }),
        session('ses_child', { title: 'Child', parentID: 'ses_root', agent: 'reviewer' }),
        session('ses_grand', { title: 'Grand', parentID: 'ses_child', agent: 'explore' }),
      ],
      records: {
        ses_root: [
          {
            info: {
              id: 'a1', sessionID: 'ses_root', role: 'assistant', agent: 'build',
              providerID: 'anthropic', modelID: 'claude-opus-4-1', time: { created: 2000 },
            },
            parts: [subagentCall('a1', { childSessionID: 'ses_child', startedAt: 2000, endedAt: 5000 })],
          },
        ],
        ses_child: [
          {
            info: {
              id: 'ca1', sessionID: 'ses_child', role: 'assistant', agent: 'reviewer',
              providerID: 'anthropic', modelID: 'claude-opus-4-1', time: { created: 2100 },
            },
            parts: [subagentCall('ca1', { childSessionID: 'ses_grand', sessionID: 'ses_child', startedAt: 2200, endedAt: 3000 })],
          },
          assistantMessage('ses_child', 'ca2', 4000, 'The answer that depends on the grandchild'),
        ],
        ses_grand: [assistantMessage('ses_grand', 'ga1', 2500, 'Grandchild work')],
      },
    });

    const { projection, timeline } = build(input);
    const html = renderExportHtml(projection, {
      title: 'Root',
      mode: 'readable',
      findings: timeline.findings,
      sessionCount: timeline.sessions.size,
    });

    expect(html.indexOf('Grandchild work')).toBeLessThan(html.indexOf('The answer that depends on the grandchild'));
  });
});

describe('an event without a timestamp keeps its place', () => {
  test('an undated record stays between the dated ones around it', () => {
    const input = fixture({
      root: session('ses_root', { title: 'Root' }),
      records: {
        ses_root: [
          userMessage('ses_root', 'u1', 1000, 'First'),
          {
            info: { id: 'u2', sessionID: 'ses_root', role: 'user', time: { created: Number.NaN } },
            parts: [textPart('u2', 'Undated')],
          },
          userMessage('ses_root', 'u3', 3000, 'Third'),
        ],
      },
    });

    const output = markdown(input);

    expect(output.indexOf('First')).toBeLessThan(output.indexOf('Undated'));
    expect(output.indexOf('Undated')).toBeLessThan(output.indexOf('Third'));
  });

  test('the JSON export keeps the same order', () => {
    const input = fixture({
      root: session('ses_root', { title: 'Root' }),
      records: {
        ses_root: [
          userMessage('ses_root', 'u1', 1000, 'First'),
          {
            info: { id: 'u2', sessionID: 'ses_root', role: 'user', time: { created: Number.NaN } },
            parts: [textPart('u2', 'Undated')],
          },
          userMessage('ses_root', 'u3', 3000, 'Third'),
        ],
      },
    });

    const parsed = JSON.parse(renderExportJson(timelineOf(input)));
    const texts = parsed.events
      .filter((event: { kind: string }) => event.kind === 'message')
      .map((event: { text: string }) => event.text);

    expect(texts).toEqual(['First', 'Undated', 'Third']);
  });
});

describe('the text of a message keeps the place of its own part', () => {
  test('an answer that came after a tool call stays after it', () => {
    // The text part carries its own time, which is after the call it
    // answers. The answer must not move in front of the work.
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
              timedTextPart('a1', 'The final answer', 3000),
              { ...shellCall('a1', 'bun test', 2000, 2500), id: 'a1-shell' },
            ],
          },
        ],
      },
    });

    const output = markdown(input);

    expect(output.indexOf('`shell`')).toBeLessThan(output.indexOf('The final answer'));
  });

  test('a message and a tool call of the same record keep one scale', () => {
    // The message and the call are two events of one record, and the
    // message's own part says which came first.
    const timeline = timelineOf(fixture({
      root: session('ses_root', { title: 'Root' }),
      records: {
        ses_root: [
          {
            info: {
              id: 'a1', sessionID: 'ses_root', role: 'assistant', agent: 'build',
              providerID: 'anthropic', modelID: 'claude-opus-4-1', time: { created: 2000 },
            },
            parts: [
              timedTextPart('a1', 'Text first', 2100),
              { ...shellCall('a1', 'bun test', 2200, 2300), id: 'a1-shell' },
            ],
          },
        ],
      },
    }));

    const orders = timeline.events
      .filter((event) => event.kind === 'message' || event.kind === 'tool')
      .map((event) => event.origin.sourceOrder);

    // One scale for both kinds: the message's part and the call's part are
    // both inside the same record, so their orders are close together and
    // the message's own part decides between them.
    expect(orders).toHaveLength(2);
    expect(Math.abs(orders[0] - orders[1])).toBeLessThan(1000);
  });

  test('a tool call stays between the texts the record wrote around it', () => {
    // The record says one thing, calls a tool, and says another thing. The
    // text before the call must not move behind it, in either view.
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
              timedTextPart('a1', 'Text before the call', 2000),
              { ...shellCall('a1', 'bun test', 2100, 2150), id: 'a1-shell' },
              timedTextPart('a1', 'Text after the call', 2200, 'a1-text-after'),
            ],
          },
        ],
      },
    });

    for (const mode of ['readable', 'detailed'] as const) {
      const output = markdown(input, mode);

      expect(output.indexOf('Text before the call')).toBeLessThan(output.indexOf('`shell`'));
      expect(output.indexOf('`shell`')).toBeLessThan(output.indexOf('Text after the call'));
    }
  });

  test('the text of a record\'s own parts is still one message', () => {
    // The readable view glues a message's text parts into one message. A
    // file the message carried does not break it apart.
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
              textPart('a1', 'The first half'),
              { id: 'f1', sessionID: 'ses_root', messageID: 'a1', type: 'file', mime: 'text/plain', filename: 'notes.txt', url: 'file:///notes.txt' },
              textPart('a1', 'The second half', 'a1-text-2'),
            ],
          },
        ],
      },
    });

    const timeline = timelineOf(input);
    const messages = timeline.events.filter((event) => event.kind === 'message');

    // One message, and the two halves are glued into it.
    expect(messages).toHaveLength(1);
    expect(messages[0].kind === 'message' ? messages[0].text : '').toContain('The first half');
    expect(messages[0].kind === 'message' ? messages[0].text : '').toContain('The second half');
  });

  test('a record without parts keeps its place between the records with parts', () => {
    // The three records share a time, so the order the source recorded is
    // what decides. A record without parts must not fall behind the record
    // that came before it.
    const input = fixture({
      root: session('ses_root', { title: 'Root' }),
      records: {
        ses_root: [
          {
            info: {
              id: 'a1', sessionID: 'ses_root', role: 'assistant', agent: 'build',
              providerID: 'anthropic', modelID: 'claude-opus-4-1', time: { created: 1000 },
            },
            parts: [textPart('a1', 'First')],
          },
          {
            info: { id: 's1', sessionID: 'ses_root', role: 'system', text: 'The system note', time: { created: 1000 } },
            parts: [],
          },
          {
            info: {
              id: 'a2', sessionID: 'ses_root', role: 'assistant', agent: 'build',
              providerID: 'anthropic', modelID: 'claude-opus-4-1', time: { created: 1000 },
            },
            parts: [textPart('a2', 'Third')],
          },
        ],
      },
    });

    const output = markdown(input);

    expect(output.indexOf('First')).toBeLessThan(output.indexOf('The system note'));
    expect(output.indexOf('The system note')).toBeLessThan(output.indexOf('Third'));
  });
});

describe('the coverage of the sub-agent transcripts', () => {
  test('a background call does not give the child its own short span', () => {
    // A background call settles at once while its child keeps running. The
    // call's own span says nothing about when the work was done, so the
    // child's own activity decides — and two agents that really overlapped
    // are marked as overlapping.
    const backgroundCall = {
      id: 'a1-bg', sessionID: 'ses_root', messageID: 'a1', type: 'tool' as const,
      callID: 'a1-bg-call', tool: 'subagent',
      state: {
        status: 'completed' as const,
        input: { description: 'Background', prompt: 'Do it', agent: 'worker' },
        output: 'started',
        metadata: { status: 'running', sessionID: 'ses_bg' },
        time: { start: 1000, end: 1001 },
      },
    };
    const input = fixture({
      root: session('ses_root', { title: 'Root' }),
      sessions: [
        session('ses_root', { title: 'Root' }),
        session('ses_bg', { title: 'Background', parentID: 'ses_root', agent: 'worker' }),
        session('ses_fg', { title: 'Foreground', parentID: 'ses_root', agent: 'reviewer' }),
      ],
      records: {
        ses_root: [
          {
            info: {
              id: 'a1', sessionID: 'ses_root', role: 'assistant', agent: 'build',
              providerID: 'anthropic', modelID: 'claude-opus-4-1', time: { created: 1000 },
            },
            parts: [
              backgroundCall,
              subagentCall('a1b', { childSessionID: 'ses_fg', startedAt: 1000, endedAt: 9000 }),
            ],
          },
        ],
        ses_bg: [assistantMessage('ses_bg', 'b1', 5000, 'Background work')],
        ses_fg: [assistantMessage('ses_fg', 'f1', 5200, 'Foreground work')],
      },
    });

    const { tree } = build(input);
    const blocks = tree.nodes.filter((node) => node.kind === 'subagent');
    const background = blocks.find((node) => node.kind === 'subagent' && node.childSessionID === 'ses_bg');

    // The background child's span comes from its own activity, not from the
    // call that settled at once.
    expect(background?.kind === 'subagent' && background.startedAt).toBe(5000);
    // The two agents overlapped, so the export says so.
    const output = markdown(input);
    expect(output).toContain('Ran at the same time as');
  });

  test('a child the session list does not name is still loaded', async () => {
    // The session list names the root only. The root's own records name
    // the child, and the child's transcript is there to be read.
    const root = session('ses_root', { title: 'Root' });
    const result = await buildExport({
      root,
      sessions: [root],
      load: async (sessionID) => {
        if (sessionID === 'ses_root') {
          return [{
            info: {
              id: 'a1', sessionID: 'ses_root', role: 'assistant', agent: 'build',
              providerID: 'anthropic', modelID: 'claude-opus-4-1', time: { created: 2000 },
            },
            parts: [subagentCall('a1', { childSessionID: 'ses_hidden' })],
          }];
        }
        if (sessionID === 'ses_hidden') {
          return [assistantMessage('ses_hidden', 'ha1', 2500, 'The hidden child work')];
        }
        return null;
      },
    }, 'readable');

    const document = renderExportMarkdown(result.projection, {
      title: 'Root',
      mode: 'readable',
      findings: result.timeline.findings,
      sessionCount: result.timeline.sessions.size,
    });

    expect(document).toContain('The hidden child work');
    expect(result.timeline.findings.some((finding) => finding.kind === 'ambiguous-invocation')).toBe(false);
  });

  test('a child the user left out is not reported as missing', async () => {
    const root = session('ses_root', { title: 'Root' });
    const result = await buildExport({
      root,
      sessions: [root],
      includeSubagents: false,
      load: async (sessionID) => {
        if (sessionID === 'ses_root') {
          return [{
            info: {
              id: 'a1', sessionID: 'ses_root', role: 'assistant', agent: 'build',
              providerID: 'anthropic', modelID: 'claude-opus-4-1', time: { created: 2000 },
            },
            parts: [subagentCall('a1', { childSessionID: 'ses_child' })],
          }];
        }
        return null;
      },
    }, 'readable');

    // The user asked for the root session only. The child was left out on
    // purpose, so the export does not say it is missing.
    expect(result.timeline.findings.some((finding) => finding.kind === 'ambiguous-invocation')).toBe(false);
    expect(result.timeline.findings.some((finding) => finding.kind === 'unresolved-invocation')).toBe(false);
  });

  test('a child the user left out is not in the document either', async () => {
    // The user asked for the root session alone. The child's transcript must
    // not be in the document, and the document must not say the child is
    // missing: the user left it out on purpose.
    const root = session('ses_root', { title: 'Root' });
    const loaded: string[] = [];
    const result = await buildExport({
      root,
      sessions: [root, session('ses_child', { title: 'Child', parentID: 'ses_root', agent: 'reviewer' })],
      includeSubagents: false,
      load: async (sessionID) => {
        loaded.push(sessionID);
        if (sessionID === 'ses_root') {
          return [{
            info: {
              id: 'a1', sessionID: 'ses_root', role: 'assistant', agent: 'build',
              providerID: 'anthropic', modelID: 'claude-opus-4-1', time: { created: 2000 },
            },
            parts: [subagentCall('a1', { childSessionID: 'ses_child' })],
          }];
        }
        return [assistantMessage('ses_child', 'ca1', 2500, 'The child work')];
      },
    }, 'readable');

    const document = renderExportMarkdown(result.projection, {
      title: 'Root',
      mode: 'readable',
      findings: result.timeline.findings,
      sessionCount: result.timeline.sessions.size,
    });

    // The child's history is not in the document, and it is not even read.
    expect(document).not.toContain('The child work');
    expect(loaded).toEqual(['ses_root']);
    expect(result.timeline.events.some((event) => event.sessionID === 'ses_child')).toBe(false);
    expect(result.projection.some((node) => node.kind === 'subagent')).toBe(false);
    expect(result.timeline.sessions.size).toBe(1);

    // The call that started the child is part of the root's own history, so
    // it stays.
    expect(result.timeline.events.some((event) => event.kind === 'tool')).toBe(true);
  });

  test('a settled call whose child is not there is reported', async () => {
    const root = session('ses_root', { title: 'Root' });
    const result = await buildExport({
      root,
      sessions: [root],
      load: async (sessionID) => {
        if (sessionID === 'ses_root') {
          return [{
            info: {
              id: 'a1', sessionID: 'ses_root', role: 'assistant', agent: 'build',
              providerID: 'anthropic', modelID: 'claude-opus-4-1', time: { created: 2000 },
            },
            parts: [subagentCall('a1', { childSessionID: 'ses_gone' })],
          }];
        }
        return null;
      },
    }, 'readable');

    // The call settled and named a child. The export tried to load that
    // child and could not, so the export says the transcript is missing
    // rather than looking complete.
    const findings = result.timeline.findings;
    expect(findings.some((finding) => finding.kind === 'missing-session')).toBe(true);
    expect(findings.some((finding) => finding.kind === 'missing-session')
      && findings.find((finding) => finding.kind === 'missing-session')?.messageParams?.title).toBe('ses_gone');
  });

  test('a call that is still running names a child that is not there yet', async () => {
    const root = session('ses_root', { title: 'Root' });
    const result = await buildExport({
      root,
      sessions: [root],
      load: async (sessionID) => {
        if (sessionID === 'ses_root') {
          return [{
            info: {
              id: 'a1', sessionID: 'ses_root', role: 'assistant', agent: 'build',
              providerID: 'anthropic', modelID: 'claude-opus-4-1', time: { created: 2000 },
            },
            parts: [subagentCall('a1', { status: 'running', childSessionID: 'ses_running' })],
          }];
        }
        return null;
      },
    }, 'readable');

    // A running call's child has not arrived yet. That is not a gap.
    expect(result.timeline.findings.some((finding) => finding.kind === 'unresolved-invocation')).toBe(false);
  });
});

describe('what the export keeps of a record', () => {
  test('a shell record keeps its output, its status and its exit code', () => {
    const input = fixture({
      root: session('ses_root', { title: 'Root' }),
      records: {
        ses_root: [
          {
            info: {
              id: 's1', sessionID: 'ses_root', role: 'shell', time: { created: 1100 },
              shellID: 'sh1', command: 'bun test', status: 'exited', exit: 1,
              output: { output: '3 tests failed', cursor: 13, size: 13, truncated: false },
            },
            parts: [],
          },
        ],
      },
    });

    const output = markdown(input, 'detailed');

    expect(output).toContain('3 tests failed');
    expect(output).toContain('exited');
    expect(output).toContain('1');
  });

  test('a message with only a file is not dropped', () => {
    const input = fixture({
      root: session('ses_root', { title: 'Root' }),
      records: {
        ses_root: [
          {
            info: { id: 'u1', sessionID: 'ses_root', role: 'user', time: { created: 1000 } },
            parts: [
              { id: 'f1', sessionID: 'ses_root', messageID: 'u1', type: 'file', mime: 'text/plain', filename: 'notes.txt', url: 'file:///notes.txt' },
            ],
          },
        ],
      },
    });

    const output = markdown(input);

    expect(output).toContain('notes.txt');
  });

  test('a sub-agent message keeps the role it was recorded with', () => {
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
        ],
        ses_child: [
          // The child's own task prompt. It is shown as the task.
          userMessage('ses_child', 'cu0', 2050, 'Review the change'),
          // A later user prompt, from a resumed session. It was not the
          // sub-agent speaking, and it does not read as one.
          userMessage('ses_child', 'cu1', 2100, 'A follow-up from the user'),
          assistantMessage('ses_child', 'ca1', 2500, 'The sub-agent answers'),
        ],
      },
    });

    const output = markdown(input);

    // The later user prompt is not the sub-agent speaking.
    expect(output).toContain('· User**');
    expect(output).toContain('A follow-up from the user');
    expect(output).toContain('↳ reviewer');
  });

  test('the first prompt of a sub-agent keeps its files and its time', () => {
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
        ],
        ses_child: [
          {
            info: { id: 'cu1', sessionID: 'ses_child', role: 'user', time: { created: 2100 } },
            parts: [
              { id: 'f1', sessionID: 'ses_child', messageID: 'cu1', type: 'file', mime: 'text/plain', filename: 'brief.txt', url: 'file:///brief.txt' },
            ],
          },
          assistantMessage('ses_child', 'ca1', 2500, 'The sub-agent answers'),
        ],
      },
    });

    const output = markdown(input, 'detailed');

    // A prompt that carried only a file is still a task.
    expect(output).toContain('brief.txt');
  });
});

describe('the HTML export', () => {
  test('a sub-agent transcript folds away', () => {
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

    // The block folds away with a native details element, so the page works
    // without any script.
    expect(html).toContain('<details open><summary><span class="subagent-summary">');
  });

  test('the search index holds the arguments a tool call shows', () => {
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
              state: { status: 'completed', input: { command: 'bun run secret-needle' }, output: 'ok', time: { start: 1, end: 2 } },
            }],
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

    const dataMatch = html.match(/<script type="application\/json" id="export-data">([\s\S]*?)<\/script>/);
    expect(dataMatch).toBeTruthy();
    // SAFETY: the export writes the data block itself, so the match holds
    // the page's own data.
    const data = JSON.parse(dataMatch![1]) as { entries: Array<{ search: string }> };

    expect(data.entries[0].search).toContain('secret-needle');
  });

  test('a tool call belongs to the session that ran it', () => {
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
            parts: [subagentCall('a1', { childSessionID: 'ses_child', agent: 'reviewer' })],
          },
        ],
        ses_child: [
          {
            info: {
              id: 'ca1', sessionID: 'ses_child', role: 'assistant', agent: 'reviewer',
              providerID: 'anthropic', modelID: 'claude-opus-4-1', time: { created: 2100 },
            },
            parts: [shellCall('ca1', 'bun test')],
          },
        ],
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
    const data = JSON.parse(dataMatch![1]) as { entries: Array<{ id: string; kind: string; agent?: string }> };

    const shellEntry = data.entries.find((entry) => entry.kind === 'tool');
    // The shell call ran inside the sub-agent's session, so it belongs to
    // the sub-agent, not to the agent the delegation asked for.
    expect(shellEntry?.agent).toBe('reviewer');
  });

  test('the count is a phrase of the reader\'s language', () => {
    const input = fixture({
      root: session('ses_root', { title: 'Root' }),
      records: {
        ses_root: [userMessage('ses_root', 'u1', 1000, 'Go')],
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
    const data = JSON.parse(dataMatch![1]) as { countLabel: string };

    // The two counts are the numbers of the phrase, and the order of the
    // words is the language's business.
    expect(data.countLabel).toContain('{visible}');
    expect(data.countLabel).toContain('{total}');
  });

  test('a section without a matching entry is hidden', () => {
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

    // The page's own script hides a section whose entries are all hidden.
    expect(html).toContain("section.classList.toggle('hidden', !anyVisible)");
  });

  test('the call that started a sub-agent is searchable', () => {
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
            parts: [subagentCall('a1', { childSessionID: 'ses_child', prompt: 'Find the needle' })],
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
    const data = JSON.parse(dataMatch![1]) as { entries: Array<{ kind: string; search: string }> };

    const callEntry = data.entries.find((entry) => entry.kind === 'call');
    expect(callEntry?.search).toContain('find the needle');
  });
});

describe('a record without a usable time', () => {
  test('a record of any role without a time is reported once', () => {
    // The check covers every role, not only the ones that carry parts.
    const input = fixture({
      root: session('ses_root', { title: 'Root' }),
      records: {
        ses_root: [
          {
            info: {
              id: 's1', sessionID: 'ses_root', role: 'shell', time: { created: Number.NaN },
              shellID: 'sh1', command: 'bun test', status: 'exited', exit: 0,
            },
            parts: [],
          },
          {
            info: {
              id: 'c1', sessionID: 'ses_root', role: 'compaction', time: { created: Number.NaN },
              status: 'completed', reason: 'auto', summary: 'The summary.',
            },
            parts: [],
          },
        ],
      },
    });

    const timeline = timelineOf(input);
    const timestampFindings = timeline.findings.filter((finding) => finding.kind === 'missing-timestamp');

    expect(timestampFindings).toHaveLength(1);
  });
});

describe('the findings speak the reader\'s language', () => {
  test('a finding carries the key of its text and the values it names', () => {
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

    const timeline = timelineOf(input);
    const finding = timeline.findings.find((entry) => entry.kind === 'missing-session');

    expect(finding?.messageKey).toBe('export.finding.missingSession');
    expect(finding?.messageParams?.title).toBe('Child');
  });

  test('the JSON export carries the resolved text beside the key', () => {
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

    const parsed = JSON.parse(renderExportJson(timelineOf(input)));
    const finding = parsed.findings.find((entry: { kind: string }) => entry.kind === 'missing-session');

    expect(finding.detail).toContain('Child');
    expect(finding.messageKey).toBe('export.finding.missingSession');
  });
});
