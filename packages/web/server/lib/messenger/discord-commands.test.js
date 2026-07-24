import { describe, it, expect } from 'vitest';
import {
  buildApplicationCommandRegistration,
  buildSlashCommandDefinitions,
  registerApplicationCommands,
  sanitizeDiscordCommandName,
  DISCORD_APPLICATION_COMMAND_LIMIT,
} from './discord-commands.js';
import { isKnownMessengerCommand } from './messenger-commands.js';

describe('buildSlashCommandDefinitions', () => {
  const defs = buildSlashCommandDefinitions();

  it('keeps a compact core slash set under Discord room for optional dynamics', () => {
    expect(defs.length).toBeLessThanOrEqual(35);
    expect(defs.length).toBeGreaterThanOrEqual(20);
  });

  it('includes the interactive wizard commands and high-frequency session controls', () => {
    const names = defs.map((d) => d.name);
    for (const name of [
      'model',
      'agent',
      'verbosity',
      'yolo',
      'permissions',
      'skill',
      'login',
      'help',
      'status',
      'fork',
      'queue',
      'reload-opencode',
    ]) {
      expect(names).toContain(name);
    }
  });

  it('keeps /help description aligned with the slash-only help surface', () => {
    const help = defs.find((d) => d.name === 'help');
    expect(help?.description).toMatch(/slash commands/i);
    expect(help?.description).toMatch(/help all/i);
  });

  it('describes /yolo with the ask / allow-all / follow-agent modes', () => {
    const yolo = defs.find((d) => d.name === 'yolo');
    expect(yolo?.description).toMatch(/ask all/i);
    expect(yolo?.description).toMatch(/allow all/i);
    expect(yolo?.description).toMatch(/follow agent settings/i);
    expect(yolo?.description).not.toMatch(/non-destructive/i);
  });

  it('does not register stub or low-frequency parity commands as native slash', () => {
    const names = new Set(defs.map((d) => d.name));
    for (const name of [
      'add-dir',
      'fork-subagent',
      'restart-opencode-server',
      'add-project',
      'create-new-project',
      'remove-project',
      'tunnel',
      'mcp',
      'worktrees',
      'toggle-worktrees',
      'queue-command',
      'context-usage',
      'session-id',
      'compact',
      'summary',
      'init',
      'review',
      'sessions',
      'unshare',
    ]) {
      expect(names.has(name)).toBe(false);
    }
  });

  it('keeps every description within Discord 100-char limit and marks chat-input type', () => {
    for (const d of defs) {
      expect(d.type).toBe(1);
      expect(typeof d.description).toBe('string');
      expect(d.description.length).toBeGreaterThan(0);
      expect(d.description.length).toBeLessThanOrEqual(100);
    }
  });

  it('declares options only on the parameterised core commands', () => {
    const withOptions = defs.filter((d) => Array.isArray(d.options) && d.options.length > 0);
    expect(withOptions.map((d) => d.name).sort()).toEqual(
      [
        'clear-queue',
        'new-worktree',
        'queue',
        'resume',
        'schedule',
        'session',
        'shell',
      ].sort(),
    );
  });

  it('keeps every registered built-in routable by the messenger command core', () => {
    for (const command of defs) {
      expect(isKnownMessengerCommand(command.name)).toBe(true);
    }
  });
});

describe('dynamic slash command registration helpers', () => {
  it('sanitizes dynamic names with suffixes inside Discord limits', () => {
    expect(sanitizeDiscordCommandName('Review PR!', '-cmd')).toBe('review-pr-cmd');
    expect(sanitizeDiscordCommandName('A'.repeat(80), '-skill')).toHaveLength(32);
    expect(sanitizeDiscordCommandName('!!!', '-cmd')).toBeNull();
  });

  it('skips dynamic registration unless explicitly enabled', () => {
    const dynamic = {
      enabled: false,
      commands: [{ name: 'lint', description: 'Lint' }],
      skills: [{ name: 'theme-system', description: 'Use theme tokens' }],
    };
    const registration = buildApplicationCommandRegistration({ dynamic });
    expect(registration.commands).toEqual(buildSlashCommandDefinitions());
    expect(registration.dynamicCommandMap.size).toBe(0);
  });

  it('keeps built-ins first and caps the total at Discord\'s 100-command limit when enabled', () => {
    const dynamic = {
      enabled: true,
      commands: Array.from({ length: 120 }, (_, i) => ({
        name: `custom command ${i}`,
        description: `Command ${i}`,
      })),
      skills: [{ name: 'theme-system', description: 'Use theme tokens' }],
    };
    const registration = buildApplicationCommandRegistration({ dynamic });
    expect(registration.commands).toHaveLength(DISCORD_APPLICATION_COMMAND_LIMIT);
    const builtInNames = buildSlashCommandDefinitions().map((command) => command.name);
    expect(registration.commands.slice(0, builtInNames.length).map((command) => command.name)).toEqual(builtInNames);
    expect(registration.commands.some((command) => command.name.endsWith('-cmd'))).toBe(true);
  });
});

describe('registerApplicationCommands', () => {
  it('PUTs to the guild-scoped endpoint when a guildId is given', async () => {
    const calls = [];
    const restCall = async (token, method, path, body) => {
      calls.push({ token, method, path, body });
      return { ok: true, status: 200, body: [] };
    };
    const r = await registerApplicationCommands({
      restCall,
      token: 'bot-token',
      applicationId: 'app-1',
      guildId: 'guild-1',
    });
    expect(r).toMatchObject({ ok: true, scope: 'guild' });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('PUT');
    expect(calls[0].path).toBe('/applications/app-1/guilds/guild-1/commands');
    expect(Array.isArray(calls[0].body)).toBe(true);
    expect(calls[0].body.length).toBeLessThanOrEqual(DISCORD_APPLICATION_COMMAND_LIMIT);
  });

  it('PUTs to the global endpoint when no guildId is given', async () => {
    const calls = [];
    const restCall = async (token, method, path, body) => {
      calls.push({ path, body });
      return { ok: true, status: 200, body: [] };
    };
    const r = await registerApplicationCommands({ restCall, token: 't', applicationId: 'app-1' });
    expect(r).toMatchObject({ ok: true, scope: 'global' });
    expect(calls[0].path).toBe('/applications/app-1/commands');
  });

  it('returns a dynamic command map for interaction dispatch when enabled', async () => {
    const restCall = async () => ({ ok: true, status: 200, body: [] });
    const r = await registerApplicationCommands({
      restCall,
      token: 't',
      applicationId: 'app-1',
      dynamic: { enabled: true, skills: [{ name: 'theme-system' }] },
    });
    expect(r.dynamicCommandMap.get('theme-system-skill')).toEqual({
      kind: 'skill',
      name: 'theme-system',
    });
  });

  it('reports a failure (without throwing) when Discord rejects the request', async () => {
    const restCall = async () => ({ ok: false, status: 403, body: 'missing access' });
    const r = await registerApplicationCommands({
      restCall,
      token: 't',
      applicationId: 'app-1',
      guildId: 'g',
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(403);
    expect(r.error).toContain('missing access');
  });

  it('fails cleanly when no application id is known', async () => {
    const r = await registerApplicationCommands({ restCall: async () => ({ ok: true }), token: 't', applicationId: null });
    expect(r.ok).toBe(false);
  });
});
