import { describe, expect, it } from 'vitest';

import { createOpenCodeNetworkRuntime } from './network-runtime.js';

const createRuntime = ({ override = null, openCodePort = null } = {}) => {
  const state = { openCodePort, openCodeBaseUrl: null };
  return createOpenCodeNetworkRuntime({
    state,
    getOpenCodeAuthHeaders: () => ({}),
    resolveUpstreamOverride: override ? () => override : null,
  });
};

describe('network runtime upstream override (docker instances)', () => {
  it('routes every OpenCode-bound URL to the active docker instance origin', () => {
    const runtime = createRuntime({ override: { instanceId: 'docker-1', origin: 'http://127.0.0.1:4567' } });
    expect(runtime.buildOpenCodeUrl('/session')).toBe('http://127.0.0.1:4567/session');
    expect(runtime.buildOpenCodeUrl('/global/event', '')).toBe('http://127.0.0.1:4567/global/event');
  });

  it('the override wins even when a local port is also configured', () => {
    const runtime = createRuntime({ override: { origin: 'http://127.0.0.1:4567' }, openCodePort: 4096 });
    expect(runtime.buildOpenCodeUrl('/session')).toBe('http://127.0.0.1:4567/session');
  });

  it('a null override restores the pre-existing resolution exactly', () => {
    const runtime = createRuntime({ override: null, openCodePort: 4096 });
    expect(runtime.buildOpenCodeUrl('/session')).toBe('http://127.0.0.1:4096/session');
  });

  it('without an override resolver and no local port, URL building still fails closed', () => {
    const runtime = createRuntime({ override: null, openCodePort: null });
    expect(() => runtime.buildOpenCodeUrl('/session')).toThrow(/port is not available/);
  });
});
