import { describe, expect, test } from 'bun:test';
import type { GitHistoryItem, GitLogEntry } from '@/lib/api/types';
import {
  formatGitCommitHoverRelativeTime,
  normalizeGitCommitHoverEntry,
} from './gitCommitHoverModel';

const graphEntry: GitHistoryItem = {
  id: 'a'.repeat(40),
  parentIds: ['b'.repeat(40)],
  subject: 'Subject',
  message: 'Subject\n\nBody line one\nBody line two',
  author: 'Ada Lovelace',
  authorEmail: 'ada@example.com',
  timestamp: '2026-08-20T10:00:00.000Z',
  statistics: { files: 2, insertions: 8, deletions: 3 },
  references: [],
};

const historyEntry: GitLogEntry = {
  hash: 'c'.repeat(40),
  parents: [],
  message: 'Subject',
  body: 'Body line one\nBody line two',
  author_name: 'Grace Hopper',
  author_email: 'grace@example.com',
  date: '2026-08-20T11:00:00.000Z',
  refs: '',
  filesChanged: 1,
  insertions: 4,
  deletions: 1,
};

describe('normalizeGitCommitHoverEntry', () => {
  test('normalizes graph entries without duplicating the subject into the body', () => {
    expect(normalizeGitCommitHoverEntry(graphEntry)).toEqual({
      hash: 'a'.repeat(40),
      shortHash: 'aaaaaaa',
      subject: 'Subject',
      body: 'Body line one\nBody line two',
      authorName: 'Ada Lovelace',
      authorEmail: 'ada@example.com',
      timestamp: '2026-08-20T10:00:00.000Z',
      relativeTime: '2026-08-20T10:00:00.000Z',
      statistics: { files: 2, insertions: 8, deletions: 3 },
    });
  });

  test('normalizes history entries with their separate body and statistics fields', () => {
    expect(normalizeGitCommitHoverEntry(historyEntry)).toEqual({
      hash: 'c'.repeat(40),
      shortHash: 'ccccccc',
      subject: 'Subject',
      body: 'Body line one\nBody line two',
      authorName: 'Grace Hopper',
      authorEmail: 'grace@example.com',
      timestamp: '2026-08-20T11:00:00.000Z',
      relativeTime: '2026-08-20T11:00:00.000Z',
      statistics: { files: 1, insertions: 4, deletions: 1 },
    });
  });
});

describe('formatGitCommitHoverRelativeTime', () => {
  test('formats relative time with a supplied locale and clock', () => {
    expect(formatGitCommitHoverRelativeTime('2026-08-20T10:00:00.000Z', {
      locale: 'en-US',
      now: () => Date.parse('2026-08-20T12:00:00.000Z'),
    })).toBe('2 hours ago');
  });

  test('falls back to the original timestamp when parsing fails', () => {
    expect(formatGitCommitHoverRelativeTime('not-a-date', {
      locale: 'en-US',
      now: () => Date.parse('2026-08-20T12:00:00.000Z'),
    })).toBe('not-a-date');
  });
});
