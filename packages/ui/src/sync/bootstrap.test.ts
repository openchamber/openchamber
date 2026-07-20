import { describe, expect, test } from 'bun:test';
import type { OpencodeClient, Project } from '@opencode-ai/sdk/v2/client';

import { bootstrapDirectory } from './bootstrap';
import { INITIAL_STATE, type State } from './types';

describe('bootstrapDirectory', () => {
  test('scopes the VCS metadata request to the bootstrapped directory', async () => {
    const directory = '/workspace/openchamber';
    const vcsRequests: unknown[] = [];
    let current: State = {
      ...INITIAL_STATE,
      config: {},
      path: { ...INITIAL_STATE.path },
      session_status: {},
    };
    const set = (patch: Partial<State>) => {
      current = { ...current, ...patch };
    };
    const sdk = {
      project: {
        current: async () => ({ data: { id: 'project', worktree: directory } }),
      },
      config: {
        get: async () => ({ data: {} }),
      },
      path: {
        get: async () => ({ data: { ...INITIAL_STATE.path, directory } }),
      },
      session: {
        status: async () => ({ data: {} }),
      },
      command: {
        list: async () => ({ data: [] }),
      },
      mcp: {
        status: async () => ({ data: {} }),
      },
      lsp: {
        status: async () => ({ data: [] }),
      },
      vcs: {
        get: async (input: unknown) => {
          vcsRequests.push(input);
          return { data: { branch: 'feat/branch-diff-scope', default_branch: 'main' } };
        },
      },
      question: {
        list: async () => ({ data: [] }),
      },
      permission: {
        list: async () => ({ data: [] }),
      },
    } as unknown as OpencodeClient;

    await bootstrapDirectory({
      directory,
      sdk,
      getState: () => current,
      set,
      global: {
        config: {},
        projects: [{ id: 'project', worktree: directory } as Project],
      },
      loadSessions: () => undefined,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(vcsRequests).toEqual([{ directory }]);
    expect(current.vcs).toEqual({ branch: 'feat/branch-diff-scope', default_branch: 'main' });
  });
});
