import {
  PREV_VALUE,
  NEXT_VALUE,
  buildPagedOptions,
  stringSelect,
  botHashFor,
  randomWizardHash,
  createWizardStore,
} from './discord-wizard-shared.js';
import { VERBOSITY_LEVELS } from './messenger-verbosity.js';
import {
  PERMISSION_MODES,
  PERMISSION_MODE_DESCRIPTIONS,
  PERMISSION_MODE_LABELS,
} from './messenger-permissions.js';

/**
 * Interactive select-menu wizards for the Discord `/verbosity`, `/agent` and
 * `/skill` slash commands — the dropdown-driven counterparts to the text
 * commands in `messenger-commands.js`.
 *
 *   /verbosity → pick level (quiet/normal/verbose) → pick scope
 *                (this conversation / whole system)
 *   /agent     → pick agent (paged) → pick scope (this channel / project default)
 *   /skill     → pick skill (paged) → hand it straight to the agent
 *
 * Every flow reuses the shared paging + state helpers so it matches the
 * `/model` wizard's UX (25-option cap handling, ephemeral replies, TTL expiry)
 * and stays gateway/WebSocket-free for isolated unit testing.
 */

const VERB_LEVEL_PREFIX = 'openchamber-agent-verb-level:';
const VERB_SCOPE_PREFIX = 'openchamber-agent-verb-scope:';
const AGENT_PICK_PREFIX = 'openchamber-agent-pick:';
const AGENT_SCOPE_PREFIX = 'openchamber-agent-scope:';
const SKILL_PICK_PREFIX = 'openchamber-agent-skill-pick:';
const PERM_MODE_PREFIX = 'openchamber-agent-perm-mode:';
const PERM_SCOPE_PREFIX = 'openchamber-agent-perm-scope:';

const VERBOSITY_DESCRIPTIONS = {
  quiet: 'Final answer only — hides reasoning + tool activity',
  normal: 'Compact feed: tool names + thinking marker (default)',
  verbose: 'Full detail: commands, diffs, outputs, reasoning',
};

const PREFIXES = [
  VERB_LEVEL_PREFIX,
  VERB_SCOPE_PREFIX,
  AGENT_PICK_PREFIX,
  AGENT_SCOPE_PREFIX,
  SKILL_PICK_PREFIX,
  PERM_MODE_PREFIX,
  PERM_SCOPE_PREFIX,
];

function isNav(value) {
  return value === PREV_VALUE || value === NEXT_VALUE;
}

function nextPage(current, value) {
  return (current ?? 0) + (value === NEXT_VALUE ? 1 : -1);
}

