import { describe, expect, test } from 'bun:test';
import { trackedItemKey } from './model';

describe('tracked item keys', () => {
  test('keys a gitea item by its instance, never as GitHub', () => {
    expect(trackedItemKey({
      provider: 'gitea',
      instance: 'https://Gitea.Example.com',
      kind: 'pull',
      owner: 'Owner',
      repo: 'Repo',
      number: 3,
    })).toBe('gitea|https://gitea.example.com|pull|owner/repo#3');
  });
});
