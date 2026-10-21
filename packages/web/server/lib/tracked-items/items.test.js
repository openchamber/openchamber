import { describe, expect, it } from 'vitest';
import { parseTrackedItem, trackedItemKey } from './items.js';

describe('tracked items', () => {
  it('keys a gitea item by its instance, never as GitHub', () => {
    const item = parseTrackedItem({
      provider: 'gitea',
      instance: 'https://Gitea.Example.com',
      kind: 'pull',
      owner: 'owner',
      repo: 'repo',
      number: 3,
    });
    expect(item).toMatchObject({ provider: 'gitea', instance: 'https://gitea.example.com' });
    expect(trackedItemKey(item)).toBe('gitea|https://gitea.example.com|pull|owner/repo#3');
  });

  it('keeps gitea and GitHub keys apart for the same repository name', () => {
    const gitea = parseTrackedItem({ provider: 'gitea', instance: 'https://gitea.example.com',
      kind: 'issue', owner: 'owner', repo: 'repo', number: 3 });
    const github = parseTrackedItem({ provider: 'github', kind: 'issue', owner: 'owner', repo: 'repo', number: 3 });
    expect(trackedItemKey(gitea)).not.toBe(trackedItemKey(github));
  });
});
