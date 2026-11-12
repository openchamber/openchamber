import { describe, expect, test } from 'bun:test';
import type { Session } from '@/lib/opencode/model';
import { getCurrentSessionAssist } from './sessionAssistMetadata';

// SAFETY: fixture carries only the fields getCurrentSessionAssist reads plus the required identity fields.
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

describe('getCurrentSessionAssist', () => {
  test('returns the assist generated after the last turn ended', () => {
    expect(getCurrentSessionAssist(session({ created: 1, updated: 200, idle: 100 }, { suggestion: 'Run the tests', generatedAt: 160 }))?.suggestion)
      .toBe('Run the tests');
  });

  test('a later turn retires it', () => {
    expect(getCurrentSessionAssist(session({ created: 1, updated: 300, idle: 300 }, { suggestion: 'Run the tests', generatedAt: 160 })))
      .toBeNull();
  });

  test('a recap alone is still an assist', () => {
    expect(getCurrentSessionAssist(session({ created: 1, updated: 200, idle: 100 }, { suggestion: '', generatedAt: 160 }))?.recap)
      .toBe('r');
  });

  test('a reverted session has no current assist', () => {
    // SAFETY: the fixture is a Session; only the optional revert field is added.
    const reverted = { ...session({ created: 1, updated: 200, idle: 100 }, { suggestion: 'Run the tests', generatedAt: 160 }), revert: { messageID: 'msg_1' } } as Session;
    expect(getCurrentSessionAssist(reverted)).toBeNull();
  });
});
