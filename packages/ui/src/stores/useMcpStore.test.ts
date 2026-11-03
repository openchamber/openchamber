import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { opencodeClient } from '@/lib/opencode/client';
import type { McpServerStatus } from '@/lib/opencode/model';
import { useMcpStore } from './useMcpStore';
import { useMcpConfigStore, type McpDraft } from './useMcpConfigStore';

const DIRECTORY = '/workspace/project';

type ServerState = McpServerStatus['status'];

// OpenCode's transitions as a real 2.2.0 host shows them: connect starts the
// server, disconnect leaves it `disabled` until someone connects it again.
let server: ServerState | null;
const spies: Array<{ mockRestore: () => void }> = [];
let disconnects = 0;
let connects = 0;

beforeEach(() => {
  disconnects = 0;
  connects = 0;
  useMcpStore.getState().resetForRuntimeSwitch();
  spies.push(
    spyOn(opencodeClient, 'listMcpServers').mockImplementation(async () => (server ? [{ name: 'lab', status: server }] : [])),
    spyOn(opencodeClient, 'connectMcpServer').mockImplementation(async () => {
      connects += 1;
      server = { status: 'connected' };
    }),
    spyOn(opencodeClient, 'disconnectMcpServer').mockImplementation(async () => {
      disconnects += 1;
      server = { status: 'disabled' };
    }),
  );
});

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

const testFrom = async (before: ServerState | null) => {
  server = before;
  await useMcpStore.getState().refresh({ directory: DIRECTORY, silent: true });
  const result = await useMcpStore.getState().testConnection('lab', DIRECTORY);
  return { result, after: useMcpStore.getState().getStatusForDirectory(DIRECTORY).lab?.status.status };
};

describe('testConnection', () => {
  const repairable: ServerState[] = [
    { status: 'failed', error: 'process exited with code 1' },
    { status: 'needs_auth', error: 'sign in required' },
    { status: 'pending' },
  ];
  for (const before of repairable) {
    test(`a ${before.status} server that now connects stays connected`, async () => {
      const { result, after } = await testFrom(before);

      expect(result.status?.status.status).toBe('connected');
      expect(disconnects).toBe(0);
      expect(after).toBe('connected');
    });
  }

  test('a server with no status held yet stays connected', async () => {
    const { after } = await testFrom(null);

    expect(disconnects).toBe(0);
    expect(after).toBe('connected');
  });

  test('a server the user turned off is turned off again after the test', async () => {
    const { result, after } = await testFrom({ status: 'disabled' });

    expect(result.status?.status.status).toBe('connected');
    expect(disconnects).toBe(1);
    expect(after).toBe('disabled');
  });

  test('a connected server is left connected', async () => {
    const { after } = await testFrom({ status: 'connected' });

    expect(disconnects).toBe(0);
    expect(after).toBe('connected');
  });
});

describe('setEnabled', () => {
  const configStore = useMcpConfigStore.getState();
  let updates: Array<[string, Partial<McpDraft>, string | null | undefined]>;

  // `configured` is what the config file says; null means no file defines it.
  const withConfig = (configured: { disabled?: boolean } | null) => {
    updates = [];
    const entries = configured ? [{ name: 'lab', type: 'local' as const, command: ['lab'], ...configured }] : [];
    useMcpConfigStore.setState({
      serversByDirectory: { [DIRECTORY]: entries },
      loadMcpConfigs: async () => true,
      updateMcp: async (name, config, directory) => {
        updates.push([name, config, directory]);
        return { ok: true };
      },
    });
  };

  afterEach(() => {
    useMcpConfigStore.setState({
      serversByDirectory: {},
      loadMcpConfigs: configStore.loadMcpConfigs,
      updateMcp: configStore.updateMcp,
    });
  });

  test('switching off a configured server writes it off in its config file', async () => {
    withConfig({});
    server = { status: 'connected' };
    await useMcpStore.getState().setEnabled('lab', false, DIRECTORY);

    expect(updates).toEqual([['lab', { disabled: true }, DIRECTORY]]);
    expect(disconnects).toBe(1);
  });

  test('switching on a server its config turns off writes it on', async () => {
    withConfig({ disabled: true });
    server = { status: 'disabled' };
    await useMcpStore.getState().setEnabled('lab', true, DIRECTORY);

    expect(updates).toEqual([['lab', { disabled: false }, DIRECTORY]]);
    expect(connects).toBe(0);
  });

  test('switching on a server its config enables reconnects without a write', async () => {
    withConfig({});
    server = { status: 'failed', error: 'process exited with code 1' };
    await useMcpStore.getState().setEnabled('lab', true, DIRECTORY);

    expect(updates).toEqual([]);
    expect(useMcpStore.getState().getStatusForDirectory(DIRECTORY).lab?.status.status).toBe('connected');
  });

  test('a server no config file defines is only disconnected', async () => {
    withConfig(null);
    server = { status: 'connected' };
    await useMcpStore.getState().setEnabled('lab', false, DIRECTORY);

    expect(updates).toEqual([]);
    expect(disconnects).toBe(1);
  });
});
