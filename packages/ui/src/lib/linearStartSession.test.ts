import { describe, expect, test } from 'bun:test';
import { buildIssueContextText } from './linearStartSession';
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
});
