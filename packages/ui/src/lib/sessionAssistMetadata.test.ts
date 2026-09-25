import { describe, expect, test } from 'bun:test';
import type { Session } from '@/lib/opencode/model';
import { getCurrentSessionAssist, getOpenSessionSuggestion } from './sessionAssistMetadata';

// SAFETY: fixture carries only the fields getOpenSessionSuggestion reads plus the required identity fields.
const session = (time: Session['time'], assist: Record<string, string | number>): Session => ({
  id: 'ses_1',
  projectID: 'prj',
  directory: '/repo',
  title: 't',
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time,
  metadata: { openchamber: { assist: { forMessageID: 'msg_1', recap: 'r', ...assist } } },
} as Session);

describe('getOpenSessionSuggestion', () => {
  test('returns the suggestion generated after the last turn ended', () => {
    expect(getOpenSessionSuggestion(session({ created: 1, updated: 200, idle: 100 }, { suggestion: 'Run the tests', generatedAt: 160 })))
      .toBe('Run the tests');
  });

  test('a later turn retires the suggestion', () => {
    expect(getOpenSessionSuggestion(session({ created: 1, updated: 300, idle: 300 }, { suggestion: 'Run the tests', generatedAt: 160 })))
      .toBeNull();
  });

  test('an empty suggestion means nothing is open', () => {
    expect(getOpenSessionSuggestion(session({ created: 1, updated: 200, idle: 100 }, { suggestion: '', generatedAt: 160 })))
      .toBeNull();
  });

  test('a reverted session has no open suggestion', () => {
    // SAFETY: the fixture is a Session; only the optional revert field is added.
    const reverted = { ...session({ created: 1, updated: 200, idle: 100 }, { suggestion: 'Run the tests', generatedAt: 160 }), revert: { messageID: 'msg_1' } } as Session;
    expect(getOpenSessionSuggestion(reverted)).toBeNull();
  });

  test('the chat and the row read the same payload', () => {
    const fresh = session({ created: 1, updated: 200, idle: 100 }, { suggestion: 'Run the tests', generatedAt: 160 });
    const stale = session({ created: 1, updated: 300, idle: 300 }, { suggestion: 'Run the tests', generatedAt: 160 });
    expect(getCurrentSessionAssist(fresh)?.suggestion).toBe(getOpenSessionSuggestion(fresh) ?? undefined);
    expect(getCurrentSessionAssist(stale)).toBeNull();
  });
});
