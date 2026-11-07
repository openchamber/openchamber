import { describe, expect, test } from 'bun:test';
import type { Session } from '@/lib/opencode/model';
import {
  getBtwOriginalSessionID,
  getBtwSessionID,
  isBtwSession,
  wasPromotedBtwSession,
  withoutBtwSessionLink,
} from './sessionBtwMetadata';

const sessionWith = (metadata: unknown): Session => ({ id: 's', metadata }) as unknown as Session;

describe('legacy btw metadata', () => {
  test('recognizes an old fork and its parent', () => {
    const fork = sessionWith({ openchamber: { kind: 'btw', originalSessionID: 'parent-1' } });
    expect(isBtwSession(fork)).toBe(true);
    expect(getBtwOriginalSessionID(fork)).toBe('parent-1');
    expect(getBtwSessionID(fork)).toBeNull();
  });

  test('recognizes a promoted old fork', () => {
    expect(wasPromotedBtwSession(sessionWith({ openchamber: { btwPromoted: true } }))).toBe(true);
    expect(wasPromotedBtwSession(sessionWith({ openchamber: { kind: 'btw', originalSessionID: 'p' } }))).toBe(false);
  });

  test('reads and clears a legacy parent link', () => {
    const linked = sessionWith({ openchamber: { btwSessionID: 'fork-1', reviewSessionID: 'r-1' } });
    expect(getBtwSessionID(linked)).toBe('fork-1');
    expect(withoutBtwSessionLink(linked.metadata ?? {}, 'fork-2')).toBe(linked.metadata);
    expect(withoutBtwSessionLink(linked.metadata ?? {}, 'fork-1'))
      .toEqual({ openchamber: { reviewSessionID: 'r-1' } });
    expect(withoutBtwSessionLink({ openchamber: { btwSessionID: 'fork-1' } }, 'fork-1')).toEqual({});
  });

  test('a session without metadata is not a legacy fork', () => {
    expect(isBtwSession(null)).toBe(false);
    expect(isBtwSession(sessionWith(undefined))).toBe(false);
    expect(wasPromotedBtwSession(sessionWith(undefined))).toBe(false);
  });
});
