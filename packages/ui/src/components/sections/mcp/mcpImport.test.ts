import { describe, expect, test } from 'bun:test';

import { parseImportedMcpSnippet } from './mcpImport';

describe('parseImportedMcpSnippet', () => {
  test('imports OpenCode mcp wrapper config', () => {
    const result = parseImportedMcpSnippet(JSON.stringify({
      $schema: 'https://opencode.ai/config.json',
      mcp: {
        stitch: {
          type: 'remote',
          url: 'https://stitch.googleapis.com/mcp',
          enabled: true,
          headers: {
            'X-Goog-Api-Key': 'test-key',
          },
        },
      },
    }));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.name).toBe('stitch');
    expect(result.type).toBe('remote');
    expect(result.url).toBe('https://stitch.googleapis.com/mcp');
    expect(result.disabled).toBe(false);
    expect(result.headers).toEqual([{ key: 'X-Goog-Api-Key', value: 'test-key' }]);
  });

  test('a v1 paste is read: enabled:false, flat timeout, camelCase oauth', () => {
    const result = parseImportedMcpSnippet(JSON.stringify({
      mcp: {
        legacyRemote: {
          type: 'remote',
          url: 'https://legacy.example/mcp',
          enabled: false,
          timeout: 12000,
          oauth: { clientId: 'abc', clientSecret: 'shh', scope: 'read', redirectUri: 'http://localhost/cb' },
        },
      },
    }));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.disabled).toBe(true);
    // v1's single timeout covered the whole request, so it lands on execution.
    expect(result.timeoutExecution).toBe('12000');
    expect(result.timeoutCatalog).toBe('');
    expect(result.oauthEnabled).toBe(true);
    expect(result.oauthClientId).toBe('abc');
    expect(result.oauthClientSecret).toBe('shh');
    expect(result.oauthRedirectUri).toBe('http://localhost/cb');
  });

  test('a v2 paste is read: disabled, split timeouts, snake_case oauth, codemode', () => {
    const result = parseImportedMcpSnippet(JSON.stringify({
      mcp: {
        servers: {
          nativeRemote: {
            type: 'remote',
            url: 'https://native.example/mcp',
            disabled: true,
            codemode: true,
            timeout: { catalog: 30000, execution: 45000 },
            protocol: 'auto',
            oauth: { client_id: 'id', client_secret: 'secret', scope: 'all', callback_port: 4242, auth_server_metadata_url: 'https://auth.example/.well-known/oauth-authorization-server' },
          },
        },
      },
    }));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.name).toBe('nativeRemote');
    expect(result.disabled).toBe(true);
    expect(result.codemode).toBe('on');
    expect(result.timeoutCatalog).toBe('30000');
    expect(result.timeoutExecution).toBe('45000');
    expect(result.oauthEnabled).toBe(true);
    expect(result.oauthClientId).toBe('id');
    expect(result.oauthClientSecret).toBe('secret');
    expect(result.oauthCallbackPort).toBe('4242');
    expect(result.oauthAuthServerMetadataUrl).toBe('https://auth.example/.well-known/oauth-authorization-server');
    expect(result.protocol).toBe('auto');
  });

  test('a paste without codemode leaves the choice to OpenCode', () => {
    const result = parseImportedMcpSnippet(JSON.stringify({ mcp: { servers: { plain: { type: 'remote', url: 'https://x.example/mcp' } } } }));
    if (!result.ok) throw new Error(result.error);
    expect(result.codemode).toBe('default');
    expect(result.protocol).toBe('legacy');
  });

  test('a local v2 server keeps its startup timeout', () => {
    const result = parseImportedMcpSnippet(JSON.stringify({
      mcp: {
        servers: {
          local: {
            type: 'local',
            command: ['npx', '@playwright/mcp'],
            timeout: { startup: 8000, execution: 20000 },
          },
        },
      },
    }));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.type).toBe('local');
    expect(result.timeoutStartup).toBe('8000');
    expect(result.timeoutExecution).toBe('20000');
    expect(result.disabled).toBe(false);
  });

  test('keeps existing mcpServers wrapper support', () => {
    const result = parseImportedMcpSnippet(JSON.stringify({
      mcpServers: {
        localTool: {
          command: 'node server.js',
          args: ['--stdio'],
        },
      },
    }));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.name).toBe('localTool');
    expect(result.type).toBe('local');
    expect(result.command).toEqual(['node', 'server.js', '--stdio']);
  });

  test('rejects multiple OpenCode mcp wrapper entries', () => {
    const result = parseImportedMcpSnippet(JSON.stringify({
      mcp: {
        one: { type: 'remote', url: 'https://one.example/mcp' },
        two: { type: 'remote', url: 'https://two.example/mcp' },
      },
    }));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected import to fail');
    expect(result.error).toContain('Paste one server at a time');
    expect(result.error).toContain('servers in mcp');
  });
});
