import { describe, expect, test } from 'bun:test';

import type { Metadata, Session } from '@/lib/opencode/model';
import { getLeadDigest, withDismissedSuggestion } from './sessionLead';

type Digest = { needsYou: string[]; now: string[]; news: string[]; suggestions: string[]; updatedAt: number };

const lead = (digest: Digest, dismissed: string[]): Metadata => ({ openchamber: { lead: { at: 1, digest, dismissed } } });

const session = (metadata: Metadata): Session => ({
  id: 'ses_1', projectID: 'project', directory: '/repo', title: 'Lead', cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
  metadata,
});

describe('lead digest', () => {
  test('reads a digest written before questions had answers, and hides what the user dismissed', () => {
    const metadata = lead({ needsYou: ['Keep the old relay?'], now: [], news: [], suggestions: ['Speed up CI', 'Drop v1'], updatedAt: 5 }, ['drop  V1']);
    expect(getLeadDigest(session(metadata))).toMatchObject({
      needsYou: [{ question: 'Keep the old relay?', options: [] }],
      suggestions: ['Speed up CI'],
    });
  });

  test('records a dismissal once, keeps the digest, and leaves a session that is no lead alone', () => {
    const digest = { needsYou: [], now: ['x'], news: [], suggestions: ['Drop v1'], updatedAt: 5 };
    expect(withDismissedSuggestion(lead(digest, ['Drop v1']), 'drop v1')).toEqual(lead(digest, ['drop v1']));
    expect(withDismissedSuggestion({ openchamber: {} }, 'x')).toEqual({ openchamber: {} });
  });
});
