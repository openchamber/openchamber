import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchSelectionInputs } from './selection-inputs.js';

const agents = [{ id: 'build', mode: 'primary' }];

// OpenCode 2.4 on a location it has just built: every catalog read answers at once with what has loaded,
// and plugin.list stays empty until the plugins have activated.
const coldLocation = ({ activatesAfterPolls = 2, modelList = async () => ({ data: [] }) } = {}) => {
  let polls = 0;
  const active = () => polls >= activatesAfterPolls;
  return {
    plugin: { list: async () => {
      polls += 1;
      return { data: active() ? [{ state: { status: 'active' } }] : [] };
    } },
    model: { list: modelList },
    agent: { list: async () => ({ data: active() ? agents : [] }) },
    config: { get: async () => [] },
  };
};

const read = (client) => fetchSelectionInputs({ client, readSettingsFromDiskMigrated: async () => ({}) });

afterEach(() => {
  vi.useRealTimers();
});

describe('fetchSelectionInputs', () => {
  it('reads the agents of a new location after its plugins have activated', async () => {
    const inputs = await read(coldLocation());
    expect(inputs.agents).toEqual(agents);
    expect(inputs.notReadyReason).toBeNull();
  });

  it('gives a reason when the plugins do not activate in time', async () => {
    vi.useFakeTimers();
    const reading = read(coldLocation({ activatesAfterPolls: Infinity }));
    await vi.advanceTimersByTimeAsync(5_100);
    const inputs = await reading;
    expect(inputs.agents).toEqual([]);
    expect(inputs.notReadyReason).toBe('Location plugins did not finish activating');
  });

  it("passes on the reason an OpenCode before 2.4 gives when its own wait for plugins ran out", async () => {
    const unavailable = { _tag: 'ServiceUnavailableError', service: 'plugin', message: 'Plugins took too long' };
    const inputs = await read(coldLocation({ modelList: async () => Promise.reject(unavailable) }));
    expect(inputs.notReadyReason).toBe('Plugins took too long');
  });

  it.each([
    ['a socket error', new Error('socket hang up')],
    ['another unavailable service', { _tag: 'ServiceUnavailableError', service: 'provider', message: 'Provider is starting' }],
  ])('gives no reason for a model read that failed with %s', async (_, failure) => {
    const inputs = await read(coldLocation({ modelList: async () => Promise.reject(failure) }));
    expect(inputs.notReadyReason).toBeNull();
  });

  it('skips config entries that are not objects and keeps the usable ones', async () => {
    const client = {
      plugin: { list: async () => ({ data: [{ state: { status: 'active' } }] }) },
      model: { list: async () => ({ data: [] }) },
      agent: { list: async () => ({ data: [] }) },
      config: { get: async () => [42, 'text', null, { info: { default_agent: 'build' } }] },
    };
    const inputs = await read(client);
    expect(inputs.config).toEqual({ defaultAgent: 'build', defaultModel: null });
  });
});
