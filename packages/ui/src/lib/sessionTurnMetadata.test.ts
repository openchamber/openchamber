import { describe, expect, test } from 'bun:test';
import type { Session } from '@/lib/opencode/model';
import { getRecordedTurnDurationMs } from './sessionTurnMetadata';

const session = (idle: number | undefined, metadata?: Session['metadata']): Session => {
  const record: Session = {
    id: 'a', directory: '/repo', projectID: 'project', title: 'a', cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 },
  };
  if (idle !== undefined) record.time.idle = idle;
  if (metadata) record.metadata = metadata;
  return record;
};

describe('getRecordedTurnDurationMs', () => {
  test('reads the length recorded for the turn that ended at time.idle', () => {
    const recorded = { openchamber: { turn: { endedAt: 50_000, durationMs: 2_417_000 } } };
    expect(getRecordedTurnDurationMs(session(50_000, recorded))).toBe(2_417_000);
    // OpenCode may move idle forward by a millisecond to keep it monotone.
    expect(getRecordedTurnDurationMs(session(50_001, recorded))).toBe(2_417_000);
  });

  test("ignores a record left by an older turn", () => {
    const recorded = { openchamber: { turn: { endedAt: 50_000, durationMs: 2_417_000 } } };
    expect(getRecordedTurnDurationMs(session(90_000, recorded))).toBeUndefined();
    expect(getRecordedTurnDurationMs(session(undefined, recorded))).toBeUndefined();
  });

  test('ignores missing or malformed records', () => {
    expect(getRecordedTurnDurationMs(session(50_000))).toBeUndefined();
    expect(getRecordedTurnDurationMs(session(50_000, { openchamber: { turn: { endedAt: 50_000 } } }))).toBeUndefined();
    expect(getRecordedTurnDurationMs(session(50_000, { openchamber: { turn: { endedAt: 50_000, durationMs: -1 } } }))).toBeUndefined();
  });
});
