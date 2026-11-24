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
let reads = 0;
let statusResponse: Promise<McpServerStatus[]> | null = null;
let connectResponse: Promise<void> | null = null;

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

beforeEach(() => {
  disconnects = 0;
  connects = 0;
  reads = 0;
  statusResponse = null;
  connectResponse = null;
  useMcpStore.getState().resetForRuntimeSwitch();
  spies.push(
    spyOn(opencodeClient, 'listMcpServers').mockImplementation(async () => {
      reads += 1;
      return statusResponse ?? (server ? [{ name: 'lab', status: server }] : []);
    }),
    spyOn(opencodeClient, 'connectMcpServer').mockImplementation(async () => {
      connects += 1;
      await connectResponse;
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

test('concurrent freshness requests share one status read and both receive its result', async () => {
  let release: ((servers: McpServerStatus[]) => void) | undefined;
  statusResponse = new Promise((resolve) => { release = resolve; });
  const store = useMcpStore.getState();
  const options = { directory: DIRECTORY, silent: true, maxAgeMs: 60_000 };
  const first = store.ensureFresh(options);
  const second = store.ensureFresh(options);

  try {
    expect(reads).toBe(1);
  } finally {
    release?.([{ name: 'lab', status: { status: 'connected' } }]);
    await Promise.all([first, second]);
  }
  expect(store.getStatusForDirectory(DIRECTORY).lab?.status.status).toBe('connected');
});

test('a saved OAuth retry publishes an already connected server without reconnecting', async () => {
  const store = useMcpStore.getState();
  const integrationID = 'mcp_lab';
  const failed: McpServerStatus = { name: 'lab', integrationID, status: { status: 'failed', error: 'offline' } };
  const other: McpServerStatus = { name: 'other', status: { status: 'connected' } };
  statusResponse = Promise.resolve([failed, other]);
  await store.refresh({ directory: DIRECTORY, silent: true });

  statusResponse = Promise.resolve([{ ...failed, status: { status: 'connected' } }]);
  await store.reconnectSavedOAuth('lab', DIRECTORY, integrationID, new AbortController().signal);

  expect(store.getStatusForDirectory(DIRECTORY).lab?.status.status).toBe('connected');
  expect(store.getStatusForDirectory(DIRECTORY).other).toBe(other);
  expect(connects).toBe(0);
  expect(reads).toBe(2);
});

for (const fullReadFirst of [true, false]) {
  for (const fullReplyFirst of [true, false]) {
    test(`the newer MCP read wins for the selected server (full read first: ${fullReadFirst}, full reply first: ${fullReplyFirst})`, async () => {
      const store = useMcpStore.getState();
      const integrationID = 'mcp_lab';
      const failed: McpServerStatus = { name: 'lab', integrationID, status: { status: 'failed', error: 'offline' } };
      const pending: McpServerStatus = { name: 'lab', status: { status: 'pending' } };
      const connected: McpServerStatus = { ...failed, status: { status: 'connected' } };
      const other: McpServerStatus = { name: 'other', status: { status: 'connected' } };
      statusResponse = Promise.resolve([failed]);
      await store.refresh({ directory: DIRECTORY, silent: true });

      const full = deferred<McpServerStatus[]>();
      const retry = deferred<McpServerStatus[]>();
      const refresh = () => {
        statusResponse = full.promise;
        return store.refresh({ directory: DIRECTORY, silent: true });
      };
      const reconnect = () => {
        statusResponse = retry.promise;
        return store.reconnectSavedOAuth('lab', DIRECTORY, integrationID, new AbortController().signal);
      };
      const [first, second] = fullReadFirst ? [refresh(), reconnect()] : [reconnect(), refresh()];
      const fullDone = fullReadFirst ? first : second;
      const retryDone = fullReadFirst ? second : first;
      if (fullReplyFirst) {
        full.resolve([pending, other]);
        await fullDone;
      }
      retry.resolve([connected]);
      await retryDone;
      if (!fullReplyFirst) {
        full.resolve([pending, other]);
        await fullDone;
      }

      expect(store.getStatusForDirectory(DIRECTORY).lab).toBe(fullReadFirst ? connected : pending);
      expect(store.getStatusForDirectory(DIRECTORY).other).toBe(other);
      expect(connects).toBe(0);
    });
  }
}

for (const reason of ['selection change', 'runtime switch', 'directory forgotten']) {
  test(`retrying a saved OAuth connection drops the status read after ${reason}`, async () => {
    const store = useMcpStore.getState();
    const controller = new AbortController();
    const response = deferred<McpServerStatus[]>();
    statusResponse = response.promise;
    const attempt = store.reconnectSavedOAuth('lab', DIRECTORY, 'mcp_lab', controller.signal);
    if (reason === 'selection change') controller.abort();
    if (reason === 'runtime switch') store.resetForRuntimeSwitch();
    if (reason === 'directory forgotten') store.forgetDirectory(DIRECTORY);
    response.resolve([{ name: 'lab', integrationID: 'mcp_lab', status: { status: 'needs_auth', error: 'sign in required' } }]);
    await attempt;

    expect(connects).toBe(0);
  });
}

const newerReads: Array<[string, McpServerStatus[], number]> = [
  ['connected', [{ name: 'lab', integrationID: 'mcp_lab', status: { status: 'connected' } }], 0],
  ['disabled', [{ name: 'lab', integrationID: 'mcp_lab', status: { status: 'disabled' } }], 0],
  ['removed', [], 0],
  ['still failed', [{ name: 'lab', integrationID: 'mcp_lab', status: { status: 'failed', error: 'offline' } }], 1],
];
for (const [label, newer, expectedConnects] of newerReads) {
  test(`a delayed saved OAuth failure after a newer read reporting ${label} sends ${expectedConnects} connect requests`, async () => {
    const store = useMcpStore.getState();
    const stale: McpServerStatus = { name: 'lab', integrationID: 'mcp_lab', status: { status: 'needs_auth', error: 'sign in required' } };
    statusResponse = Promise.resolve([stale]);
    await store.refresh({ directory: DIRECTORY, silent: true });

    const retry = deferred<McpServerStatus[]>();
    statusResponse = retry.promise;
    const attempt = store.reconnectSavedOAuth('lab', DIRECTORY, 'mcp_lab', new AbortController().signal);
    statusResponse = Promise.resolve(newer);
    await store.refresh({ directory: DIRECTORY, silent: true });
    retry.resolve([stale]);
    await attempt;

    expect(connects).toBe(expectedConnects);
  });
}

test('a connection started on the previous runtime does not refresh the new runtime', async () => {
  const response = deferred<void>();
  connectResponse = response.promise;
  const store = useMcpStore.getState();
  const attempt = store.connect('lab', DIRECTORY);
  store.resetForRuntimeSwitch();
  response.resolve();
  await attempt;

  expect(reads).toBe(0);
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
