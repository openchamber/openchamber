import { describe, it, expect } from 'vitest';
import { createDiscordCommandWizards } from './discord-command-wizards.js';

/** A restCall recorder + a bridge stub backed by fake store + spies. */
function makeHarness({ agents = [], skills = [], providers = [], authMethods = {}, oauthResponse = null } = {}) {
  const calls = [];
  const restCall = async (token, method, path, body) => {
    calls.push({ token, method, path, body });
    return { ok: true, status: 200, body: {} };
  };
  const overrides = [];
  const verbosityDefaults = [];
  const permissionModeDefaults = [];
  const projectDefaults = [];
  const routed = [];
  const activeTurnRefreshes = [];
  const startedOAuth = [];
  const bridge = {
    listAgents: async () => agents,
    listSurfaceSkills: async () => skills,
    fetchProviders: async () => ({ all: providers }),
    listProviderAuthMethods: async () => authMethods,
    startProviderOAuth: async (providerId, methodIndex) => {
      startedOAuth.push({ providerId, methodIndex });
      return oauthResponse ?? {
        ok: true,
        data: { url: 'https://auth.example.com/device', userCode: 'ABC-123' },
      };
    },
    routeInbound: async (args) => {
      routed.push(args);
      return { ok: true };
    },
    applyPreferencesToActiveTurn: (o) => activeTurnRefreshes.push(o),
    store: {
      setOverrides: (o) => overrides.push(o),
      setVerbosityDefault: (type, level) => verbosityDefaults.push({ type, level }),
      setPermissionModeDefault: (type, mode) => permissionModeDefaults.push({ type, mode }),
      setProjectDefaults: (o) => projectDefaults.push(o),
      lookup: () => null,
    },
  };
  const wizards = createDiscordCommandWizards({ restCall, bridge });
  return {
    wizards,
    bridge,
    calls,
    overrides,
    verbosityDefaults,
    permissionModeDefaults,
    projectDefaults,
    routed,
    activeTurnRefreshes,
    startedOAuth,
  };
}

function customIdOf(call) {
  return call.body?.data?.components?.[0]?.components?.[0]?.custom_id;
}
function optionValues(call) {
  return call.body?.data?.components?.[0]?.components?.[0]?.options?.map((o) => o.value) ?? [];
}
function optionLabels(call) {
  return call.body?.data?.components?.[0]?.components?.[0]?.options?.map((o) => o.label) ?? [];
}

const state = { token: 'bot-token' };
const interaction = { id: 'i1', token: 't1', channel_id: 'chan-1', guild_id: 'g1', application_id: 'app' };

