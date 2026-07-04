import { describe, it, expect } from 'vitest';
import { createDiscordCommandWizards } from './discord-command-wizards.js';

/** A restCall recorder + a bridge stub backed by fake store + spies. */
function makeHarness({ agents = [], skills = [] } = {}) {
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
  const bridge = {
    listAgents: async () => agents,
    listSurfaceSkills: async () => skills,
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
  };
}

function customIdOf(call) {
  return call.body?.data?.components?.[0]?.components?.[0]?.custom_id;
}
function optionValues(call) {
  return call.body?.data?.components?.[0]?.components?.[0]?.options?.map((o) => o.value) ?? [];
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
    expect(optionValues(calls.at(-1))).toEqual(['ask', 'auto-edit', 'yolo']);

    await wizards.handleComponent(state, { id: 'i2', token: 't2', data: { values: ['yolo'] } }, modeCustomId);
    const scopeCustomId = customIdOf(calls.at(-1));
    expect(optionValues(calls.at(-1))).toEqual(['surface', 'project', 'global']);

    await wizards.handleComponent(state, { id: 'i3', token: 't3', data: { values: ['surface'] } }, scopeCustomId);
    expect(overrides).toEqual([
      { type: 'discord', botTokenHash: expect.any(String), targetKey: 'chan-1', permissionModeOverride: 'yolo' },
    ]);
    expect(permissionModeDefaults).toHaveLength(0);
    expect(calls.at(-1).body.data.content).toContain('YOLO');
  });

  it('mode → "whole system" scope writes the messenger default', async () => {
    const { wizards, calls, overrides, permissionModeDefaults } = makeHarness();
    await wizards.startPermissions(state, interaction);
    const modeCustomId = customIdOf(calls.at(-1));
    await wizards.handleComponent(state, { id: 'i2', token: 't2', data: { values: ['auto-edit'] } }, modeCustomId);
    const scopeCustomId = customIdOf(calls.at(-1));
    await wizards.handleComponent(state, { id: 'i3', token: 't3', data: { values: ['global'] } }, scopeCustomId);
    expect(permissionModeDefaults).toEqual([{ type: 'discord', mode: 'auto-edit' }]);
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
    expect(wizards.ownsComponent('otto-verb-level:abc')).toBe(true);
    expect(wizards.ownsComponent('otto-agent-scope:abc')).toBe(true);
    expect(wizards.ownsComponent('otto-skill-pick:abc')).toBe(true);
    expect(wizards.ownsComponent('otto-perm-mode:abc')).toBe(true);
    expect(wizards.ownsComponent('otto-perm-scope:abc')).toBe(true);
    expect(wizards.ownsComponent('otto-model-provider:abc')).toBe(false);
    expect(wizards.ownsComponent('otto-approve:abc')).toBe(false);
  });
});
