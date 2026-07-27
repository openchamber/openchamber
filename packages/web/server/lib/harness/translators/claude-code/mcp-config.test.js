import { describe, expect, it } from 'bun:test';
import {
  buildClaudeMcpServersFromOpenChamber,
  buildMcpAllowedToolPatterns,
  convertOpenCodeMcpEntryToClaude,
} from './mcp-config.js';

describe('claude mcp-config bridge', () => {
  it('converts local OpenCode MCP entries to Claude stdio configs', () => {
    const converted = convertOpenCodeMcpEntryToClaude({
      type: 'local',
      command: ['npx', '-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
      environment: { FOO: 'bar' },
      enabled: true,
    });
    expect(converted).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
      env: { FOO: 'bar' },
    });
  });

  it('converts remote OpenCode MCP entries to Claude http configs', () => {
    const converted = convertOpenCodeMcpEntryToClaude({
      type: 'remote',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer x' },
    });
    expect(converted).toEqual({
      type: 'http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer x' },
    });
  });

  it('skips disabled and incomplete entries', () => {
    expect(convertOpenCodeMcpEntryToClaude({ type: 'local', enabled: false, command: ['echo'] })).toBeNull();
    expect(convertOpenCodeMcpEntryToClaude({ type: 'local', command: [] })).toBeNull();
    expect(convertOpenCodeMcpEntryToClaude({ type: 'remote' })).toBeNull();
  });

  it('builds mcpServers map from listConfigs', () => {
    const servers = buildClaudeMcpServersFromOpenChamber('/tmp/project', {
      listConfigs: () => ([
        { name: 'fs', type: 'local', command: ['node', 'server.js'], enabled: true },
        { name: 'bad', type: 'local', command: [], enabled: true },
        { name: 'off', type: 'local', command: ['echo'], enabled: false },
      ]),
    });
    expect(servers).toEqual({
      fs: { type: 'stdio', command: 'node', args: ['server.js'] },
    });
    expect(buildMcpAllowedToolPatterns(servers)).toEqual(['mcp__fs__*']);
  });

  it('returns empty map when listConfigs throws', () => {
    const servers = buildClaudeMcpServersFromOpenChamber('/tmp/project', {
      listConfigs: () => {
        throw new Error('boom');
      },
    });
    expect(servers).toEqual({});
  });
});
