import { afterEach, describe, expect, it } from 'bun:test';
import {
  CLAUDE_BUILTIN_SLASH_COMMANDS,
  clearSessionCapabilities,
  getOrCreateSessionCapabilities,
  isClaudeSlashCommand,
  resetSessionCapabilities,
  updateSessionCapabilities,
} from './session-capabilities.js';

describe('session-capabilities', () => {
  afterEach(() => {
    resetSessionCapabilities();
  });

  it('returns built-in slash defaults before init', () => {
    const caps = getOrCreateSessionCapabilities('ses_1');
    expect(caps.slashCommands).toEqual([...CLAUDE_BUILTIN_SLASH_COMMANDS]);
    expect(caps.mcpServers).toEqual([]);
    expect(isClaudeSlashCommand('ses_1', 'compact')).toBe(true);
    expect(isClaudeSlashCommand('ses_1', '/usage')).toBe(true);
  });

  it('merges system/init slash, mcp, agents, and skills', () => {
    const caps = updateSessionCapabilities('ses_1', {
      slash_commands: ['compact', 'usage', 'my-skill'],
      skills: ['my-skill'],
      agents: ['code-reviewer'],
      tools: ['Read', 'Agent'],
      mcp_servers: [{ name: 'filesystem', status: 'connected' }],
      session_id: 'foreign_abc',
    });
    expect(caps.slashCommands).toEqual(['compact', 'usage', 'my-skill']);
    expect(caps.skills).toEqual(['my-skill']);
    expect(caps.agents).toEqual(['code-reviewer']);
    expect(caps.tools).toEqual(['Read', 'Agent']);
    expect(caps.mcpServers).toEqual([{ name: 'filesystem', status: 'connected' }]);
    expect(caps.foreignSessionId).toBe('foreign_abc');
    expect(getOrCreateSessionCapabilities('ses_1').mcpServers[0].status).toBe('connected');
  });

  it('keeps prior values when update omits fields', () => {
    updateSessionCapabilities('ses_1', {
      slash_commands: ['compact'],
      mcp_servers: [{ name: 'fs', status: 'failed' }],
    });
    const next = updateSessionCapabilities('ses_1', {
      agents: ['explorer'],
    });
    expect(next.slashCommands).toEqual(['compact']);
    expect(next.mcpServers).toEqual([{ name: 'fs', status: 'failed' }]);
    expect(next.agents).toEqual(['explorer']);
  });

  it('clear removes session snapshot', () => {
    updateSessionCapabilities('ses_1', { slash_commands: ['compact'] });
    clearSessionCapabilities('ses_1');
    expect(getOrCreateSessionCapabilities('ses_1').updatedAt).toBe(0);
  });
});
