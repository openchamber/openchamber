import { describe, expect, test } from 'bun:test';

import type { Metadata, Session } from '@/lib/opencode/model';
import { getLeadDigest, isLeadSession, leadReplySchema, leadReplyText, withDismissedSuggestions } from './sessionLead';

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

  test('a child that copied its parent\'s lead mark is no lead and shows no digest', () => {
    const metadata = lead({ needsYou: [], now: ['x'], news: [], suggestions: [], updatedAt: 5 }, []);
    expect(isLeadSession(session(metadata))).toBe(true);
    expect(isLeadSession({ ...session(metadata), parentID: 'ses_lead' })).toBe(false);
    expect(getLeadDigest({ ...session(metadata), parentID: 'ses_lead' })).toBeNull();
  });

  test('records a dismissal once, keeps the digest, and leaves a session that is no lead alone', () => {
    const digest = { needsYou: [], now: ['x'], news: [], suggestions: ['Drop v1'], updatedAt: 5 };
    expect(withDismissedSuggestions(lead(digest, ['Drop v1', 'Old']), ['drop v1', 'Speed up CI'])).toEqual(lead(digest, ['Old', 'drop v1', 'Speed up CI']));
    expect(withDismissedSuggestions({ openchamber: {} }, ['x'])).toEqual({ openchamber: {} });
  });
});

describe('lead reply', () => {
  test('reads a single answer sent before replies were batched', () => {
    expect(leadReplySchema.parse({ question: 'Which license?', answer: 'MIT' })).toEqual({ answers: [{ question: 'Which license?', answer: 'MIT' }], suggestions: [] });
  });

  test('tells the lead accepted suggestions join its queue behind the work in progress, and leaves out empty sections', () => {
    const text = leadReplyText({ answers: [], suggestions: [{ item: 'Speed up CI', accepted: true }, { item: 'Drop v1', accepted: false }] });
    expect(text).not.toContain('Answers to your questions');
    expect(text).toContain('join your queue');
    expect(text).toContain('keep the work in progress going first.\n- Speed up CI');
    expect(text).toContain('do not offer them again.\n- Drop v1');
    expect(leadReplyText({ answers: [{ question: 'Which license?', answer: 'MIT' }], suggestions: [] })).toBe(
      'The user replied to your digest.\n\nAnswers to your questions:\n- Question: Which license?\n  Answer: MIT',
    );
  });
});
