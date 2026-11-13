import { describe, expect, test } from 'bun:test';

import type { GitLogEntry } from '@/lib/api/types';
import { classifyChangeIds, hasChangeIdTrailer } from './changeIdPreflight';

const ID = `I${'a1'.repeat(20)}`;
const entry = (hash: string, message: string, body: string): GitLogEntry => ({
  hash, date: '', message, refs: '', body, author_name: 'A', author_email: 'a@example.com',
  filesChanged: 1, insertions: 1, deletions: 0, parents: [],
});

describe('Change-Id preflight', () => {
  test('reads a Change-Id only from the trailer block', () => {
    expect(hasChangeIdTrailer(`Explains the fix.\n\nChange-Id: ${ID}`)).toBe(true);
    expect(hasChangeIdTrailer(`Change-Id: ${ID}`)).toBe(true);
    expect(hasChangeIdTrailer(`Explains it.\r\n\r\nSigned-off-by: A <a@example.com>\r\nChange-Id: ${ID}\r\n`)).toBe(true);
    // Quoted in the body, followed by more text: not a trailer.
    expect(hasChangeIdTrailer(`Change-Id: ${ID}\n\nMore text after it.`)).toBe(false);
    expect(hasChangeIdTrailer('Change-Id: I123')).toBe(false);
    expect(hasChangeIdTrailer('')).toBe(false);
  });

  test('offers to fix only the checked-out commit, and holds back older commits without one', () => {
    const withId = (hash: string) => entry(hash, `subject ${hash}`, `Change-Id: ${ID}`);
    const without = (hash: string) => entry(hash, `subject ${hash}`, '');
    expect(classifyChangeIds([withId('b'), withId('a')])).toMatchObject({ commits: 2, missing: 'none', subject: 'subject b', tip: 'b' });
    expect(classifyChangeIds([without('b'), withId('a')])).toMatchObject({ missing: 'tip', missingCount: 1, tip: 'b' });
    expect(classifyChangeIds([withId('b'), without('a')])).toMatchObject({ missing: 'many', missingCount: 1 });
    expect(classifyChangeIds([without('b'), without('a')])).toMatchObject({ missing: 'many', missingCount: 2 });
    expect(classifyChangeIds([])).toMatchObject({ commits: 0, missing: 'none', tip: null, subject: null });
  });
});
