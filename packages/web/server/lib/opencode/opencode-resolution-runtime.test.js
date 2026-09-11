import { describe, expect, it } from 'vitest';
import { createOpenCodeResolutionRuntime } from './opencode-resolution-runtime.js';

const createRuntime = () => {
  const resolvedState = {
    resolvedOpencodeBinary: '/usr/local/bin/opencode',
    resolvedOpencodeBinarySource: 'env',
    useWslForOpencode: false,
    resolvedWslBinary: null,
    resolvedWslOpencodePath: null,
    resolvedWslDistro: null,
    resolvedNodeBinary: '/usr/local/bin/node',
    resolvedBunBinary: '/usr/local/bin/bun',
  };
  const runtime = createOpenCodeResolutionRuntime({
    path: { dirname: (value) => value },
    resolveOpencodeCliPath: () => '/usr/local/bin/opencode',
    applyOpencodeBinaryFromSettings: async () => {},
    ensureOpencodeCliEnv: () => {},
    resolveManagedOpenCodeLaunchSpec: () => null,
    getResolvedState: () => resolvedState,
    setResolvedOpencodeBinarySource: () => {},
  });
  return runtime;
};

describe('opencode resolution runtime', () => {
  it('reports the legacy protocol for the stable runtime', async () => {
    const snapshot = await createRuntime().getOpenCodeResolutionSnapshot({ opencodeRuntime: 'stable' });
    expect(snapshot.opencodeRuntime).toBe('stable');
    expect(snapshot.resolvedProtocol).toBe('legacy');
  });

  it('reports no resolved protocol for the beta runtime', async () => {
    const snapshot = await createRuntime().getOpenCodeResolutionSnapshot({ opencodeRuntime: 'beta' });
    expect(snapshot.opencodeRuntime).toBe('beta');
    expect(snapshot.resolvedProtocol).toBeNull();
  });

  it('defaults a missing runtime field to stable with the legacy protocol', async () => {
    const snapshot = await createRuntime().getOpenCodeResolutionSnapshot({});
    expect(snapshot.opencodeRuntime).toBe('stable');
    expect(snapshot.resolvedProtocol).toBe('legacy');
  });

  it('defaults an invalid runtime value to stable with the legacy protocol', async () => {
    const snapshot = await createRuntime().getOpenCodeResolutionSnapshot({ opencodeRuntime: 'canary' });
    expect(snapshot.opencodeRuntime).toBe('stable');
    expect(snapshot.resolvedProtocol).toBe('legacy');
  });
});
