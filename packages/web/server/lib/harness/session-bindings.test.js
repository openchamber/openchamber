import { describe, expect, it } from 'vitest';

import { createSessionBindingsRuntime } from './session-bindings.js';

const createMemoryRuntime = () => createSessionBindingsRuntime({
  fsPromises: {
    async readFile() {
      const error = new Error('not found');
      error.code = 'ENOENT';
      throw error;
    },
    async mkdir() {},
    async writeFile() {},
  },
  path: {
    dirname() {
      return '/tmp';
    },
  },
  bindingsFilePath: '/tmp/openchamber-session-bindings.json',
  defaultBackendId: 'opencode',
});

describe('session bindings runtime', () => {
  it('preserves explicit session backend ids when annotating sessions', async () => {
    const runtime = createMemoryRuntime();
    await runtime.ensureLoaded();

    expect(runtime.annotateSession({ id: 'codex-session-1', backendId: 'codex' })).toEqual({
      id: 'codex-session-1',
      backendId: 'codex',
    });
  });

  it('uses the default backend only when the session has no explicit backend id', async () => {
    const runtime = createMemoryRuntime();
    await runtime.ensureLoaded();

    expect(runtime.annotateSession({ id: 'opencode-session-1' })).toEqual({
      id: 'opencode-session-1',
      backendId: 'opencode',
    });
  });
});