describe('verbosity wizard', () => {
  it('level → "this conversation" scope writes a surface override', async () => {
    const { wizards, calls, overrides, verbosityDefaults } = makeHarness();

    await wizards.startVerbosity(state, interaction);
    const levelCustomId = customIdOf(calls.at(-1));
    expect(wizards.ownsComponent(levelCustomId)).toBe(true);
    expect(optionValues(calls.at(-1))).toEqual(['quiet', 'normal', 'verbose']);
    expect(optionLabels(calls.at(-1))).toEqual(['quiet', 'default', 'verbose']);

    await wizards.handleComponent(state, { id: 'i2', token: 't2', data: { values: ['verbose'] } }, levelCustomId);
    const scopeCustomId = customIdOf(calls.at(-1));
    expect(optionValues(calls.at(-1))).toEqual(['surface', 'project', 'global']);

    await wizards.handleComponent(state, { id: 'i3', token: 't3', data: { values: ['surface'] } }, scopeCustomId);
    expect(overrides).toEqual([
      { type: 'discord', botTokenHash: expect.any(String), targetKey: 'chan-1', verbosityOverride: 'verbose' },
    ]);
    expect(verbosityDefaults).toHaveLength(0);
    expect(calls.at(-1).body.data.content).toContain('verbose');
  });

  it('level → "whole system" scope writes the messenger default', async () => {
    const { wizards, calls, overrides, verbosityDefaults } = makeHarness();
    await wizards.startVerbosity(state, interaction);
    const levelCustomId = customIdOf(calls.at(-1));
    await wizards.handleComponent(state, { id: 'i2', token: 't2', data: { values: ['quiet'] } }, levelCustomId);
    const scopeCustomId = customIdOf(calls.at(-1));
    await wizards.handleComponent(state, { id: 'i3', token: 't3', data: { values: ['global'] } }, scopeCustomId);
    expect(verbosityDefaults).toEqual([{ type: 'discord', level: 'quiet' }]);
    expect(overrides).toHaveLength(0);
  });

  it('level → "project" scope writes a project default when a project is bound', async () => {
    const { wizards, bridge, calls, overrides, projectDefaults } = makeHarness();
    // The project scope needs the channel to resolve to a project binding.
    bridge.store.lookup = () => ({ projectPath: '/proj', projectLabel: 'Proj' });
    await wizards.startVerbosity(state, interaction);
    const levelCustomId = customIdOf(calls.at(-1));
    await wizards.handleComponent(state, { id: 'i2', token: 't2', data: { values: ['verbose'] } }, levelCustomId);
    const scopeCustomId = customIdOf(calls.at(-1));
    await wizards.handleComponent(state, { id: 'i3', token: 't3', data: { values: ['project'] } }, scopeCustomId);
    expect(projectDefaults).toEqual([
      { projectPath: '/proj', projectLabel: 'Proj', verbosityDefault: 'verbose' },
    ]);
    expect(overrides).toHaveLength(0);
  });
});

describe('permissions (/yolo) wizard', () => {
  it('mode → "this conversation" scope writes a surface override', async () => {
    const { wizards, calls, overrides, permissionModeDefaults } = makeHarness();

    await wizards.startPermissions(state, interaction);
    const modeCustomId = customIdOf(calls.at(-1));
    expect(wizards.ownsComponent(modeCustomId)).toBe(true);
    expect(optionValues(calls.at(-1))).toEqual(['ask', 'yolo', 'agent']);

    await wizards.handleComponent(state, { id: 'i2', token: 't2', data: { values: ['yolo'] } }, modeCustomId);
    const scopeCustomId = customIdOf(calls.at(-1));
    expect(optionValues(calls.at(-1))).toEqual(['surface', 'project', 'global']);

    await wizards.handleComponent(state, { id: 'i3', token: 't3', data: { values: ['surface'] } }, scopeCustomId);
    expect(overrides).toEqual([
      { type: 'discord', botTokenHash: expect.any(String), targetKey: 'chan-1', permissionModeOverride: 'yolo' },
    ]);
    expect(permissionModeDefaults).toHaveLength(0);
    expect(calls.at(-1).body.data.content).toContain('Allow all');
  });

  it('mode → "whole system" scope writes the messenger default', async () => {
    const { wizards, calls, overrides, permissionModeDefaults } = makeHarness();
    await wizards.startPermissions(state, interaction);
    const modeCustomId = customIdOf(calls.at(-1));
    await wizards.handleComponent(state, { id: 'i2', token: 't2', data: { values: ['agent'] } }, modeCustomId);
    const scopeCustomId = customIdOf(calls.at(-1));
    await wizards.handleComponent(state, { id: 'i3', token: 't3', data: { values: ['global'] } }, scopeCustomId);
    expect(permissionModeDefaults).toEqual([{ type: 'discord', mode: 'agent' }]);
    expect(overrides).toHaveLength(0);
  });

  it('mode → "project" scope writes a project default when bound', async () => {
    const { wizards, bridge, calls, projectDefaults } = makeHarness();
    bridge.store.lookup = () => ({ projectPath: '/proj', projectLabel: 'Proj' });
    await wizards.startPermissions(state, interaction);
    const modeCustomId = customIdOf(calls.at(-1));
    await wizards.handleComponent(state, { id: 'i2', token: 't2', data: { values: ['yolo'] } }, modeCustomId);
    const scopeCustomId = customIdOf(calls.at(-1));
    await wizards.handleComponent(state, { id: 'i3', token: 't3', data: { values: ['project'] } }, scopeCustomId);
    expect(projectDefaults).toEqual([
      { projectPath: '/proj', projectLabel: 'Proj', permissionModeDefault: 'yolo' },
    ]);
  });
});

