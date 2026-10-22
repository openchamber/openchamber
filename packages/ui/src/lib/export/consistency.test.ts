/**
 * The Header export and the Sidebar export must mean the same thing.
 *
 * Both read the same pipeline and the same sessions, so the document they
 * produce for the same session is the same document. The test reads the
 * wiring that makes it so, and the document the pipeline builds.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Session } from '@/lib/opencode/model';
import { renderExportDocument } from '@/lib/exportSession';
import { buildExport, buildExportFromRecords } from '@/lib/export/pipeline';
import { countSubagentTasks, listDescendantSessions } from '@/lib/export/collect';
import { renderExportMarkdown } from '@/lib/export/markdown';
import { assistantMessage, subagentCall, textPart, userMessage, type Record_ } from './fixtures';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The two places that open the export dialog, and the hook they both use.
 *
 * The files are read, not run: the invariant is about the wiring, and the
 * wiring is what the two files say.
 */
const headerSource = readFileSync(join(here, '..', '..', 'components', 'layout', 'Header.tsx'), 'utf-8');
const sidebarSource = readFileSync(join(here, '..', '..', 'components', 'session', 'sidebar', 'sessions', 'SessionNodeItem.tsx'), 'utf-8');
const exportHookSource = readFileSync(join(here, '..', '..', 'components', 'session', 'export', 'useSessionExport.ts'), 'utf-8');

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
  test('the document does not depend on where the export started', () => {
    // The Header and the Sidebar open the same dialog and hand the pipeline
    // the same session, so the document they write is the same document.
    // The target session names it; the rest of it is the history and
    // nothing else.
    const build = (title: string) => buildExportFromRecords({
      root: { id: 'ses_root', title },
      sessions: [
        { id: 'ses_root', title },
        { id: 'ses_child', parentID: 'ses_root', title: 'Child', agent: 'reviewer' },
      ],
      records: new Map([['ses_root', rootRecords], ['ses_child', childRecords]]),
    }, 'readable');

    const first = renderExportDocument(build('Root'), 'markdown', 'readable', 'Root');
    const second = renderExportDocument(build('Renamed'), 'markdown', 'readable', 'Renamed');

    // The heading names the session. Everything below it is the same
    // document, so the title of the target changes nothing else.
    expect(first).toContain('# Root');
    expect(second).toContain('# Renamed');
    const content = (text: string) => text.split('\n').slice(3).join('\n');
    expect(content(second)).toBe(content(first));
  });

  test('the Header and the Sidebar write the export through one path', () => {
    // Both places call the same hook, so the format, the detail level and
    // the coverage are chosen in one place, and the two documents are the
    // same document. The hook builds the document with the one pipeline and
    // writes it with the one renderer.
    expect(headerSource).toContain('useSessionExport()');
    expect(sidebarSource).toContain('useSessionExport()');
    expect(exportHookSource).toContain('buildExport(');
    expect(exportHookSource).toContain('renderExportDocument(');
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

  test('the document carries the sessions the dialog counted', () => {
    // The number the dialog shows and the number the document carries are
    // one: the document holds the root and the descendants the count named.
    const list = sessions.map((session) => ({
      id: session.id,
      title: session.title,
      parentID: session.parentID,
      agent: session.agent,
    }));
    const descendants = listDescendantSessions({ id: 'ses_root', title: 'Root' }, list);
    const result = buildExportFromRecords({
      root: sessions[0],
      sessions: list,
      records: new Map([['ses_root', rootRecords], ['ses_child', childRecords]]),
    }, 'readable');

    expect(result.timeline.sessions.size).toBe(descendants.length + 1);
    expect([...result.timeline.sessions.keys()].sort()).toEqual(['ses_child', 'ses_root']);
  });

  test('a document that leaves the sub-agent transcripts out carries the root alone', () => {
    // The user asked for the root session only, so the document holds the
    // root session and nothing else.
    const result = buildExportFromRecords({
      root: sessions[0],
      sessions: sessions.map((session) => ({
        id: session.id,
        title: session.title,
        parentID: session.parentID,
        agent: session.agent,
      })),
      records: new Map([['ses_root', rootRecords], ['ses_child', childRecords]]),
      includeSubagents: false,
    }, 'readable');

    expect(result.timeline.sessions.size).toBe(1);
    expect(result.timeline.events.some((event) => event.sessionID === 'ses_child')).toBe(false);
  });

  test('the number the dialog shows is the number the document carries', async () => {
    // The dialog counts with the export's own walk: the session list and the
    // children the records name. A child the list does not name is a child
    // the export covers, so it belongs in the count too.
    const list = [{ id: 'ses_root', title: 'Root' }];
    const load = async (sessionID: string) => {
      if (sessionID === 'ses_root') return rootRecords;
      if (sessionID === 'ses_child') return childRecords;
      return null;
    };

    const count = await countSubagentTasks({ root: { id: 'ses_root', title: 'Root' }, sessions: list, load });
    const result = await buildExport({ root: { id: 'ses_root', title: 'Root' }, sessions: list, load }, 'readable');

    // The session list names no child, the root's records name one, and the
    // export covers it: the count says one, and the document carries the
    // root and that child.
    expect(count).toBe(1);
    expect(result.timeline.sessions.size).toBe(2);
    expect(count).toBe(result.timeline.sessions.size - 1);
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
