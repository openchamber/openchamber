import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { McpDraft, McpScope } from './useMcpConfigStore';

/** The parts of the MCP write body these tests make claims about. */
type CapturedMcpBody = {
  scope?: McpScope;
  protocol?: string | null;
  codemode?: boolean | null;
  oauth?: {
    client_id?: string;
    callback_port?: number;
    auth_server_metadata_url?: string;
  } | false;
};

type CapturedRequest = { url: string; method: string; body: CapturedMcpBody };

let captured: CapturedRequest[] = [];
let capturedHeaders = new Headers();
let listResponse: unknown[] = [];

const runtimeFetchMock = async (url: string, init?: RequestInit) => {
  const method = init?.method ?? 'GET';
  if (method === 'GET') {
    return new Response(JSON.stringify(listResponse), { headers: { 'Content-Type': 'application/json' } });
  }
  captured.push({ url, method, body: JSON.parse(String(init?.body ?? '{}')) });
  capturedHeaders = new Headers(init?.headers);
  return new Response(JSON.stringify({}), { headers: { 'Content-Type': 'application/json' } });
};

mock.module('@/lib/runtime-fetch', () => ({ runtimeFetch: runtimeFetchMock }));

mock.module('@/lib/opencode/client', () => ({
  opencodeClient: { getDirectory: () => '/workspace/project' },
}));

mock.module('@/stores/useProjectsStore', () => ({
  useProjectsStore: {
    getState: () => ({ getActiveProject: () => ({ path: '/workspace/project' }) }),
  },
}));

mock.module('@/lib/configUpdate', () => ({
  startConfigUpdate: mock(() => undefined),
  finishConfigUpdate: mock(() => undefined),
  updateConfigUpdateMessage: mock(() => undefined),
}));

mock.module('@/stores/useAgentsStore', () => ({
  refreshAfterOpenCodeRestart: mock(async () => undefined),
}));

const { useMcpConfigStore } = await import('./useMcpConfigStore');

/** What the MCP page hands the store for a remote server with nothing set. */
const remoteDraft = (overrides: Partial<McpDraft> = {}): McpDraft => ({
  name: 'example',
  scope: 'user',
  type: 'remote',
  command: [],
  url: 'https://mcp.example.com',
  environment: [],
  headers: [],
  oauthEnabled: true,
  oauthClientId: '',
  oauthClientSecret: '',
  oauthScope: '',
  oauthRedirectUri: '',
  oauthCallbackPort: '',
  oauthAuthServerMetadataUrl: '',
  protocol: 'legacy',
  timeoutStartup: '',
  timeoutCatalog: '',
  timeoutExecution: '',
  codemode: 'default',
  disabled: false,
  ...overrides,
});

const lastBody = () => captured[captured.length - 1].body;

describe('useMcpConfigStore MCP body', () => {
  beforeEach(() => {
    captured = [];
    listResponse = [];
  });

  for (const scope of ['user', 'project', 'local'] as const) {
    test(`creating a server preserves the ${scope} owner`, async () => {
      // Given
      const draft = remoteDraft({ scope });
      // When
      await useMcpConfigStore.getState().createMcp(draft, '/workspace/selected-project');
      // Then
      expect(captured.map((request) => ({ method: request.method, url: request.url, scope: request.body.scope }))).toEqual([{
        method: 'POST', url: '/api/config/mcp/example?directory=%2Fworkspace%2Fselected-project', scope,
      }]);
    });

    test(`deleting a server sends the expected ${scope} owner`, async () => {
      // Given
      const directory = '/workspace/selected-project';
      // When
      await useMcpConfigStore.getState().deleteMcp('example', directory, scope);
      // Then
      expect(captured).toEqual([{
        method: 'DELETE', url: '/api/config/mcp/example?directory=%2Fworkspace%2Fselected-project', body: { scope },
      }]);
      expect(capturedHeaders.get('Content-Type')).toBe('application/json');
      expect(capturedHeaders.get('x-opencode-directory')).toBe(directory);
    });
  }

  test('saving legacy writes a removal so the config file stays clean', async () => {
    await useMcpConfigStore.getState().updateMcp('example', remoteDraft({ protocol: 'legacy' }));
    expect(lastBody().protocol).toBeNull();
  });

  test('Code Mode default writes a removal so OpenCode decides; on and off write the value', async () => {
    await useMcpConfigStore.getState().updateMcp('example', remoteDraft({ codemode: 'default' }));
    expect(lastBody().codemode).toBeNull();

    await useMcpConfigStore.getState().updateMcp('example', remoteDraft({ codemode: 'on' }));
    expect(lastBody().codemode).toBe(true);

    await useMcpConfigStore.getState().updateMcp('example', remoteDraft({ codemode: 'off' }));
    expect(lastBody().codemode).toBe(false);
  });

  test('saving a non-default protocol writes the value', async () => {
    await useMcpConfigStore.getState().updateMcp('example', remoteDraft({ protocol: 'auto' }));
    expect(lastBody().protocol).toBe('auto');

    await useMcpConfigStore.getState().updateMcp('example', remoteDraft({ protocol: '2026-07-28' }));
    expect(lastBody().protocol).toBe('2026-07-28');
  });

  test('a local server carries the protocol too', async () => {
    await useMcpConfigStore.getState().createMcp(remoteDraft({
      type: 'local',
      url: '',
      command: ['npx', 'some-mcp'],
      protocol: 'auto',
    }));
    expect(lastBody().protocol).toBe('auto');
  });

  test('the metadata URL is written into the oauth block', async () => {
    await useMcpConfigStore.getState().updateMcp('example', remoteDraft({
      oauthAuthServerMetadataUrl: '  https://auth.example.com/.well-known/oauth-authorization-server  ',
    }));
    expect(lastBody().oauth).toEqual({
      auth_server_metadata_url: 'https://auth.example.com/.well-known/oauth-authorization-server',
    });
  });

  test('emptying the metadata URL removes the key but keeps the rest of the block', async () => {
    await useMcpConfigStore.getState().updateMcp('example', remoteDraft({
      oauthClientId: 'id',
      oauthCallbackPort: '4242',
      oauthAuthServerMetadataUrl: '',
    }));
    expect(lastBody().oauth).toEqual({ client_id: 'id', callback_port: 4242 });
  });

  test('a server with OAuth turned off stays off', async () => {
    await useMcpConfigStore.getState().updateMcp('example', remoteDraft({
      oauthEnabled: false,
      oauthAuthServerMetadataUrl: 'https://auth.example.com/meta',
    }));
    expect(lastBody().oauth).toBe(false);
  });
});

