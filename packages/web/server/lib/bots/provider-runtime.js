import { z } from 'zod';
import { createBotAdapterState } from './adapter-state.js';
import { createBotProviderEventStore, pollBotJiraComments } from './provider-events.js';
import { createBotDiscordGateway } from './discord-gateway.js';
import { readRepositoryPolicy } from './repository-policy.js';
import { botDiscordConfigSchema } from './config.js';
import { TERMINAL_ITEM_STATES } from './schema.js';
import { BotServiceError, discordTarget, jiraOrigin, jiraTarget, snowflake } from './services/contracts.js';
import { digestMutationInput } from '../source-control/mutation-executor.js';

const text = z.string().min(1);
const linkSchema = z.object({ version: z.literal(1), projectId: text, botId: text, identityId: text, identityRevision: z.number().int().positive(),
  guildId: text, channelId: snowflake, rootId: snowflake, itemId: text, recipientId: snowflake.optional(),
}).strict();
const active = (item) => !TERMINAL_ITEM_STATES.includes(item.state);
const readBotDiscordConfig = ({ bot }) => botDiscordConfigSchema.parse(bot.discord === undefined ? {} : bot.discord);

/** Outbound-only lifecycle over the provider event store, Gateway and bot engine. */
export function createBotProviderRuntime({ dataDir, config, store, identities, services, runtime,
  listProjects, resolveProject, serviceContext, onNeedsYou,
  eventStore = createBotProviderEventStore({ dataDir }), createGateway = createBotDiscordGateway,
  pollIntervalMs = 60_000, fetchImpl, policyOptions,
}) {
  const functions = [config?.read, store?.read, identities?.list, services?.read, runtime?.admit, runtime?.receiveFeedback, runtime?.answer, runtime?.pump,
    listProjects, resolveProject, serviceContext, onNeedsYou];
  if (functions.some((value) => !(value instanceof Function))) throw new TypeError('Provider runtime requires production config, identities, providers, engine and attention owners');
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1_000) throw new TypeError('Provider poll interval must be at least one second');
  const links = createBotAdapterState({ dataDir, name: 'provider-links', schema: linkSchema });
  const eventsFor = (consumer) => ({
    read: (scope) => eventStore.read({ ...scope, consumer }),
    record: (scope, page) => eventStore.record({ ...scope, consumer }, page),
    drain: (scope, deliver) => eventStore.drain({ ...scope, consumer }, deliver),
  });
  const gateways = new Map();
  const blocked = new Set();
  let stopped = true; let timer = null; let running = null; let configuration = Promise.resolve();
  const selectedIdentity = async (bot, service) => {
    const id = bot.identity?.[service]?.identityId;
    const entry = (await identities.list()).find((identity) => identity.id === id);
    if (!entry || !entry.kind.startsWith(`${service}-`)) throw new BotServiceError('BOT_IDENTITY_REQUIRED', 'Select the exact bot service identity.');
    const identity = { identityId: entry.id, identityRevision: entry.revision };
    if (entry.site) identity.site = entry.site;
    return identity;
  };
  const resolveJiraContext = async ({ bot }) => {
    const identity = await selectedIdentity(bot, 'jira');
    return { identityId: identity.identityId, identityRevision: identity.identityRevision, site: jiraOrigin(identity.site) };
  };
  const peopleFor = async (project, settings) => {
    const policy = await readRepositoryPolicy(project.path, settings.approvals);
    return policy.people.status === 'approved' ? policy.people.people.flatMap((person) => person.discord ? [person.discord] : []) : [];
  };
  const deliverReply = async (projectId, itemId, feedback) => {
    const item = (await store.read(projectId)).items.find((entry) => entry.id === itemId);
    return item?.state === 'waiting-answer'
      ? runtime.answer(projectId, itemId, feedback)
      : runtime.receiveFeedback(projectId, itemId, feedback);
  };
  const deliverDiscord = async ({ project, botId, identityId, identityRevision, event }) => {
    const settings = await config.read(project.id);
    const bot = settings.definitions.find((entry) => entry.id === botId && entry.enabled);
    if (!bot || bot.identity?.discord?.identityId !== identityId) throw new BotServiceError('BOT_EVENT_CONFIGURATION_CHANGED', 'The bot event configuration changed before delivery.');
    const current = await selectedIdentity(bot, 'discord');
    if (current.identityRevision !== identityRevision) throw new BotServiceError('BOT_IDENTITY_UNAVAILABLE', 'The Discord identity changed before delivery.');
    const channels = readBotDiscordConfig({ bot }).channels;
    const people = await peopleFor(project, settings);
    if (event.guildId === 'dm' ? !people.includes(event.authorId)
      : !channels.some((channel) => channel.guildId === event.guildId && channel.channelId === event.channelId)) {
      throw new BotServiceError('BOT_EVENT_NOT_AUTHORIZED', 'Approve this person or channel before delivering the Discord event.');
    }
    const messageId = snowflake.parse(event.id.replace(/^discord:/, ''));
    const currentItems = (await store.read(project.id)).items.filter((item) => item.botId === botId && active(item));
    const candidates = (await links.list()).filter((link) => link.projectId === project.id && link.botId === botId
      && link.identityId === identityId && link.identityRevision === identityRevision && link.guildId === event.guildId
      && link.channelId === event.channelId && currentItems.some((item) => item.id === link.itemId));
    const linked = candidates.find((link) => link.rootId === (event.threadId ?? messageId))
      ?? (event.guildId === 'dm' && candidates.length === 1 ? candidates[0] : null);
    if (linked) return deliverReply(project.id, linked.itemId, { eventId: event.id, text: event.body || 'Discord message' });
    // Admission deduplicates source ID even if the host stopped before linking it.
    const source = { kind: 'alert', id: event.id };
    if (event.guildId !== 'dm') source.url = `https://discord.com/channels/${event.guildId}/${event.channelId}/${messageId}`;
    const item = await runtime.admit(project.id, botId, {
      source,
      title: event.body.trim().slice(0, 256) || 'Discord message', description: event.body,
      evidence: [{ source: event.id, summary: event.body.trim().slice(0, 1_000) || 'Discord message' }],
    });
    const key = { projectId: project.id, botId, identityId, identityRevision, guildId: event.guildId, channelId: event.channelId, rootId: event.threadId ?? messageId };
    const link = { version: 1, ...key, itemId: item.id };
    if (event.guildId === 'dm') link.recipientId = snowflake.parse(event.authorId);
    await links.own(key, () => links.write(key, link));
    await runtime.pump(project.id);
    return { itemId: item.id };
  };
  const report = (context, error) => onNeedsYou({ ...context, state: 'needs-you', reason: error instanceof BotServiceError ? error.code : 'BOT_PROVIDER_UNAVAILABLE' });
  const resolveDiscordTarget = async ({ project, bot, item }) => {
    const settings = await config.read(project.id);
    const currentBot = settings.definitions.find((entry) => entry.id === bot.id && entry.enabled);
    if (!currentBot || currentBot.identity?.discord?.identityId !== bot.identity?.discord?.identityId) throw new BotServiceError('BOT_EVENT_CONFIGURATION_CHANGED', 'The bot Discord identity changed before destination resolution.');
    bot = currentBot;
    const identity = await selectedIdentity(bot, 'discord');
    const channels = readBotDiscordConfig({ bot }).channels;
    const itemLinks = (await links.list()).filter((link) => link.projectId === project.id && link.botId === bot.id && link.itemId === item.id);
    const linked = itemLinks.filter((link) => link.identityId === identity.identityId && link.identityRevision === identity.identityRevision);
    if (itemLinks.length && !linked.length) throw new BotServiceError('BOT_IDENTITY_UNAVAILABLE', 'The linked Discord identity changed. Review this conversation before sending.');
    const targets = new Map(linked.map(({ guildId, channelId, recipientId }) => {
      const destination = { guildId, channelId };
      if (recipientId) destination.recipientId = recipientId;
      const target = discordTarget.parse(destination);
      return [digestMutationInput(target), target];
    }));
    if (targets.size > 1) throw new BotServiceError('BOT_DISCORD_DESTINATION_AMBIGUOUS', 'This item has more than one Discord destination. Select its conversation before sending.');
    if (targets.size === 1) {
      const [target] = targets.values();
      if (target.guildId === 'dm') {
        if (!(await peopleFor(project, settings)).includes(target.recipientId)) throw new BotServiceError('BOT_DISCORD_PERSON_DENIED', 'Approve the linked Discord recipient before sending.');
      } else if (!channels.some((channel) => channel.guildId === target.guildId && channel.channelId === target.channelId)) {
        throw new BotServiceError('BOT_DISCORD_CHANNEL_DENIED', 'The linked Discord channel is no longer configured for this bot.');
      }
      return target;
    }
    if (channels.length !== 1) throw new BotServiceError(channels.length ? 'BOT_DISCORD_DESTINATION_AMBIGUOUS' : 'BOT_DISCORD_DESTINATION_REQUIRED', 'Configure one Discord channel or use an item linked to a conversation.');
    return discordTarget.parse(channels[0]);
  };
  const poll = async () => {
    const failures = [];
    for (const projectRecord of await listProjects()) {
      if (stopped) break;
      const projectId = projectRecord.id;
      try {
        const project = await resolveProject(projectId);
        const settings = await config.read(projectId);
        const items = (await store.read(projectId)).items;
        for (const item of items.filter((entry) => active(entry) && entry.source.kind === 'jira')) {
          if (stopped) break;
          const bot = settings.definitions.find((entry) => entry.id === item.botId && entry.enabled);
          if (!bot?.identity?.jira) continue;
          let blockKey;
          try {
            const selected = await selectedIdentity(bot, 'jira');
            blockKey = digestMutationInput({ projectId, itemId: item.id, ...selected });
            if (blocked.has(blockKey)) continue;
            const binding = (await serviceContext({ project, bot, item, service: 'jira', operation: 'jira.comments' })).jira;
            if (!binding || binding.identityId !== selected.identityId || binding.identityRevision !== selected.identityRevision) throw new BotServiceError('BOT_IDENTITY_UNAVAILABLE', 'The selected Jira identity changed.');
            const target = jiraTarget.parse(binding.target);
            if (target.issueKey !== item.source.id) throw new BotServiceError('BOT_SERVICE_TARGET_CHANGED', 'The Jira event target differs from its item.');
            // One provider cursor serves one item inbox. Two bots watching the
            // same issue must each receive the comment exactly once.
            await pollBotJiraComments({ services, eventStore: eventsFor({ projectId, itemId: item.id }), ...binding, target,
              deliver: (event) => deliverReply(projectId, item.id, { eventId: event.id, text: event.body || 'Jira comment' }),
            });
          } catch (error) {
            if (blockKey && error.state === 'needs-you' && !['BOT_SERVICE_UNAVAILABLE', 'BOT_SERVICE_RESPONSE_INVALID'].includes(error.code)) blocked.add(blockKey);
            await report({ projectId, botId: bot.id, itemId: item.id }, error);
            failures.push({ projectId, itemId: item.id, code: error.code ?? 'BOT_PROVIDER_UNAVAILABLE' });
          }
        }
      } catch (error) { failures.push({ projectId, code: error.code ?? 'BOT_PROVIDER_UNAVAILABLE' }); await report({ projectId }, error); }
    }
    return { failures };
  };
  const tick = () => {
    if (stopped) return Promise.resolve({ failures: [] });
    if (!running) running = poll().finally(() => { running = null; });
    return running;
  };
  const reconfigure = () => {
    const next = configuration.then(async () => {
      if (stopped) return;
      blocked.clear();
      const desired = new Set(); const failures = [];
      for (const projectRecord of await listProjects()) {
        if (stopped) break;
        const projectId = projectRecord.id;
        try {
          const project = await resolveProject(projectId); const settings = await config.read(projectId);
          for (const bot of settings.definitions.filter((entry) => entry.enabled && entry.identity?.discord)) {
            const name = `${projectId}:${bot.id}`; desired.add(name);
            try {
              const identity = await selectedIdentity(bot, 'discord');
              const { channels } = readBotDiscordConfig({ bot });
              const people = await peopleFor(project, settings);
              const fingerprint = digestMutationInput({ identity, channels, people });
              if (gateways.get(name)?.fingerprint === fingerprint) continue;
              if (gateways.has(name)) { await gateways.get(name).gateway.stop(); gateways.delete(name); }
              if (channels.length === 0 && people.length === 0) continue;
              const gateway = createGateway({ identities, identityId: identity.identityId, identityRevision: identity.identityRevision, channels, people,
                eventStore: eventsFor({ projectId, botId: bot.id }), fetchImpl, policyOptions,
                deliver: (event) => deliverDiscord({ project, botId: bot.id, ...identity, event }),
                onError: (error) => { void Promise.resolve(report({ projectId, botId: bot.id }, error)).catch(() => {}); },
              });
              gateways.set(name, { fingerprint, gateway });
              try { await gateway.start(); }
              catch (error) { await gateway.stop(); gateways.delete(name); throw error; }
            } catch (error) {
              if (gateways.has(name)) { await gateways.get(name).gateway.stop(); gateways.delete(name); }
              await report({ projectId, botId: bot.id }, error); failures.push({ projectId, botId: bot.id, code: error.code ?? 'BOT_PROVIDER_UNAVAILABLE' });
            }
          }
        } catch (error) { await report({ projectId }, error); failures.push({ projectId, code: error.code ?? 'BOT_PROVIDER_UNAVAILABLE' }); }
      }
      for (const [name, { gateway }] of gateways) if (!desired.has(name)) { await gateway.stop(); gateways.delete(name); }
      return { failures };
    });
    configuration = next.catch(() => {}); return next;
  };
  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => { timer = null; void tick().catch((error) => report({}, error)).finally(schedule); }, pollIntervalMs);
    timer.unref?.();
  };
  return { resolveJiraContext, resolveDiscordTarget, tick, reconfigure,
    async start() { if (!stopped) return; stopped = false; const configured = await reconfigure(); const result = await tick(); schedule(); return { failures: [...(configured?.failures ?? []), ...result.failures] }; },
    async stop() { stopped = true; clearTimeout(timer); timer = null; await configuration; if (running) await running;
      for (const { gateway } of gateways.values()) await gateway.stop(); gateways.clear();
    },
  };
}
