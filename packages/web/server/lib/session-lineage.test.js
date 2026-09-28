import { describe, expect, it } from 'vitest';
import { createSessionLineage } from './session-lineage.js';

const created = (sessionID, parentID) => ({
  type: 'session.created',
  properties: { sessionID, info: parentID ? { id: sessionID, parentID } : { id: sessionID } },
});

describe('session lineage', () => {
  it('learns subsessions and top-level sessions from creation events', () => {
    const lineage = createSessionLineage();
    lineage.observe(created('ses_child', 'ses_parent'));
    lineage.observe(created('ses_root'));

    expect(lineage.isChild('ses_child')).toBe(true);
    expect(lineage.isChild('ses_root')).toBe(false);
    expect(lineage.isChild('ses_unknown')).toBeUndefined();
  });

  it('learns from a record read anyway, and forgets a deleted session', () => {
    const lineage = createSessionLineage();
    lineage.remember('ses_old_child', 'ses_parent');
    expect(lineage.isChild('ses_old_child')).toBe(true);

    lineage.observe({ type: 'session.deleted', properties: { sessionID: 'ses_old_child' } });
    expect(lineage.isChild('ses_old_child')).toBeUndefined();
  });

  it('stays bounded, forgetting the oldest entry first', () => {
    const lineage = createSessionLineage({ limit: 2 });
    lineage.remember('a', 'p');
    lineage.remember('b', 'p');
    lineage.remember('c', null);

    expect(lineage.isChild('a')).toBeUndefined();
    expect(lineage.isChild('b')).toBe(true);
    expect(lineage.isChild('c')).toBe(false);
  });

  it('ignores unrelated events', () => {
    const lineage = createSessionLineage();
    lineage.observe({ type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'idle' } } });
    expect(lineage.isChild('ses_1')).toBeUndefined();
  });
});