describe('useMcpConfigStore round trip', () => {
  beforeEach(() => {
    captured = [];
    listResponse = [];
  });

  test('a stored entry exposes protocol and the metadata URL to the editor', async () => {
    listResponse = [{
      name: 'example',
      type: 'remote',
      url: 'https://mcp.example.com',
      protocol: '2026-07-28',
      oauth: {
        client_id: 'id',
        auth_server_metadata_url: 'https://auth.example.com/meta',
      },
    }];
    await useMcpConfigStore.getState().loadMcpConfigs({ force: true });

    const entry = useMcpConfigStore.getState().getMcpByName('example');
    expect(entry?.protocol).toBe('2026-07-28');
    expect(entry?.type === 'remote' && entry.oauth !== false ? entry.oauth?.auth_server_metadata_url : null)
      .toBe('https://auth.example.com/meta');
  });

  test('a v1 entry without either key still loads', async () => {
    listResponse = [{ name: 'old', type: 'local', command: ['a'], legacy: true }];
    await useMcpConfigStore.getState().loadMcpConfigs({ force: true });

    const entry = useMcpConfigStore.getState().getMcpByName('old');
    expect(entry?.legacy).toBe(true);
    expect(entry?.protocol).toBeUndefined();
  });

  test('a private project entry remains local when loaded and edited', async () => {
    // Given
    listResponse = [{ name: 'example', type: 'remote', url: 'https://mcp.example.com', scope: 'local' }];
    await useMcpConfigStore.getState().loadMcpConfigs({ force: true });
    const entry = useMcpConfigStore.getState().getMcpByName('example');
    // When
    await useMcpConfigStore.getState().updateMcp('example', remoteDraft({ scope: entry?.scope ?? 'user' }));
    // Then
    expect(lastBody().scope).toBe('local');
  });

  test('an invalid owner fails the read without replacing a valid directory snapshot', async () => {
    // Given
    listResponse = [{ name: 'example', type: 'local', command: ['mcp'], scope: 'local' }];
    await useMcpConfigStore.getState().loadMcpConfigs({ force: true });
    listResponse = [{ name: 'other', type: 'local', command: ['mcp'], scope: 'invalid' }];
    // When
    const loaded = await useMcpConfigStore.getState().loadMcpConfigs({ force: true });
    // Then
    expect(loaded).toBe(false);
    expect(useMcpConfigStore.getState().getMcpServersForDirectory()).toEqual([
      { name: 'example', type: 'local', command: ['mcp'], scope: 'local' },
    ]);
  });

  test('deleting a local entry keeps the selected directory and owner inference', async () => {
    // Given
    const directory = '/workspace/selected-project';
    listResponse = [{ name: 'example', type: 'local', command: ['mcp'], scope: 'local' }];
    await useMcpConfigStore.getState().loadMcpConfigs({ force: true, directory });
    listResponse = [];
    // When
    const result = await useMcpConfigStore.getState().deleteMcp('example', directory);
    // Then
    expect(result.ok).toBe(true);
    expect(captured).toEqual([{ method: 'DELETE', url: '/api/config/mcp/example?directory=%2Fworkspace%2Fselected-project', body: {} }]);
  });
});

describe('useMcpConfigStore selection', () => {
  beforeEach(() => {
    useMcpConfigStore.setState({ selectedMcpName: null, selectedProtectedId: null });
  });

  test('selecting a protected connection clears the selected server', () => {
    // Given
    useMcpConfigStore.getState().setSelectedMcp('example');
    // When
    useMcpConfigStore.getState().setSelectedProtected('pmcp_00000000000000a1');
    // Then
    expect(useMcpConfigStore.getState()).toMatchObject({ selectedMcpName: null, selectedProtectedId: 'pmcp_00000000000000a1' });
  });

  test('selecting a server clears the selected protected connection', () => {
    // Given
    useMcpConfigStore.getState().setSelectedProtected('pmcp_00000000000000a1');
    // When
    useMcpConfigStore.getState().setSelectedMcp('example');
    // Then
    expect(useMcpConfigStore.getState()).toMatchObject({ selectedMcpName: 'example', selectedProtectedId: null });
  });

  test('clearing one selection leaves the other', () => {
    // Given
    useMcpConfigStore.setState({ selectedMcpName: 'example', selectedProtectedId: null });
    // When
    useMcpConfigStore.getState().setSelectedProtected(null);
    // Then
    expect(useMcpConfigStore.getState().selectedMcpName).toBe('example');
  });

  test('both selections are persisted and nothing else', () => {
    // Given
    useMcpConfigStore.getState().setSelectedProtected('pmcp_00000000000000a1');
    // When
    const persisted = useMcpConfigStore.persist.getOptions().partialize?.(useMcpConfigStore.getState());
    // Then
    expect(persisted).toEqual({ selectedMcpName: null, selectedProtectedId: 'pmcp_00000000000000a1' });
  });
});