export function createDiscordCommandWizards({ restCall, bridge }) {
  const wizards = createWizardStore();

  function respond(token, interaction, data) {
    return restCall(
      token,
      'POST',
      `/interactions/${interaction.id}/${interaction.token}/callback`,
      data,
    );
  }

  function expired(token, interaction) {
    return respond(token, interaction, {
      type: 7,
      data: { content: 'Selection expired. Please run the command again.', flags: 64, components: [] },
    });
  }

  function ownsComponent(customId) {
    return typeof customId === 'string' && PREFIXES.some((p) => customId.startsWith(p));
  }

  function surfaceOf(wizard) {
    return {
      type: 'discord',
      token: wizard.token,
      channelId: wizard.channelId,
      threadId: null,
    };
  }

  // ── /verbosity ─────────────────────────────────────────────────────────────
  function verbosityLevelSelect(hash) {
    const options = VERBOSITY_LEVELS.map((level) => ({
      label: level,
      value: level,
      description: VERBOSITY_DESCRIPTIONS[level],
    }));
    return stringSelect(`${VERB_LEVEL_PREFIX}${hash}`, options, 'Select verbosity level');
  }

  async function startVerbosity(state, interaction) {
    const hash = randomWizardHash();
    wizards.set(hash, {
      kind: 'verbosity',
      token: state.token,
      channelId: interaction.channel_id,
      guildId: interaction.guild_id,
      appId: interaction.application_id,
    });
    await respond(state.token, interaction, {
      type: 4,
      data: {
        content: '**Set output verbosity**\nHow much of each turn should OpenChamber agent stream back here?',
        flags: 64,
        components: [verbosityLevelSelect(hash)],
      },
    });
  }

  async function onVerbosityLevel(token, interaction, hash) {
    const wizard = wizards.get(hash);
    if (!wizard) return expired(token, interaction);
    const value = interaction.data?.values?.[0];
    if (!value) return;
    wizard.level = value;
    wizards.set(hash, wizard);

    const scopeOptions = [
      { label: 'This conversation', value: 'surface', description: 'Override for this channel/thread only' },
      { label: 'This project', value: 'project', description: "Default for this conversation's project" },
      { label: 'Whole system (default)', value: 'global', description: 'Default for every Discord conversation' },
    ];
    await respond(wizard.token, interaction, {
      type: 7,
      data: {
        content: `**Set output verbosity**\nLevel: **${value}** — ${VERBOSITY_DESCRIPTIONS[value] ?? ''}\nApply to:`,
        flags: 64,
        components: [stringSelect(`${VERB_SCOPE_PREFIX}${hash}`, scopeOptions, 'Apply to…')],
      },
    });
  }

  async function onVerbosityScope(token, interaction, hash) {
    const wizard = wizards.get(hash);
    if (!wizard) return expired(token, interaction);
    const scope = interaction.data?.values?.[0];
    const level = wizard.level;
    if (!scope || !level) return;

    let scopeLabel = 'this conversation';
    if (bridge?.store) {
      try {
        const botTokenHash = botHashFor(wizard.token);
        const targetKey = String(wizard.channelId);
        // "This project" applies to every surface that lands in the channel's
        // project. We can only do that when the channel already resolves to a
        // project; otherwise fall back to a conversation override so the choice
        // still takes effect immediately.
        const binding =
          scope === 'project'
            ? bridge.store.lookup?.({ type: 'discord', botTokenHash, targetKey })
            : null;
        if (scope === 'global') {
          bridge.store.setVerbosityDefault?.('discord', level);
          scopeLabel = 'every Discord conversation';
        } else if (scope === 'project' && binding?.projectPath) {
          bridge.store.setProjectDefaults?.({
            projectPath: binding.projectPath,
            projectLabel: binding.projectLabel,
            verbosityDefault: level,
          });
          scopeLabel = `project *${binding.projectLabel ?? binding.projectPath}*`;
        } else {
          bridge.store.setOverrides?.({
            type: 'discord',
            botTokenHash,
            targetKey,
            verbosityOverride: level,
          });
          scopeLabel = scope === 'project' ? 'this conversation (no project bound yet)' : 'this conversation';
        }
      } catch {
        // best-effort — still confirm the user's choice below
      }
    }
    // Apply the change to any turn already streaming on this surface so the new
    // level takes effect immediately, not only on the next message.
    try {
      bridge?.applyPreferencesToActiveTurn?.({
        type: 'discord',
        token: wizard.token,
        channelId: wizard.channelId,
        threadId: null,
      });
    } catch {
      // best-effort
    }
    wizards.del(hash);
    await respond(wizard.token, interaction, {
      type: 7,
      data: {
        content: `✓ Verbosity set to **${level}** for ${scopeLabel}.\n_${VERBOSITY_DESCRIPTIONS[level] ?? ''}_`,
        flags: 64,
        components: [],
      },
    });
  }

  // ── /yolo|/permissions (permission mode) ───────────────────────────────────
  function permissionModeSelect(hash) {
    const options = PERMISSION_MODES.map((mode) => ({
      label: PERMISSION_MODE_LABELS[mode] ?? mode,
      value: mode,
      description: (PERMISSION_MODE_DESCRIPTIONS[mode] ?? '').slice(0, 100),
    }));
    return stringSelect(`${PERM_MODE_PREFIX}${hash}`, options, 'Select a permission mode');
  }

  async function startPermissions(state, interaction) {
    const hash = randomWizardHash();
    wizards.set(hash, {
      kind: 'permissions',
      token: state.token,
      channelId: interaction.channel_id,
      guildId: interaction.guild_id,
      appId: interaction.application_id,
    });
    await respond(state.token, interaction, {
      type: 4,
      data: {
        content:
          '**Set tool permission mode**\nHow should OpenChamber agent handle approval requests (shell, edits, …)?\nYou can still stop any run with `/abort`.',
        flags: 64,
        components: [permissionModeSelect(hash)],
      },
    });
  }

  async function onPermissionsMode(token, interaction, hash) {
    const wizard = wizards.get(hash);
    if (!wizard) return expired(token, interaction);
    const value = interaction.data?.values?.[0];
    if (!value) return;
    wizard.mode = value;
    wizards.set(hash, wizard);

    const scopeOptions = [
      { label: 'This conversation', value: 'surface', description: 'Override for this channel/thread only' },
      { label: 'This project', value: 'project', description: "Default for this conversation's project" },
      { label: 'Whole system (default)', value: 'global', description: 'Default for every Discord conversation' },
    ];
    await respond(wizard.token, interaction, {
      type: 7,
      data: {
        content: `**Set tool permission mode**\nMode: **${PERMISSION_MODE_LABELS[value] ?? value}** — ${PERMISSION_MODE_DESCRIPTIONS[value] ?? ''}\nApply to:`,
        flags: 64,
        components: [stringSelect(`${PERM_SCOPE_PREFIX}${hash}`, scopeOptions, 'Apply to…')],
      },
    });
  }

  async function onPermissionsScope(token, interaction, hash) {
    const wizard = wizards.get(hash);
    if (!wizard) return expired(token, interaction);
    const scope = interaction.data?.values?.[0];
    const mode = wizard.mode;
    if (!scope || !mode) return;

    let scopeLabel = 'this conversation';
    if (bridge?.store) {
      try {
        const botTokenHash = botHashFor(wizard.token);
        const targetKey = String(wizard.channelId);
        const binding =
          scope === 'project'
            ? bridge.store.lookup?.({ type: 'discord', botTokenHash, targetKey })
            : null;
        if (scope === 'global') {
          bridge.store.setPermissionModeDefault?.('discord', mode);
          scopeLabel = 'every Discord conversation';
        } else if (scope === 'project' && binding?.projectPath) {
          bridge.store.setProjectDefaults?.({
            projectPath: binding.projectPath,
            projectLabel: binding.projectLabel,
            permissionModeDefault: mode,
          });
          scopeLabel = `project *${binding.projectLabel ?? binding.projectPath}*`;
        } else {
          bridge.store.setOverrides?.({
            type: 'discord',
            botTokenHash,
            targetKey,
            permissionModeOverride: mode,
          });
          scopeLabel = scope === 'project' ? 'this conversation (no project bound yet)' : 'this conversation';
        }
      } catch {
        // best-effort — still confirm the user's choice below
      }
    }
    wizards.del(hash);
    await respond(wizard.token, interaction, {
      type: 7,
      data: {
        content: `✓ Permission mode set to **${PERMISSION_MODE_LABELS[mode] ?? mode}** for ${scopeLabel}.\n_${PERMISSION_MODE_DESCRIPTIONS[mode] ?? ''}_`,
        flags: 64,
        components: [],
      },
    });
  }

  // ── /agent ───────────────────────────────────────────────────────────────
  function agentOptions(agents) {
    return agents.map((a) => ({
      label: (a.name ?? 'agent').slice(0, 100),
      value: a.name ?? 'agent',
      description: (a.description || (a.model ? `model ${a.model}` : ' ')).slice(0, 100),
    }));
  }

  function renderAgentSelect(hash, agents, page) {
    const { options } = buildPagedOptions(agentOptions(agents), page);
    return stringSelect(`${AGENT_PICK_PREFIX}${hash}`, options, 'Select an agent');
  }

  async function startAgent(state, interaction) {
    let agents = [];
    try {
      agents = (await bridge?.listAgents?.()) ?? [];
    } catch {
      agents = [];
    }
    const visible = agents.filter((a) => a && !a.hidden && a.name);
    if (visible.length === 0) {
      await respond(state.token, interaction, {
        type: 4,
        data: { content: '_(no agents configured — see Settings → Agents in the web UI.)_', flags: 64 },
      });
      return;
    }
    const hash = randomWizardHash();
    wizards.set(hash, {
      kind: 'agent',
      token: state.token,
      channelId: interaction.channel_id,
      guildId: interaction.guild_id,
      appId: interaction.application_id,
      agents: visible,
      agentPage: 0,
    });
    await respond(state.token, interaction, {
      type: 4,
      data: {
        content: '**Set agent**\nSelect an agent for this conversation:',
        flags: 64,
        components: [renderAgentSelect(hash, visible, 0)],
      },
    });
  }

  async function onAgentPick(token, interaction, hash) {
    const wizard = wizards.get(hash);
    if (!wizard) return expired(token, interaction);
    const value = interaction.data?.values?.[0];
    if (!value) return;

    if (isNav(value)) {
      wizard.agentPage = nextPage(wizard.agentPage, value);
      wizards.set(hash, wizard);
      await respond(wizard.token, interaction, {
        type: 7,
        data: {
          content: '**Set agent**\nSelect an agent for this conversation:',
          flags: 64,
          components: [renderAgentSelect(hash, wizard.agents, wizard.agentPage)],
        },
      });
      return;
    }

    wizard.agentName = value;
    wizards.set(hash, wizard);
    const scopeOptions = [
      { label: 'This channel only', value: 'channel', description: 'Override for this channel only' },
      { label: 'Project default', value: 'global', description: 'Default for this project' },
    ];
    await respond(wizard.token, interaction, {
      type: 7,
      data: {
        content: `**Set agent**\nAgent: **${value}**\nApply to:`,
        flags: 64,
        components: [stringSelect(`${AGENT_SCOPE_PREFIX}${hash}`, scopeOptions, 'Apply to…')],
      },
    });
  }

  async function onAgentScope(token, interaction, hash) {
    const wizard = wizards.get(hash);
    if (!wizard) return expired(token, interaction);
    const scope = interaction.data?.values?.[0];
    const agentName = wizard.agentName;
    if (!scope || !agentName) return;

    let scopeLabel = 'this channel';
    if (bridge?.store) {
      try {
        const botTokenHash = botHashFor(wizard.token);
        const targetKey = String(wizard.channelId);
        const binding =
          scope === 'global'
            ? bridge.store.lookup?.({ type: 'discord', botTokenHash, targetKey })
            : null;
        if (scope === 'global' && binding?.projectPath) {
          bridge.store.setProjectDefaults?.({
            projectPath: binding.projectPath,
            projectLabel: binding.projectLabel,
            agentDefault: agentName,
          });
          scopeLabel = `project *${binding.projectLabel ?? binding.projectPath}*`;
        } else {
          bridge.store.setOverrides?.({
            type: 'discord',
            botTokenHash,
            targetKey,
            agentOverride: agentName,
          });
          scopeLabel = scope === 'global' ? 'this channel (no project bound yet)' : 'this channel';
        }
      } catch {
        // best-effort
      }
    }
    wizards.del(hash);
    await respond(wizard.token, interaction, {
      type: 7,
      data: { content: `✓ Agent set to **${agentName}** for ${scopeLabel}.`, flags: 64, components: [] },
    });
  }

  // ── /skill ─────────────────────────────────────────────────────────────────
  function skillOptions(skills) {
    return skills.map((s) => ({
      label: (s.name ?? 'skill').slice(0, 100),
      value: s.name ?? 'skill',
      description: ((s.description || '').trim() || 'No description').slice(0, 100),
    }));
  }

  function renderSkillSelect(hash, skills, page) {
    const { options } = buildPagedOptions(skillOptions(skills), page);
    return stringSelect(`${SKILL_PICK_PREFIX}${hash}`, options, 'Select a skill');
  }

  function skillPromptFor(skill) {
    const name = skill?.name ?? 'skill';
    const desc = (skill?.description || '').trim();
    return desc
      ? `Use the "${name}" skill for this task.\n\nSkill: ${name} — ${desc}`
      : `Use the "${name}" skill for this task.`;
  }

  async function startSkill(state, interaction) {
    let skills = [];
    try {
      skills =
        (await bridge?.listSurfaceSkills?.({
          type: 'discord',
          token: state.token,
          channelId: interaction.channel_id,
          threadId: null,
        })) ?? [];
    } catch {
      skills = [];
    }
    skills = skills.filter((s) => s && s.name);
    if (skills.length === 0) {
      await respond(state.token, interaction, {
        type: 4,
        data: {
          content:
            '_(no skills available for this conversation — install some via the Skills catalog in the web UI.)_',
          flags: 64,
        },
      });
      return;
    }
    const hash = randomWizardHash();
    wizards.set(hash, {
      kind: 'skill',
      token: state.token,
      channelId: interaction.channel_id,
      guildId: interaction.guild_id,
      appId: interaction.application_id,
      from: {
        id: interaction.member?.user?.id ?? interaction.user?.id,
        username: interaction.member?.user?.username ?? interaction.user?.username,
        firstName: interaction.member?.user?.global_name ?? interaction.user?.global_name ?? null,
      },
      skills,
      skillPage: 0,
    });
    await respond(state.token, interaction, {
      type: 4,
      data: {
        content: '**Run a skill**\nPick a skill to hand to the agent:',
        flags: 64,
        components: [renderSkillSelect(hash, skills, 0)],
      },
    });
  }

  async function onSkillPick(token, interaction, hash) {
    const wizard = wizards.get(hash);
    if (!wizard) return expired(token, interaction);
    const value = interaction.data?.values?.[0];
    if (!value) return;

    if (isNav(value)) {
      wizard.skillPage = nextPage(wizard.skillPage, value);
      wizards.set(hash, wizard);
      await respond(wizard.token, interaction, {
        type: 7,
        data: {
          content: '**Run a skill**\nPick a skill to hand to the agent:',
          flags: 64,
          components: [renderSkillSelect(hash, wizard.skills, wizard.skillPage)],
        },
      });
      return;
    }

    const skill = wizard.skills.find((s) => (s.name ?? 'skill') === value) ?? { name: value };
    wizards.del(hash);

    // Acknowledge immediately, then hand the skill to the agent. The agent's
    // streamed response lands in the channel/thread like any other prompt.
    await respond(wizard.token, interaction, {
      type: 7,
      data: { content: `▶ Handing the **${value}** skill to OpenChamber agent…`, flags: 64, components: [] },
    });

    try {
      await bridge?.routeInbound?.({
        ...surfaceOf(wizard),
        sourceMessageId: null,
        text: skillPromptFor(skill),
        from: wizard.from,
      });
    } catch {
      // The ephemeral ack already fired; surface failures show up as the usual
      // "could not reach OpenCode" message from routeInbound.
    }
  }

  async function handleComponent(state, interaction, customId) {
    const token = state?.token;
    if (customId.startsWith(VERB_LEVEL_PREFIX))
      return onVerbosityLevel(token, interaction, customId.slice(VERB_LEVEL_PREFIX.length));
    if (customId.startsWith(VERB_SCOPE_PREFIX))
      return onVerbosityScope(token, interaction, customId.slice(VERB_SCOPE_PREFIX.length));
    if (customId.startsWith(AGENT_PICK_PREFIX))
      return onAgentPick(token, interaction, customId.slice(AGENT_PICK_PREFIX.length));
    if (customId.startsWith(AGENT_SCOPE_PREFIX))
      return onAgentScope(token, interaction, customId.slice(AGENT_SCOPE_PREFIX.length));
    if (customId.startsWith(SKILL_PICK_PREFIX))
      return onSkillPick(token, interaction, customId.slice(SKILL_PICK_PREFIX.length));
    if (customId.startsWith(PERM_MODE_PREFIX))
      return onPermissionsMode(token, interaction, customId.slice(PERM_MODE_PREFIX.length));
    if (customId.startsWith(PERM_SCOPE_PREFIX))
      return onPermissionsScope(token, interaction, customId.slice(PERM_SCOPE_PREFIX.length));
  }

  return { ownsComponent, handleComponent, startVerbosity, startAgent, startSkill, startPermissions };
}