describe('verbosity wizard applies to the active turn', () => {
  it('refreshes the streaming turn after a scope is chosen', async () => {
    const { wizards, calls, activeTurnRefreshes } = makeHarness();
    await wizards.startVerbosity(state, interaction);
    const levelCustomId = customIdOf(calls.at(-1));
    await wizards.handleComponent(state, { id: 'i2', token: 't2', data: { values: ['verbose'] } }, levelCustomId);
    const scopeCustomId = customIdOf(calls.at(-1));
    await wizards.handleComponent(state, { id: 'i3', token: 't3', data: { values: ['surface'] } }, scopeCustomId);
    expect(activeTurnRefreshes).toEqual([
      { type: 'discord', token: 'bot-token', channelId: 'chan-1', threadId: null },
    ]);
  });
});

describe('login wizard', () => {
  const providers = [
    { id: 'anthropic', name: 'Anthropic' },
    { id: 'openai', name: 'OpenAI' },
  ];

  it('provider pick → OAuth method starts the OpenCode OAuth flow', async () => {
    const { wizards, calls, startedOAuth } = makeHarness({
      providers,
      authMethods: {
        anthropic: [{ type: 'oauth', label: 'OAuth' }],
      },
    });

    await wizards.startLogin(state, interaction);
    const providerCustomId = customIdOf(calls.at(-1));
    expect(optionValues(calls.at(-1))).toEqual(['anthropic', 'openai']);

    await wizards.handleComponent(state, { id: 'i2', token: 't2', data: { values: ['anthropic'] } }, providerCustomId);
    const methodCustomId = customIdOf(calls.at(-1));
    expect(optionValues(calls.at(-1))).toEqual(['oauth:0', 'api']);

    await wizards.handleComponent(state, { id: 'i3', token: 't3', data: { values: ['oauth:0'] } }, methodCustomId);
    expect(startedOAuth).toEqual([{ providerId: 'anthropic', methodIndex: 0 }]);
    expect(calls.at(-1).body.data.content).toContain('https://auth.example.com/device');
    expect(calls.at(-1).body.data.content).toContain('ABC-123');
  });

  it('provider pick → API key method returns Settings guidance without collecting secrets', async () => {
    const { wizards, calls, startedOAuth } = makeHarness({
      providers,
      authMethods: { openai: [{ type: 'api', label: 'API key' }] },
    });

    await wizards.startLogin(state, interaction);
    const providerCustomId = customIdOf(calls.at(-1));
    await wizards.handleComponent(state, { id: 'i2', token: 't2', data: { values: ['openai'] } }, providerCustomId);
    const methodCustomId = customIdOf(calls.at(-1));
    await wizards.handleComponent(state, { id: 'i3', token: 't3', data: { values: ['api'] } }, methodCustomId);

    expect(startedOAuth).toHaveLength(0);
    expect(calls.at(-1).body.data.content).toContain('Settings → Providers');
    expect(calls.at(-1).body.data.content).toContain('Discord never asks');
  });
});

