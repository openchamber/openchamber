import { describe, expect, test } from 'bun:test';
import type { Session } from '@/lib/opencode/model';
import { buildSidebarWorkFacts, EMPTY_SIDEBAR_LIVE_FACTS } from './workFacts';

const session = (metadata: Session['metadata']): Session => ({
  id: 's1', projectID: 'p', directory: '/p', title: 'Nightly triage', cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 2 }, metadata,
});

const factsFor = (record: Session) => buildSidebarWorkFacts(
  { kind: 'session', key: 'session:s1', projectId: 'p', rootSessionId: 's1' },
  { sessionById: new Map([['s1', record]]), childrenMap: new Map(), runKeyBySessionId: new Map(), live: EMPTY_SIDEBAR_LIVE_FACTS, planSessionIds: new Set() },
);

describe('buildSidebarWorkFacts', () => {
  test('a session updated into a new record is read again', () => {
    const before = session({ openchamber: { kind: 'scheduled' } });
    expect(factsFor(before)).toMatchObject({ scheduled: true, inWork: false });
    expect(factsFor(before)).toMatchObject({ scheduled: true, inWork: false });
    const after = session({ openchamber: { kind: 'scheduled', work: { state: 'open', at: 3 } } });
    expect(factsFor(after)).toMatchObject({ scheduled: true, inWork: true });
  });
});
