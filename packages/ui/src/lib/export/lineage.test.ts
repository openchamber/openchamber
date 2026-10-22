/**
 * The lineage the export carries.
 *
 * The app attaches the live sessions to a session: the ones whose parent is
 * it, and their own children in turn. The export carries the same tree, so
 * the number the dialog shows and the number of sessions the document
 * carries are one.
 *
 * An archived session is attached to nothing: the app cuts it out of the
 * tree it shows, and so does the export. The session the reader asked for is
 * the exception: they export it on purpose, from wherever they found it, so
 * it is carried and its live descendants travel with it.
 */

import { describe, expect, test } from 'bun:test';
import type { Session } from '@/lib/opencode/model';
import { buildExport, buildExportFromRecords } from './pipeline';
import { listDescendantSessions, readExportSessions } from './collect';
import { renderExportMarkdown } from './markdown';
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

/** The session as the list holds it after it was archived. */
const archived = (entry: Session): Session => ({
  ...entry,
  time: { ...entry.time, archived: 1000 },
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

const grandRecords: Record_[] = [assistantMessage('ses_grand', 'ga1', 2600, 'The grandchild work')];

/** The document the export writes, so the test reads what the reader gets. */
const documentOf = (result: ReturnType<typeof buildExportFromRecords>): string => (
  renderExportMarkdown(result.projection, {
    title: 'Root',
    mode: 'readable',
    findings: result.timeline.findings,
    sessionCount: result.timeline.sessions.size,
  })
);

describe('the lineage the export carries', () => {
  test('a live child is in the document', () => {
    const sessions = readExportSessions([
      session('ses_root', { title: 'Root' }),
      session('ses_child', { title: 'Child', parentID: 'ses_root', agent: 'reviewer' }),
    ]);
    const result = buildExportFromRecords({
      root: sessions[0],
      sessions,
      records: new Map([['ses_root', rootRecords], ['ses_child', childRecords]]),
    }, 'readable');

    expect([...result.timeline.sessions.keys()].sort()).toEqual(['ses_child', 'ses_root']);
    expect(documentOf(result)).toContain('Verdict: changes required.');
  });

  test('an archived child is not in the document', () => {
    // The app does not attach an archived session to its parent, and the
    // sidebar shows no block for it. The export carries the tree the app
    // shows, so the archived child is not in the document either.
    const sessions = readExportSessions([
      session('ses_root', { title: 'Root' }),
      archived(session('ses_child', { title: 'Child', parentID: 'ses_root', agent: 'reviewer' })),
    ]);
    const result = buildExportFromRecords({
      root: sessions[0],
      sessions,
      records: new Map([['ses_root', rootRecords], ['ses_child', childRecords]]),
    }, 'readable');

    expect([...result.timeline.sessions.keys()]).toEqual(['ses_root']);
    expect(result.timeline.events.some((event) => event.sessionID === 'ses_child')).toBe(false);
    expect(documentOf(result)).not.toContain('Verdict: changes required.');
  });

  test('an archived child is not loaded', async () => {
    // The transcript of an archived child is not read at all: the export
    // does not ask the runtime for a history the app does not show.
    const sessions = readExportSessions([
      session('ses_root', { title: 'Root' }),
      archived(session('ses_child', { title: 'Child', parentID: 'ses_root', agent: 'reviewer' })),
    ]);
    const loaded: string[] = [];
    const result = await buildExport({
      root: sessions[0],
      sessions,
      load: async (sessionID) => {
        loaded.push(sessionID);
        if (sessionID === 'ses_root') return rootRecords;
        return childRecords;
      },
    }, 'readable');

    expect(loaded).toEqual(['ses_root']);
    expect(result.timeline.sessions.size).toBe(1);
  });

  test('an archived session cuts the subtree below it', () => {
    // The app cuts an archived child out of the tree at every depth, so the
    // grandchild below it is not in the tree either.
    const sessions = readExportSessions([
      session('ses_root', { title: 'Root' }),
      archived(session('ses_child', { title: 'Child', parentID: 'ses_root', agent: 'reviewer' })),
      session('ses_grand', { title: 'Grand', parentID: 'ses_child', agent: 'explore' }),
    ]);
    const result = buildExportFromRecords({
      root: sessions[0],
      sessions,
      records: new Map([
        ['ses_root', rootRecords],
        ['ses_child', childRecords],
        ['ses_grand', grandRecords],
      ]),
    }, 'readable');

    expect([...result.timeline.sessions.keys()]).toEqual(['ses_root']);
    expect(documentOf(result)).not.toContain('The grandchild work');
  });

  test('an archived session the reader exports is carried with its live descendants', () => {
    // The reader chose this session on purpose, from the archive bin, so it
    // is exported. The work below it that is still live is part of it.
    const sessions = readExportSessions([
      archived(session('ses_root', { title: 'Root' })),
      session('ses_child', { title: 'Child', parentID: 'ses_root', agent: 'reviewer' }),
    ]);
    const result = buildExportFromRecords({
      root: sessions[0],
      sessions,
      records: new Map([['ses_root', rootRecords], ['ses_child', childRecords]]),
    }, 'readable');

    expect([...result.timeline.sessions.keys()].sort()).toEqual(['ses_child', 'ses_root']);
    expect(documentOf(result)).toContain('Verdict: changes required.');
  });

  test('the number the dialog shows is the number of sessions the document carries', () => {
    // The count and the document come from one walk over the live tree, so
    // an archived child is in neither of them.
    const sessions = readExportSessions([
      session('ses_root', { title: 'Root' }),
      session('ses_child', { title: 'Child', parentID: 'ses_root', agent: 'reviewer' }),
      archived(session('ses_archived', { title: 'Archived', parentID: 'ses_root', agent: 'explore' })),
      session('ses_grand', { title: 'Grand', parentID: 'ses_child', agent: 'explore' }),
    ]);
    const count = listDescendantSessions(sessions[0], sessions).length;
    const result = buildExportFromRecords({
      root: sessions[0],
      sessions,
      records: new Map([
        ['ses_root', rootRecords],
        ['ses_child', childRecords],
        ['ses_grand', grandRecords],
      ]),
    }, 'readable');

    expect(count).toBe(2);
    expect(result.timeline.sessions.size).toBe(count + 1);
    expect([...result.timeline.sessions.keys()].sort()).toEqual(['ses_child', 'ses_grand', 'ses_root']);
  });
});
