import { describe, expect, test } from 'bun:test';
import { buildIssueContextText } from './linearIssueContext';
import type { LinearIssue } from '@/lib/api/types';

const issue: LinearIssue = {
  id: 'issue-1',
  identifier: 'ENG-12',
  title: 'Broken login',
  url: 'https://linear.app/openchamber/issue/ENG-12',
  description: 'Users cannot sign in.',
  comments: [],
};

describe('buildIssueContextText', () => {
  test('serializes the issue and comments as JSON context', () => {
    const text = buildIssueContextText({
      issue,
      comments: [{
        id: 'comment-1',
        body: 'Still broken',
        createdAt: '2026-08-24T10:00:00.000Z',
        user: { name: 'Ada', displayName: 'Ada Lovelace' },
      }],
    });
    expect(text.startsWith('Linear issue context (JSON)\n')).toBe(true);
    expect(text).toContain('"identifier": "ENG-12"');
    expect(text).toContain('Still broken');
  });

  test('marks the context truncated when Linear holds more comments', () => {
    const text = buildIssueContextText({
      issue: { ...issue, commentsMore: true },
      comments: [],
    });
    expect(text).toContain('only the first 50 comments are included');
  });

  test('leaves the context unmarked with a complete comments page', () => {
    for (const commentsMore of [false, undefined]) {
      const text = buildIssueContextText({
        issue: { ...issue, commentsMore },
        comments: [],
      });
      expect(text.startsWith('Linear issue context (JSON)\n{')).toBe(true);
      expect(text).not.toContain('only the first 50 comments are included');
    }
  });
});
