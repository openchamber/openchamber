import { describe, expect, it } from 'vitest';
import { fetchSelectionInputs } from './selection-inputs.js';

const agents = [{ id: 'build', mode: 'primary' }];

// OpenCode 2.3 on a location it has just built: agent.list answers at once from a registry
// the plugins have not filled yet, model.list answers once they have activated.
const coldLocation = ({ activation = Promise.resolve() } = {}) => {
  let active = false;
  return {
    model: { list: async () => {
      await activation;
      active = true;
      return { data: [] };
    } },
    agent: { list: async () => ({ data: active ? agents : [] }) },
    config: { get: async () => [] },
  };
};

const read = (client) => fetchSelectionInputs({ client, readSettingsFromDiskMigrated: async () => ({}) });

describe('fetchSelectionInputs', () => {
  it('reads the agents of a new location after its plugins have activated', async () => {
    const inputs = await read(coldLocation());
    expect(inputs.agents).toEqual(agents);
    expect(inputs.notReadyReason).toBeNull();
  });

  it("passes on OpenCode's reason when the plugins do not activate in time", async () => {
    const unavailable = { _tag: 'ServiceUnavailableError', service: 'plugin', message: 'Location plugins did not finish activating' };
    const inputs = await read(coldLocation({ activation: Promise.reject(unavailable) }));
    expect(inputs.agents).toEqual([]);
    expect(inputs.notReadyReason).toBe('Location plugins did not finish activating');
  });

  it.each([
    ['a socket error', new Error('socket hang up')],
    ['another unavailable service', { _tag: 'ServiceUnavailableError', service: 'provider', message: 'Provider is starting' }],
  ])('gives no reason for a model read that failed with %s', async (_, failure) => {
    const inputs = await read(coldLocation({ activation: Promise.reject(failure) }));
    expect(inputs.notReadyReason).toBeNull();
  });

  it('skips config entries that are not objects and keeps the usable ones', async () => {
    const client = {
      model: { list: async () => ({ data: [] }) },
      agent: { list: async () => ({ data: [] }) },
      config: { get: async () => [42, 'text', null, { info: { default_agent: 'build' } }] },
    };
    const inputs = await read(client);
    expect(inputs.config).toEqual({ defaultAgent: 'build', defaultModel: null });
  });
});
