/**
 * The Header export and the Sidebar export must mean the same thing.
 *
 * Both read the same pipeline and the same sessions, so the document they
 * produce for the same session is the same document. The test builds the
 * export the way each caller builds it and compares the result.
 */

import { describe, expect, test } from 'bun:test';
import type { Session } from '@/lib/opencode/model';
import { buildExportDocument, formatSessionAsMarkdown } from '@/lib/exportSession';
import { buildExport, buildExportFromRecords } from '@/lib/export/pipeline';
import { listDescendantSessions } from '@/lib/export/collect';
import { renderExportMarkdown } from '@/lib/export/markdown';
import { assistantMessage, subagentCall, textPart, userMessage, type Record_ } from './fixtures';

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

const rootRecords: Record_[] = [
  userMessage('ses_root', 'u1', 1000, 'Do the work'),
  {
    info: {
      id: 'a1', sessionID: 'ses_root', role: 'assistant', agent: 'build',
      providerID: 'anthropic', modelID: 'claude-opus-4-1', time: { created: 2000 },
    },
    parts: [textPart('a1', 'Starting'), subagentCall('a1', { childSessionID: 'ses_child', startedAt: 2000, endedAt: 3000 })],
  },
];

const childRecords: Record_[] = [
  userMessage('ses_child', 'cu1', 2100, 'Review the change'),
  assistantMessage('ses_child', 'ca1', 2500, 'Verdict: changes required.'),
];

const sessions: Session[] = [
  session('ses_root', { title: 'Root' }),
  session('ses_child', { title: 'Child', parentID: 'ses_root', agent: 'reviewer' }),
];

describe('export consistency', () => {
  test('the Header path and the Sidebar path produce the same document', () => {
    // The Header builds the export from the session list and the records it
    // loaded.
    const header = buildExportDocument({
      root: { id: 'ses_root', title: 'Root', createdAt: 0 },
      sessions: [
        { id: 'ses_root', title: 'Root', createdAt: 0 },
        { id: 'ses_child', parentID: 'ses_root', title: 'Child', agent: 'reviewer', createdAt: 0 },
      ],
      records: new Map([['ses_root', rootRecords], ['ses_child', childRecords]]),
    }, 'markdown', 'readable');

    // The Sidebar holds the child tree already and hands it over.
    const sidebar = formatSessionAsMarkdown(rootRecords, 'Root', [{
      id: 'ses_child',
      title: 'Child',
      agent: 'reviewer',
      records: childRecords,
      children: [],
    }], { rootSessionID: 'ses_root' });

    // The two documents differ only in the line that names the export time.
    const withoutHeader = (text: string) => text.split('\n').slice(2).join('\n');
    expect(withoutHeader(header)).toBe(withoutHeader(sidebar));
  });

  test('the same session produces the same document twice', () => {
    const build = () => buildExportFromRecords({
      root: sessions[0],
      sessions,
      records: new Map([['ses_root', rootRecords], ['ses_child', childRecords]]),
    }, 'readable');

    const first = build();
    const second = build();

    expect(renderExportMarkdown(first.projection, {
      title: 'Root',
      mode: 'readable',
      findings: first.timeline.findings,
      sessionCount: first.timeline.sessions.size,
    })).toBe(renderExportMarkdown(second.projection, {
      title: 'Root',
      mode: 'readable',
      findings: second.timeline.findings,
      sessionCount: second.timeline.sessions.size,
    }));
  });

  test('the Header and the Sidebar count the same sub-agent tasks', () => {
    // The dialog counts the sub-agent tasks the export covers, with the
    // walk the export itself uses. The Header has no tree of its own, so
    // both count from the session list.
    const descendants = listDescendantSessions(
      { id: 'ses_root', title: 'Root' },
      sessions.map((session) => ({
        id: session.id,
        title: session.title,
        parentID: session.parentID,
        agent: session.agent,
      })),
    );

    expect(descendants.map((entry) => entry.id)).toEqual(['ses_child']);
  });

  test('the Header export and the Sidebar export carry the same sub-agent transcript', async () => {
    // The Header hands the pipeline the session list and a loader; the
    // Sidebar hands it the same list and the records it holds. The
    // documents must be the same.
    const fromList = await buildExport({
      root: { id: 'ses_root', title: 'Root' },
      sessions: sessions.map((session) => ({
        id: session.id,
        title: session.title,
        parentID: session.parentID,
        agent: session.agent,
      })),
      load: async (sessionID) => {
        if (sessionID === 'ses_root') return rootRecords;
        if (sessionID === 'ses_child') return childRecords;
        return null;
      },
    }, 'readable');

    const fromRecords = buildExportFromRecords({
      root: { id: 'ses_root', title: 'Root' },
      sessions: sessions.map((session) => ({
        id: session.id,
        title: session.title,
        parentID: session.parentID,
        agent: session.agent,
      })),
      records: new Map([['ses_root', rootRecords], ['ses_child', childRecords]]),
    }, 'readable');

    const render = (result: typeof fromList) => renderExportMarkdown(result.projection, {
      title: 'Root',
      mode: 'readable',
      findings: result.timeline.findings,
      sessionCount: result.timeline.sessions.size,
    });

    // The two documents differ only in the line that names the export time.
    const withoutHeader = (text: string) => text.split('\n').slice(2).join('\n');
    expect(withoutHeader(render(fromList))).toBe(withoutHeader(render(fromRecords)));
    expect(render(fromList)).toContain('Verdict: changes required.');
  });
});
