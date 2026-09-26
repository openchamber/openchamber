import { describe, expect, it, vi } from 'vitest';

import { loadSourceSections } from './sources.js';
import { createGitExecutionService } from '../git/execution-service.js';

const context = {
  isRepository: true,
  commonId: '/repo/.git',
  worktreeId: '/repo',
};

describe('walkthrough source collection', () => {
  it('forwards cancellation to every working-tree collection step', async () => {
    const controller = new AbortController();
    const git = {
      getDiff: vi.fn(async (_directory, options) => {
        expect(options.signal).toBe(controller.signal);
        return options.staged ? 'staged patch' : 'working patch';
      }),
      listUntrackedPaths: vi.fn(async (_directory, options) => {
        expect(options.signal).toBe(controller.signal);
        return ['new.txt'];
      }),
      getUntrackedDiffs: vi.fn(async (_directory, _paths, options) => {
        expect(options.signal).toBe(controller.signal);
        return ['untracked patch'];
      }),
    };

    await expect(loadSourceSections('/repo', { kind: 'working-tree', scope: 'all' }, {
      git,
      signal: controller.signal,
    })).resolves.toEqual({
      sections: [
        { scope: 'staged', patch: 'staged patch' },
        { scope: 'working', patch: 'working patch\nuntracked patch' },
      ],
      meta: {},
    });
    expect(git.getDiff).toHaveBeenCalledTimes(2);
  });

  it('passes cancellation through the execution facade and releases its read lease', async () => {
    const controller = new AbortController();
    const raw = {
      getDiff: vi.fn((_directory, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { code: 'ABORT_ERR' })), { once: true });
      })),
    };
    const service = createGitExecutionService({
      raw,
      resolver: { resolve: async () => context },
    });

    const pending = loadSourceSections('/repo', { kind: 'working-tree', scope: 'staged' }, {
      git: service,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(raw.getDiff).toHaveBeenCalledWith('/repo', { staged: true, signal: expect.any(AbortSignal) }));
    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: 'GIT_EXECUTION_CANCELLED' });
    await vi.waitFor(() => expect(service.coordinator.getStats()).toMatchObject({ active: 0, pending: 0 }));
  });

  it('forwards cancellation to branch comparison collection', async () => {
    const controller = new AbortController();
    const getRangeDiff = vi.fn(async (_directory, options) => {
      expect(options.signal).toBe(controller.signal);
      return 'branch patch';
    });

    await expect(loadSourceSections('/repo', {
      kind: 'branch',
      baseRef: 'main',
      headRef: 'feature',
    }, { git: { getRangeDiff }, signal: controller.signal })).resolves.toMatchObject({
      sections: [{ scope: 'branch', patch: 'branch patch' }],
    });
  });
});