describe('agent wizard', () => {
  const agents = [
    { name: 'build', description: 'coding agent' },
    { name: 'plan', description: 'planning agent' },
    { name: 'hidden-one', hidden: true },
  ];

  it('lists visible agents and records a channel override on selection', async () => {
    const { wizards, calls, overrides } = makeHarness({ agents });
    await wizards.startAgent(state, interaction);
    const pickCustomId = customIdOf(calls.at(-1));
    expect(optionValues(calls.at(-1))).toEqual(['build', 'plan']);

    await wizards.handleComponent(state, { id: 'i2', token: 't2', data: { values: ['plan'] } }, pickCustomId);
    const scopeCustomId = customIdOf(calls.at(-1));
    await wizards.handleComponent(state, { id: 'i3', token: 't3', data: { values: ['channel'] } }, scopeCustomId);
    expect(overrides).toEqual([
      { type: 'discord', botTokenHash: expect.any(String), targetKey: 'chan-1', agentOverride: 'plan' },
    ]);
  });

  it('replies with a hint when no agents are configured', async () => {
    const { wizards, calls } = makeHarness({ agents: [] });
    await wizards.startAgent(state, interaction);
    expect(calls.at(-1).body.data.content).toContain('no agents configured');
  });
});

describe('skill wizard', () => {
  const skills = [
    { name: 'theme-system', description: 'theme tokens' },
    { name: 'drag-to-reorder', description: 'dnd-kit lists' },
  ];

  it('lists skills and hands the chosen one to the agent via routeInbound', async () => {
    const { wizards, calls, routed } = makeHarness({ skills });
    await wizards.startSkill(state, interaction);
    const pickCustomId = customIdOf(calls.at(-1));
    expect(optionValues(calls.at(-1))).toEqual(['theme-system', 'drag-to-reorder']);

    await wizards.handleComponent(state, { id: 'i2', token: 't2', data: { values: ['theme-system'] } }, pickCustomId);
    expect(routed).toHaveLength(1);
    expect(routed[0]).toMatchObject({ type: 'discord', token: 'bot-token', channelId: 'chan-1' });
    expect(routed[0].text).toContain('theme-system');
    expect(calls.at(-1).body.data.content).toContain('theme-system');
  });

  it('replies with a hint when no skills are available', async () => {
    const { wizards, calls, routed } = makeHarness({ skills: [] });
    await wizards.startSkill(state, interaction);
    expect(calls.at(-1).body.data.content).toContain('no skills available');
    expect(routed).toHaveLength(0);
  });
});

describe('component ownership', () => {
  it('claims only its own custom_id prefixes', () => {
    const { wizards } = makeHarness();
    expect(wizards.ownsComponent('openchamber-agent-verb-level:abc')).toBe(true);
    expect(wizards.ownsComponent('openchamber-agent-scope:abc')).toBe(true);
    expect(wizards.ownsComponent('openchamber-agent-skill-pick:abc')).toBe(true);
    expect(wizards.ownsComponent('openchamber-agent-perm-mode:abc')).toBe(true);
    expect(wizards.ownsComponent('openchamber-agent-perm-scope:abc')).toBe(true);
    expect(wizards.ownsComponent('openchamber-agent-login-provider:abc')).toBe(true);
    expect(wizards.ownsComponent('openchamber-agent-login-method:abc')).toBe(true);
    expect(wizards.ownsComponent('openchamber-agent-model-provider:abc')).toBe(false);
    expect(wizards.ownsComponent('openchamber-agent-approve:abc')).toBe(false);
  });
});

describe('legacy Otto custom_id normalization', () => {
  it('rewrites deprecated Otto prefixes into the OpenChamber agent namespace', async () => {
    const {
      normalizeLegacyDiscordCustomId,
      normalizeLegacyDiscordSelectValue,
    } = await import('./discord-wizard-shared.js');

    expect(normalizeLegacyDiscordCustomId('otto-approve:abc')).toBe('openchamber-agent-approve:abc');
    expect(normalizeLegacyDiscordCustomId('otto-agent-pick:xyz')).toBe('openchamber-agent-pick:xyz');
    expect(normalizeLegacyDiscordCustomId('openchamber-agent-deny:1')).toBe('openchamber-agent-deny:1');
    expect(normalizeLegacyDiscordSelectValue('__otto_next')).toBe('__openchamber_agent_next');
    expect(normalizeLegacyDiscordSelectValue('low')).toBe('low');
  });
});
