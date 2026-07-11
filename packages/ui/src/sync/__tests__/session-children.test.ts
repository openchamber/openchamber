import { describe, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';

import { loadSessionChildrenOnDemand, mergeSessionChildren } from '../session-children';

const session = (id: string, parentID?: string): Session => ({
  id,
  slug: id,
  title: id,
  version: '1',
  projectID: 'project_1',
  directory: '/repo',
  time: { created: 1, updated: 1 },
  ...(parentID ? { parentID } : {}),
});

describe('mergeSessionChildren', () => {
  test('adds only children belonging to the explicitly loaded parent', () => {
    const existing = [session('ses_parent')];
    const merged = mergeSessionChildren(existing, [
      session('ses_child', 'ses_parent'),
      session('ses_other_child', 'ses_other'),
    ], 'ses_parent');

    expect(merged.map((item) => item.id)).toEqual(['ses_child', 'ses_parent']);
  });

  test('preserves the session array when the on-demand response adds nothing', () => {
    const existing = [session('ses_child', 'ses_parent'), session('ses_parent')];
    expect(mergeSessionChildren(existing, [session('ses_child', 'ses_parent')], 'ses_parent')).toBe(existing);
  });
});

describe('loadSessionChildrenOnDemand', () => {
  test('coalesces concurrent clicks and reuses a recent successful response', async () => {
    let calls = 0;
    let release: ((sessions: Session[]) => void) | undefined;
    const input = {
      runtimeKey: 'runtime-coalesce',
      directory: '/repo',
      sessionID: 'ses_parent',
      request: () => {
        calls += 1;
        return new Promise<Session[]>((resolve) => {
          release = resolve;
        });
      },
    };

    const first = loadSessionChildrenOnDemand(input);
    const second = loadSessionChildrenOnDemand(input);
    expect(calls).toBe(1);
    release?.([session('ses_child', 'ses_parent')]);
    expect(await first).toEqual(await second);
    expect(await loadSessionChildrenOnDemand(input)).toEqual([session('ses_child', 'ses_parent')]);
    expect(calls).toBe(1);
  });

  test('does not cache a failed on-demand request', async () => {
    let calls = 0;
    const input = {
      runtimeKey: 'runtime-retry',
      directory: '/repo',
      sessionID: 'ses_parent',
      request: async () => {
        calls += 1;
        if (calls === 1) throw new Error('offline');
        return [];
      },
    };

    await expect(loadSessionChildrenOnDemand(input)).rejects.toThrow('offline');
    await loadSessionChildrenOnDemand(input);
    expect(calls).toBe(2);
  });
});
