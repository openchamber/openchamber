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
    expect(result.enabled).toBe(true);
    expect(result.headers).toEqual([{ key: 'X-Goog-Api-Key', value: 'test-key' }]);
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
