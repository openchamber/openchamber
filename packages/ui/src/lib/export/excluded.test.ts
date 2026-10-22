/**
 * The sessions the export leaves out on purpose.
 *
 * The export carries the tree the app shows, and an archived session is not
 * in that tree: the app cuts it out, so the export does not carry it either.
 * The document says so as a fact, once: the transcript is not part of the
 * export because the session is not carried along, and not because
 * something was lost.
 *
 * The cases that are a real gap stay gaps: a session that is not there at all
 * and a session whose history could not be loaded are both reported.
 */

import { describe, expect, test } from 'bun:test';
import type { Session } from '@/lib/opencode/model';
import { buildExport, buildExportFromRecords } from './pipeline';
import { readExportSessions } from './collect';
import { renderExportMarkdown } from './markdown';
import { renderExportHtml } from './html';
import { renderExportJson } from './json';
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

/** The document the export writes, so the test reads what the reader gets. */
const documentOf = (result: ReturnType<typeof buildExportFromRecords>): string => (
  renderExportMarkdown(result.projection, {
    title: 'Root',
    mode: 'readable',
    findings: result.timeline.findings,
    excluded: result.timeline.excluded,
    sessionCount: result.timeline.sessions.size,
  })
);

describe('the sessions the export leaves out on purpose', () => {
  test('an archived child named by a call is named as excluded, not as missing', () => {
    // The call is in the exported history and the reader can see it there.
    // The child is archived, so the app does not attach it and the export
    // does not carry it. The document says that, and says nothing else.
    const sessions = readExportSessions([
      session('ses_root', { title: 'Root' }),
      archived(session('ses_child', { title: 'Child', parentID: 'ses_root', agent: 'reviewer' })),
    ]);
    const result = buildExportFromRecords({
      root: sessions[0],
      sessions,
      records: new Map([['ses_root', rootRecords], ['ses_child', childRecords]]),
    }, 'readable');

    const document = documentOf(result);

    expect(result.timeline.findings).toEqual([]);
    expect(document).not.toContain('Incomplete export');
    // The call is in the document, so the export cannot say the child was
    // not tied to a call.
    expect(document).not.toContain('was not tied to a call');
    expect(document).not.toContain('which is not among the exported sessions');
    // The reader learns that the transcript was left out on purpose.
    expect(document).toContain('archived sub-agent session "Child"');
    expect(document).toContain('is not part of this export');

    // The page says the same thing, so the two formats cannot disagree.
    const page = renderExportHtml(result.projection, {
      title: 'Root',
      mode: 'readable',
      findings: result.timeline.findings,
      excluded: result.timeline.excluded,
      sessionCount: result.timeline.sessions.size,
    });
    expect(page).toContain('archived sub-agent session &quot;Child&quot;');
    expect(page).not.toContain('Incomplete export');
  });

  test('the excluded session is not read and not in the document', () => {
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

  test('every excluded session is named, and the reason is the same for all of them', () => {
    // Two archived children: the document names both of them, and it says
    // the same thing about each of them.
    const sessions = readExportSessions([
      session('ses_root', { title: 'Root' }),
      archived(session('ses_child', { title: 'Child', parentID: 'ses_root', agent: 'reviewer' })),
      archived(session('ses_other', { title: 'Other child', parentID: 'ses_root', agent: 'tester' })),
    ]);
    const result = buildExportFromRecords({
      root: sessions[0],
      sessions,
      records: new Map([['ses_root', rootRecords], ['ses_child', childRecords]]),
    }, 'readable');

    const document = documentOf(result);

    expect(result.timeline.excluded.map((entry) => entry.id)).toEqual(['ses_child', 'ses_other']);
    expect(result.timeline.excluded.every((entry) => entry.reason === 'archived')).toBe(true);
    expect(document).toContain('Child, Other child');
    expect(document).not.toContain('Incomplete export');
  });

  test('a child that is not there at all is still reported', async () => {
    // The call names a session the list does not know, and nothing explains
    // where it went. The export says so: the transcript is not part of it.
    const root = session('ses_root', { title: 'Root' });
    const result = await buildExport({
      root,
      sessions: [root],
      load: async (sessionID) => {
        if (sessionID === 'ses_root') return rootRecords;
        return null;
      },
    }, 'readable');

    const document = renderExportMarkdown(result.projection, {
      title: 'Root',
      mode: 'readable',
      findings: result.timeline.findings,
      excluded: result.timeline.excluded,
      sessionCount: result.timeline.sessions.size,
    });

    expect(result.timeline.findings.some((finding) => finding.kind === 'ambiguous-invocation')).toBe(true);
    expect(document).toContain('Incomplete export');
    expect(document).toContain('which is not among the exported sessions');
  });

  test('a child whose history could not be loaded is still reported', async () => {
    // The child is part of the tree the app shows, but its history did not
    // load. That is a hole in the history, and the document says so.
    const root = session('ses_root', { title: 'Root' });
    const result = await buildExport({
      root,
      sessions: [root, session('ses_child', { title: 'Child', parentID: 'ses_root', agent: 'reviewer' })],
      load: async (sessionID) => {
        if (sessionID === 'ses_root') return rootRecords;
        return null;
      },
    }, 'readable');

    const document = renderExportMarkdown(result.projection, {
      title: 'Root',
      mode: 'readable',
      findings: result.timeline.findings,
      excluded: result.timeline.excluded,
      sessionCount: result.timeline.sessions.size,
    });

    expect(result.timeline.findings.some((finding) => finding.kind === 'missing-session')).toBe(true);
    expect(document).toContain('could not be loaded');
    expect(document).toContain('Incomplete export');
  });

  test('the JSON export says which sessions were left out, and why', () => {
    // The audit copy carries the same fact as the readable document: a tool
    // that reads the export sees that the session was left out on purpose
    // and not lost.
    const sessions = readExportSessions([
      session('ses_root', { title: 'Root' }),
      archived(session('ses_child', { title: 'Child', parentID: 'ses_root', agent: 'reviewer' })),
    ]);
    const result = buildExportFromRecords({
      root: sessions[0],
      sessions,
      records: new Map([['ses_root', rootRecords], ['ses_child', childRecords]]),
    }, 'readable');

    const parsed = JSON.parse(renderExportJson(result.timeline));

    expect(parsed.excluded).toEqual([{ id: 'ses_child', title: 'Child', reason: 'archived' }]);
    expect(parsed.findings).toEqual([]);
  });

  test('an export without an excluded session says nothing about one', () => {
    // The note belongs to the document that leaves something out. An export
    // that carries the whole tree says nothing about it.
    const sessions = readExportSessions([
      session('ses_root', { title: 'Root' }),
      session('ses_child', { title: 'Child', parentID: 'ses_root', agent: 'reviewer' }),
    ]);
    const result = buildExportFromRecords({
      root: sessions[0],
      sessions,
      records: new Map([['ses_root', rootRecords], ['ses_child', childRecords]]),
    }, 'readable');

    const document = documentOf(result);

    expect(result.timeline.excluded).toEqual([]);
    expect(document).not.toContain('archived');
  });
});
