import { describe, it, expect } from 'vitest';
import { buildSlashCommandDefinitions, registerApplicationCommands } from './discord-commands.js';

describe('buildSlashCommandDefinitions', () => {
  const defs = buildSlashCommandDefinitions();

  it('includes the interactive wizard commands and the new /skill command', () => {
    const names = defs.map((d) => d.name);
    for (const name of ['model', 'agent', 'verbosity', 'skill', 'help', 'status', 'sessions']) {
      expect(names).toContain(name);
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

  it('declares options only on the parameterised commands', () => {
    const withOptions = defs.filter((d) => Array.isArray(d.options) && d.options.length > 0);
    expect(withOptions.map((d) => d.name).sort()).toEqual(
      ['fork', 'new-worktree', 'queue', 'resume', 'schedule', 'session', 'shell', 'summary'].sort(),
    );
    const summary = defs.find((d) => d.name === 'summary');
    expect(summary.options[0]).toMatchObject({ name: 'topic', required: false, type: 3 });
    const shell = defs.find((d) => d.name === 'shell');
    expect(shell.options[0]).toMatchObject({ name: 'command', required: true, type: 3 });
    const session = defs.find((d) => d.name === 'session');
    expect(session.options[0]).toMatchObject({ name: 'prompt', required: true, type: 3 });
    const queue = defs.find((d) => d.name === 'queue');
    expect(queue.options[0]).toMatchObject({ name: 'message', required: true, type: 3 });
  });

  it('includes the extended command set', () => {
    const names = defs.map((d) => d.name);
    for (const name of [
      'session', 'resume', 'fork', 'share', 'unshare',
      'queue', 'clear-queue', 'mention-mode',
      'new-worktree', 'merge-worktree',
    ]) {
      expect(names).toContain(name);
    }
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
