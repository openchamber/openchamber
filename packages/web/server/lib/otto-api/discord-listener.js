import WebSocket from 'ws';
import crypto from 'node:crypto';
import { createDiscordModelWizard } from './discord-model-wizard.js';
import { createDiscordCommandWizards } from './discord-command-wizards.js';
import { registerApplicationCommands } from './discord-commands.js';
import { resolveDiscordMentions } from './messenger-attachments.js';
import { parseLeadingCommand, COMMAND_HELP } from './messenger-commands.js';

// Console commands that can be triggered from chat with a `!` prefix. Discord
// reserves `/` for its native slash-command UI, so `!cmd` is the natural
// text-command prefix; these route through the same bridge command pipeline
// as `/cmd`.
const MESSENGER_COMMAND_NAMES = new Set(COMMAND_HELP.map((c) => c.name));

/**
 * Discord Gateway listener registry, keyed by bot token.
 *
 * Talks Discord Gateway v10 over WebSocket directly using `ws` (no discord.js)
 * so we don't pull a megabyte-sized lib into the web server. We implement the
 * minimal subset needed for messenger-sync:
 *  - HELLO + heartbeat with the server-supplied interval
 *  - IDENTIFY with intents = GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES |
 *    MESSAGE_CONTENT  (and we receive INTERACTION_CREATE without any intent)
 *  - DISPATCH events:
 *      READY        — capture session_id + resume_gateway_url
 *      MESSAGE_CREATE — broadcast over /ws/otto/events + push into ring buffer
 *                      + (optional) auto-reply via REST
 *      INTERACTION_CREATE — for button clicks on approval messages: broadcast
 *                      a structured event + ACK the interaction
 *
 * The mapping from inbound message → store is identical in shape to the
 * Telegram listener so the UI can render a single 'recent messages' list.
 *
 * State is in-memory only; UI re-starts the listener after reload.
 */

const RECENT_BUFFER_SIZE = 25;
const GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';
const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30_000;

const INTENT_GUILDS = 1 << 0;
const INTENT_GUILD_MESSAGES = 1 << 9;
const INTENT_DIRECT_MESSAGES = 1 << 12;
const INTENT_MESSAGE_CONTENT = 1 << 15;
const DEFAULT_INTENTS =
  INTENT_GUILDS | INTENT_GUILD_MESSAGES | INTENT_DIRECT_MESSAGES | INTENT_MESSAGE_CONTENT;

const OP_DISPATCH = 0;
const OP_HEARTBEAT = 1;
const OP_IDENTIFY = 2;
const OP_RESUME = 6;
const OP_RECONNECT = 7;
const OP_INVALID_SESSION = 9;
const OP_HELLO = 10;
const OP_HEARTBEAT_ACK = 11;

const listeners = new Map();

function tokenKey(token) {
  return String(token);
}

async function restCall(token, method, path, body) {
  const url = `https://discord.com/api/v10${path}`;
  const init = {
    method,
    headers: { Authorization: `Bot ${token}` },
  };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const r = await fetch(url, init);
  return { ok: r.ok, status: r.status, body: r.ok ? await r.json().catch(() => null) : await r.text() };
}

function buildAutoReply(message) {
  const text = typeof message.content === 'string' ? message.content.trim() : '';
  const fromName =
    message.author?.global_name ||
    message.author?.username ||
    'there';

  if (text.startsWith('/start') || text.toLowerCase().startsWith('!ping')) {
    return `pong — OpenChamber agent is listening (last update at ${new Date().toISOString()})`;
  }
  if (text.toLowerCase().startsWith('!help')) {
    return [
      'OpenChamber agent commands:',
      '`!ping` — health check',
      '`!status` — listener status',
      '`!help` — this message',
    ].join('\n');
  }
  if (text.toLowerCase().startsWith('!status')) {
    return `OpenChamber agent listener is online. Reply received from ${fromName}.`;
  }
  // No echo. Only explicit `!cmd` shortcuts get a reply. We deliberately do NOT
  // mirror arbitrary user text back ("OpenChamber agent received: ...") — when a user writes
  // from Discord they should only ever see OpenChamber agent's real OpenCode responses, never
  // a quoted copy of their own message.
  return null;
}

// Cached lookups for mention resolution (<@&role> / <#channel> → names).
// Names rarely change; a small TTL cache avoids a REST call per message.
const MENTION_LOOKUP_TTL_MS = 10 * 60_000;
const guildRolesCache = new Map(); // guildId → { at, roles: Map<id, name> }
const channelNameCache = new Map(); // channelId → { at, name }

async function lookupGuildRoleName(state, guildId, roleId) {
  if (!guildId || !roleId) return null;
  const cached = guildRolesCache.get(guildId);
  if (cached && Date.now() - cached.at < MENTION_LOOKUP_TTL_MS) {
    return cached.roles.get(roleId) ?? null;
  }
  const r = await restCall(state.token, 'GET', `/guilds/${encodeURIComponent(guildId)}/roles`);
  if (!r.ok || !Array.isArray(r.body)) return null;
  const roles = new Map(r.body.filter((role) => role?.id).map((role) => [String(role.id), role.name ?? null]));
  guildRolesCache.set(guildId, { at: Date.now(), roles });
  return roles.get(roleId) ?? null;
}

async function lookupChannelName(state, channelId) {
  if (!channelId) return null;
  const cached = channelNameCache.get(channelId);
  if (cached && Date.now() - cached.at < MENTION_LOOKUP_TTL_MS) {
    return cached.name;
  }
  const r = await restCall(state.token, 'GET', `/channels/${encodeURIComponent(channelId)}`);
  const name = r.ok ? r.body?.name ?? null : null;
  channelNameCache.set(channelId, { at: Date.now(), name });
  return name;
}

function inboundFromMessage(message) {
  return {
    updateId: message.id,
    chatId: message.channel_id,
    chatTitle: null,
    chatType: message.guild_id ? 'guild' : 'dm',
    threadId: null,
    from: {
      id: message.author?.id ? Number(message.author.id) || message.author.id : null,
      username: message.author?.username ?? null,
      firstName: message.author?.global_name ?? null,
      isBot: Boolean(message.author?.bot),
    },
    text: message.content ?? null,
    receivedAt: new Date().toISOString(),
    // Extra discord-only fields:
    discord: {
      guildId: message.guild_id ?? null,
      messageId: message.id,
      authorId: message.author?.id ?? null,
    },
  };
}

async function dispatchMessageCreate(state, message, broadcastEvent, bridge) {
  // Always count the raw event so the user can tell the difference between
  // "Gateway delivers no messages" (intent / permission issue) and
  // "Gateway delivers messages but we filter them all out" (wrong guildId
  // saved). Both used to look identical to the user.
  state.totalRawMessages += 1;
  state.lastRawMessageAt = Date.now();
  state.lastRawMessageGuildId = message.guild_id ?? null;

  // Optional guild filter — kept for cases where someone explicitly wants to
  // limit a token to one server, but off by default. When the configured
  // guildId doesn't match we record the mismatch so the UI can flag it
  // (previously the message just disappeared).
  if (state.scopeToGuild && state.guildId && message.guild_id && message.guild_id !== state.guildId) {
    state.filteredOutCount += 1;
    state.lastFilteredGuildId = message.guild_id;
    return;
  }

  const inbound = inboundFromMessage(message);
  state.recent.push(inbound);
  if (state.recent.length > RECENT_BUFFER_SIZE) {
    state.recent.splice(0, state.recent.length - RECENT_BUFFER_SIZE);
  }
  state.totalReceived += 1;
  state.lastUpdateAt = Date.now();

  try {
    broadcastEvent?.('messenger.discord.message_received', inbound);
  } catch {
    // ignore
  }

  if (message.author?.bot) return;
  if (state.botId && message.author?.id === state.botId) return;

  let text = typeof message.content === 'string' ? message.content.trim() : '';
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];

  // Mention-only mode: when enabled for a channel, new
  // conversations require an @mention of the bot. Surfaces that already
  // have a session binding (existing threads) keep working without it.
  if (
    bridge?.getMentionMode &&
    text.length > 0 &&
    bridge.getMentionMode({ type: 'discord', token: state.token, channelId: message.channel_id })
  ) {
    const mentionsBot =
      (state.botId && (Array.isArray(message.mentions) ? message.mentions : []).some((u) => u?.id === state.botId)) ||
      (state.botId && text.includes(`<@${state.botId}>`)) ||
      (state.botId && text.includes(`<@!${state.botId}>`));
    const hasBinding = bridge.hasSurfaceBinding?.({
      type: 'discord',
      token: state.token,
      channelId: message.channel_id,
      threadId: null,
    });
    if (!mentionsBot && !hasBinding) {
      return; // ignored by design — user must @mention the bot here
    }
    // Strip the bot mention from the prompt so the model doesn't see it.
    if (state.botId) {
      text = text.replaceAll(`<@${state.botId}>`, '').replaceAll(`<@!${state.botId}>`, '').trim();
    }
  }

  // Resolve raw Discord mention syntax (<@id>, <@&role>, <#channel>) into
  // human-readable names so the AI never sees opaque snowflakes.
  if (text.length > 0 && text.includes('<')) {
    try {
      text = await resolveDiscordMentions({
        text,
        message,
        lookupRole: (roleId) => lookupGuildRoleName(state, message.guild_id, roleId),
        lookupChannel: (channelId) => lookupChannelName(state, channelId),
      });
    } catch {
      // best-effort — fall back to the raw text
    }
  }

  // A leading `!` that names a known console command (e.g. `!status`,
  // `!model`) is routed through the bridge so it runs as a real messenger
  // command — the same pipeline as `/status`. Unknown `!cmd` shortcuts
  // (e.g. `!ping`) stay on the legacy auto-reply path below.
  const bangCommand =
    text.startsWith('!') ? parseLeadingCommand(text, { allowBang: true }) : null;
  const isKnownBangCommand = Boolean(bangCommand && MESSENGER_COMMAND_NAMES.has(bangCommand.name));

  // OpenCode bridge — every non-empty message that isn't an unknown `!cmd`
  // shortcut is forwarded to OpenCode and the streaming response is mirrored
  // back into the same channel/thread. This is what makes Discord a real
  // OpenChamber chat surface. Attachment-only messages (e.g. "send message
  // as file", screenshots, voice messages) are bridged too.
  const isBridgeable =
    bridge && state.bridgeEnabled !== false &&
    (text.length > 0 || attachments.length > 0) &&
    (!text.startsWith('!') || isKnownBangCommand);
  if (isBridgeable) {
    try {
      const project = state.resolveProject?.({
        channelId: message.channel_id,
        guildId: message.guild_id ?? null,
      });
      // Discord channels carry a `parent_id` only on threads. We can't tell
      // from the bare MESSAGE_CREATE payload whether channel_id is a regular
      // text channel or already inside a thread — the gateway delivers both
      // with the same shape. The bridge handles this with `sourceMessageId`:
      //  - if we're already in a thread, bind to it directly,
      //  - else spawn a thread on the user's message.
      // We pass message.id as sourceMessageId; if `channel_id` turns out to
      // be a thread (Discord's "Start Thread from Message" 400s with code
      // 50068 because threads can't host threads), the bridge falls back to
      // posting in the existing surface.
      const bridged = await bridge.routeInbound({
        type: 'discord',
        token: state.token,
        channelId: message.channel_id,
        threadId: null,
        sourceMessageId: message.id,
        text,
        attachments,
        projectPath: project?.path ?? null,
        projectLabel: project?.label ?? null,
        from: {
          id: message.author?.id,
          username: message.author?.username,
          firstName: message.author?.global_name ?? null,
        },
      });
      if (bridged.ok) {
        state.totalReplied += 1;
        state.lastError = null;
        return;
      }
      state.lastError = bridged.error ?? 'bridge failed';
    } catch (err) {
      state.lastError = err?.message ?? 'bridge failed';
    }
    // Bridge was attempted but failed — do NOT fall through to auto-reply.
    // The auto-reply sends a quoted message (message_reference) which would
    // duplicate the user's message in Discord. The bridge may have also
    // partially succeeded (OpenCode received the prompt) and will respond
    // via the SSE stream. We return silently to avoid the duplicate.
    return;
  }

  // Auto-reply fallback for `!cmd` shortcuts or when the bridge is off.
  if (!state.autoReply) return;
  const replyText = buildAutoReply(message);
  if (!replyText) return;

  try {
    const r = await restCall(state.token, 'POST', `/channels/${encodeURIComponent(message.channel_id)}/messages`, {
      content: replyText.slice(0, 2000),
      message_reference: {
        message_id: message.id,
        channel_id: message.channel_id,
        guild_id: message.guild_id,
        fail_if_not_exists: false,
      },
    });
    if (r.ok) {
      state.totalReplied += 1;
      broadcastEvent?.('messenger.discord.auto_reply', {
        chatId: message.channel_id,
        text: replyText,
        messageId: r.body?.id,
      });
    } else {
      state.lastError = `auto-reply failed: ${r.status} ${typeof r.body === 'string' ? r.body.slice(0, 200) : ''}`;
    }
  } catch (err) {
    state.lastError = err?.message ?? 'auto-reply failed';
  }
}

/**
 * Handle a Discord thread deletion or archival.
 * Cleans up the bridge state (session context, store binding) when a thread
 * is deleted or archived in Discord, so the OpenCode session doesn't stay
 * alive on the server for a thread that no longer exists.
 */
function dispatchThreadDelete(state, data, bridge, reason = 'deleted') {
  const threadId = data?.id;
  if (!threadId) return;

  state.totalThreadsDeleted = (state.totalThreadsDeleted || 0) + 1;

  try {
    bridge?.handleThreadDeleted?.({
      type: 'discord',
      threadId,
      token: state.token,
      // 'deleted' → also delete the OpenCode session (it leaves the UI);
      // 'archived' → only clean up bridge state (auto-archive must not destroy
      // the session).
      reason,
    });
  } catch (err) {
    state.lastError = err?.message ?? 'thread cleanup failed';
  }
}

/**
 * Known messenger command names that can be handled as native Discord slash commands.
 * Kept in sync with messenger-commands.js COMMAND_HELP.
 */
const KNOWN_SLASH_COMMANDS = new Set([
  'help', 'status', 'abort', 'new', 'undo', 'redo',
  'compact', 'summary', 'init', 'review', 'shell',
  'model', 'agent', 'verbosity', 'yolo', 'permissions', 'skill', 'sessions',
  'session', 'resume', 'fork', 'share', 'unshare',
  'queue', 'clear-queue', 'mention-mode',
  'new-worktree', 'merge-worktree', 'schedule',
]);

async function handleApplicationCommand(state, interaction, broadcastEvent, bridge) {
  const cmdName = interaction.data?.name;
  if (!cmdName || typeof cmdName !== 'string') return;

  // Only handle commands we know about — pass unknown ones through silently.
  if (!KNOWN_SLASH_COMMANDS.has(cmdName)) return;

  // Interactive wizard commands — handle with select menus instead of text.
  if (cmdName === 'model' && state.modelWizard) {
    await state.modelWizard.start(state, interaction);
    return;
  }
  if (state.commandWizards) {
    if (cmdName === 'verbosity') {
      await state.commandWizards.startVerbosity(state, interaction);
      return;
    }
    if (cmdName === 'agent') {
      await state.commandWizards.startAgent(state, interaction);
      return;
    }
    if (cmdName === 'skill') {
      await state.commandWizards.startSkill(state, interaction);
      return;
    }
    if (cmdName === 'yolo' || cmdName === 'permissions') {
      await state.commandWizards.startPermissions(state, interaction);
      return;
    }
  }

  // Ack immediately with a deferred ephemeral response so Discord doesn't
  // show "The application did not respond". We'll edit the message once
  // the command handler completes.
  try {
    await restCall(state.token, 'POST', `/interactions/${interaction.id}/${interaction.token}/callback`, {
      type: 5, // DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
      data: { flags: 64 }, // EPHEMERAL
    });
  } catch {
    return; // Can't ack — interaction already expired
  }

  // Slash-command options (e.g. `/summary topic:foo`) are forwarded to the text
  // pipeline as the command's argument string.
  const args = Array.isArray(interaction.data?.options)
    ? interaction.data.options
        .map((o) => (o?.value == null ? '' : String(o.value)))
        .filter(Boolean)
        .join(' ')
    : '';

  // Run the command through the bridge's command pipeline.
  if (bridge?.runCommand) {
    try {
      const user = interaction.member?.user ?? interaction.user ?? {};
      const result = await bridge.runCommand({
        type: 'discord',
        token: state.token,
        channelId: interaction.channel_id,
        threadId: null,
        commandName: cmdName,
        args,
        from: {
          id: user.id,
          username: user.username,
          firstName: user.global_name ?? null,
        },
      });

      if (result?.reply) {
        // Edit the deferred ephemeral message with the command output.
        await restCall(state.token, 'PATCH', `/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
          content: result.reply.slice(0, 2000),
        }).catch(() => {});
        state.totalReplied += 1;
        state.lastError = null;
        return;
      }
    } catch (err) {
      state.lastError = err?.message ?? 'command failed';
    }
  }

  // Fallback — edit with a generic error.
  await restCall(state.token, 'PATCH', `/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
    content: `✗ Command \`/${cmdName}\` failed. Try typing it as a text message instead.`,
  }).catch(() => {});
}

/**
 * Handle a question option pick (button or select menu). Acks the
 * interaction, records the decision via the bridge (which replies to
 * OpenCode once every question of the request is answered), and updates
 * the message to show the chosen answer with the components removed.
 */
async function handleQuestionComponent(state, interaction, customId, broadcastEvent, bridge) {
  const isSelect = customId.startsWith('otto-question-select:');
  const segments = customId.split(':');
  const questionId = segments[1] ?? '';
  const questionIndex = Number(segments[2] ?? '0');
  const optionValues = isSelect
    ? (Array.isArray(interaction.data?.values) ? interaction.data.values : [])
    : [segments[3]];

  // Ack within Discord's 3-second window (type 6 = DEFERRED_UPDATE_MESSAGE).
  try {
    const ackResult = await restCall(
      state.token,
      'POST',
      `/interactions/${interaction.id}/${interaction.token}/callback`,
      { type: 6 },
    );
    if (!ackResult.ok) {
      console.error('[DISCORD] Question ack failed:', ackResult.status, typeof ackResult.body === 'string' ? ackResult.body.slice(0, 200) : '');
    }
  } catch (e) {
    console.error('[DISCORD] Question ack threw:', e?.message ?? e);
  }

  let result = { ok: false, error: 'bridge unavailable' };
  try {
    result = bridge?.handleQuestionDecision?.(questionId, questionIndex, optionValues) ?? result;
  } catch (e) {
    console.error('[DISCORD] handleQuestionDecision threw:', e?.message ?? e);
    result = { ok: false, error: e?.message ?? 'question decision failed' };
  }

  const user = interaction.member?.user ?? interaction.user;
  const userName = user?.global_name || user?.username || 'user';
  const note = result.ok
    ? `_✅ ${result.labels.join(', ')} — by ${userName}_`
    : '_⚠ This question expired — reply with a text message instead._';
  const origContent = interaction.message?.content ?? '';
  const updatedContent = origContent ? `${origContent}\n\n${note}` : note;

  try {
    const patchResult = await restCall(
      state.token,
      'PATCH',
      `/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`,
      { content: updatedContent.slice(0, 2000), components: [] },
    );
    if (!patchResult.ok) {
      await restCall(state.token, 'PATCH', `/channels/${interaction.channel_id}/messages/${interaction.message?.id}`, {
        content: updatedContent.slice(0, 2000),
        components: [],
      }).catch((e2) => console.error('[DISCORD] Question direct PATCH also failed:', e2?.message ?? e2));
    }
  } catch (e) {
    console.error('[DISCORD] Question webhook PATCH threw:', e?.message ?? e);
  }

  broadcastEvent?.('messenger.discord.question', {
    questionId,
    questionIndex,
    answered: Boolean(result.ok),
    complete: Boolean(result.complete),
    labels: result.ok ? result.labels : [],
    by: { id: user?.id, username: user?.username, displayName: user?.global_name ?? null },
    messageId: interaction.message?.id ?? null,
    channelId: interaction.channel_id ?? null,
    guildId: interaction.guild_id ?? null,
    decidedAt: new Date().toISOString(),
  });
}

async function dispatchInteractionCreate(state, interaction, broadcastEvent, bridge) {
  // Type 1 = PING (auto-acked by Discord), 2 = APPLICATION_COMMAND (slash),
  // 3 = MESSAGE_COMPONENT (button/select), 5 = MODAL_SUBMIT.

  // Handle slash commands — route through the bridge's command pipeline.
  if (interaction.type === 2) {
    await handleApplicationCommand(state, interaction, broadcastEvent, bridge);
    return;
  }

  // We only care about MESSAGE_COMPONENT (type 3) interactions.
  if (interaction.type !== 3) return;

  const customId = interaction.data?.custom_id ?? '';

  // ── Model wizard select menus (provider → model → scope, paged) ────
  if (state.modelWizard?.ownsComponent(customId)) {
    await state.modelWizard.handleComponent(state, interaction, customId);
    return;
  }

  // ── Verbosity / agent / skill wizard select menus ──────────────────
  if (state.commandWizards?.ownsComponent(customId)) {
    await state.commandWizards.handleComponent(state, interaction, customId);
    return;
  }

  // ── Question option buttons / select menus ─────────────────────────
  // Parse: otto-question:{questionId}:{questionIndex}:{optionIndex} (button)
  //        otto-question-select:{questionId}:{questionIndex} (select menu)
  if (customId.startsWith('otto-question:') || customId.startsWith('otto-question-select:')) {
    await handleQuestionComponent(state, interaction, customId, broadcastEvent, bridge);
    return;
  }

  // ── Approval buttons ──────────────────────────────────────────────
  // Parse: otto-approve:{id} (once), otto-approve-always:{id}, otto-deny:{id}
  const value =
    customId.startsWith('otto-approve-always:') ? 'approve-always' :
    customId.startsWith('otto-approve:') ? 'approve' :
    customId.startsWith('otto-deny:') ? 'deny' :
    null;
  if (!value) return;

  const approvalId = customId.split(':')[1];
  const user = interaction.member?.user ?? interaction.user;
  const userName = user?.global_name || user?.username || 'user';
  const isApprove = value === 'approve' || value === 'approve-always';
  const emoji = isApprove ? (value === 'approve-always' ? '♻️' : '✅') : '❌';
  const verb = isApprove ? (value === 'approve-always' ? 'Approved Always' : 'Approved') : 'Denied';

  // Build the updated message content (remove buttons, show result)
  const origContent = interaction.message?.content ?? '';
  const updatedContent = origContent
    ? `${origContent}\n\n_${emoji} ${verb} by ${userName}_`
    : `${emoji} ${verb} by ${userName}`;

  // 1. Acknowledge the interaction immediately with type 6 (DEFERRED_UPDATE_MESSAGE).
  //    This must complete within Discord's 3-second window. Type 6 is a simple
  //    no-content ack — fast and always succeeds. After this we PATCH the message.
  try {
    const ackResult = await restCall(
      state.token,
      'POST',
      `/interactions/${interaction.id}/${interaction.token}/callback`,
      { type: 6 }, // DEFERRED_UPDATE_MESSAGE
    );
    if (!ackResult.ok) {
      console.error('[DISCORD] Deferred ack failed:', ackResult.status, typeof ackResult.body === 'string' ? ackResult.body.slice(0, 200) : '');
    }
  } catch (e) {
    console.error('[DISCORD] Deferred ack threw:', e?.message ?? e);
  }

  // 2. PATCH the original message to remove buttons and show the outcome.
  //    We use the webhook endpoint (no separate PATCH API call needed):
  //    PATCH /webhooks/{application_id}/{interaction.token}/messages/@original
  //    This works because we already responded with type 6.
  try {
    const patchResult = await restCall(
      state.token,
      'PATCH',
      `/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`,
      {
        content: updatedContent.slice(0, 2000),
        components: [],
      },
    );
    if (!patchResult.ok) {
      console.error('[DISCORD] Webhook PATCH failed:', patchResult.status, typeof patchResult.body === 'string' ? patchResult.body.slice(0, 200) : '');
      // Fallback: direct PATCH
      await restCall(state.token, 'PATCH', `/channels/${interaction.channel_id}/messages/${interaction.message?.id}`, {
        content: updatedContent.slice(0, 2000),
        components: [],
      }).catch((e2) => console.error('[DISCORD] Direct PATCH also failed:', e2?.message ?? e2));
    }
  } catch (e) {
    console.error('[DISCORD] Webhook PATCH threw:', e?.message ?? e);
  }

  // 2. Directly respond to OpenCode via the bridge (bypasses event hub)
  try {
    bridge?.handleApprovalDecision?.(approvalId, value);
  } catch (e) {
    console.error('[DISCORD] handleApprovalDecision threw:', e?.message ?? e);
  }

  // 3. Broadcast for UI clients (MessengerSection ApprovalsPanel)
  broadcastEvent?.('messenger.discord.approval', {
    approvalId,
    decision: value,
    by: { id: user?.id, username: user?.username, displayName: user?.global_name ?? null },
    messageId: interaction.message?.id ?? null,
    channelId: interaction.channel_id ?? null,
    guildId: interaction.guild_id ?? null,
    decidedAt: new Date().toISOString(),
  });
}

function send(ws, payload) {
  try {
    ws.send(JSON.stringify(payload));
  } catch {
    // ignore — WS may be closing
  }
}

/**
 * Register the OpenChamber agent slash commands for this listener's bot, once per process.
 * Guild-scoped when a guildId is configured (instant), otherwise global.
 */
async function ensureSlashCommandsRegistered(state) {
  if (state.slashCommandsRegistered) return;
  if (!state.applicationId) return;
  state.slashCommandsRegistered = true; // mark up-front so we don't double-fire
  try {
    const result = await registerApplicationCommands({
      restCall,
      token: state.token,
      applicationId: state.applicationId,
      guildId: state.guildId || null,
    });
    if (result.ok) {
      console.log(`[DISCORD] Registered slash commands (${result.scope} scope).`);
    } else {
      // Allow a retry on the next READY (e.g. transient 5xx or missing scope
      // that the user fixes by re-inviting the bot with applications.commands).
      state.slashCommandsRegistered = false;
      console.warn(
        `[DISCORD] Slash command registration failed (${result.scope}):`,
        result.error ?? `HTTP ${result.status}`,
      );
    }
  } catch (err) {
    state.slashCommandsRegistered = false;
    console.warn('[DISCORD] Slash command registration threw:', err?.message ?? err);
  }
}

function startSession(state, broadcastEvent, bridge) {
  if (state.stopRequested) return;
  let ws;
  try {
    ws = new WebSocket(GATEWAY_URL);
  } catch (err) {
    state.lastError = err?.message ?? 'gateway connect failed';
    return scheduleReconnect(state, broadcastEvent, bridge);
  }
  state.ws = ws;
  state.heartbeatAcked = true;

  ws.on('open', () => {
    state.consecutiveErrors = 0;
  });

  ws.on('message', (raw) => {
    let payload;
    try {
      payload = JSON.parse(raw.toString('utf-8'));
    } catch {
      return;
    }
    if (typeof payload.s === 'number') state.sequence = payload.s;

    switch (payload.op) {
      case OP_HELLO: {
        const interval = payload.d?.heartbeat_interval ?? 41250;
        state.heartbeatTimer = setInterval(() => {
          if (!state.heartbeatAcked) {
            try {
              ws.close(4000, 'no heartbeat ack');
            } catch {}
            return;
          }
          state.heartbeatAcked = false;
          send(ws, { op: OP_HEARTBEAT, d: state.sequence });
        }, interval);
        send(ws, {
          op: OP_IDENTIFY,
          d: {
            token: state.token,
            intents: state.intents,
            properties: { os: 'linux', browser: 'otto-ui', device: 'otto-ui' },
            presence: {
              status: 'online',
              activities: [{ name: 'OpenChamber agent sync', type: 0 }],
            },
          },
        });
        return;
      }
      case OP_HEARTBEAT_ACK:
        state.heartbeatAcked = true;
        return;
      case OP_HEARTBEAT:
        send(ws, { op: OP_HEARTBEAT, d: state.sequence });
        return;
      case OP_RECONNECT:
        try {
          ws.close(4000, 'reconnect requested');
        } catch {}
        return;
      case OP_INVALID_SESSION:
        state.sessionId = null;
        try {
          ws.close(4000, 'invalid session');
        } catch {}
        return;
      case OP_DISPATCH: {
        const t = payload.t;
        if (t === 'READY') {
          state.sessionId = payload.d?.session_id ?? null;
          state.botId = payload.d?.user?.id ?? null;
          state.botUsername = payload.d?.user?.username ?? null;
          // Bots authenticate with the application id baked into the token, so
          // the bot user id doubles as the application id for command registration.
          state.applicationId = payload.d?.application?.id ?? state.botId ?? null;
          state.connected = true;
          state.lastError = null;
          // Register native slash commands so dropdown wizards + autocomplete
          // suggestions are available. Best-effort and idempotent (Discord
          // upserts by name); only run once per process per bot.
          void ensureSlashCommandsRegistered(state);
          broadcastEvent?.('messenger.discord.listener_ready', {
            botId: state.botId,
            botUsername: state.botUsername,
          });
          return;
        }
        if (t === 'MESSAGE_CREATE') {
          void dispatchMessageCreate(state, payload.d, broadcastEvent, bridge);
          return;
        }
        if (t === 'INTERACTION_CREATE') {
          void dispatchInteractionCreate(state, payload.d, broadcastEvent, bridge);
          return;
        }
        if (t === 'THREAD_DELETE') {
          void dispatchThreadDelete(state, payload.d, bridge, 'deleted');
          return;
        }
        if (t === 'CHANNEL_DELETE') {
          // A guild channel was deleted. If it maps to a project, the bridge
          // drops the binding and tells the web UI to unlink that project
          // (the two-way mirror of removing a project in the UI).
          void bridge?.handleChannelDeleted?.({
            channelId: payload.d?.id,
            token: state.token,
          });
          return;
        }
        if (t === 'CHANNEL_UPDATE') {
          // A guild text/announcement channel was edited. When the name of a
          // project-bound channel changes, mirror the rename back into the
          // project's label. The bridge no-ops for unbound channels.
          const type = payload.d?.type;
          if ((type === 0 || type === 5) && payload.d?.id && payload.d?.name) {
            void bridge?.handleChannelRenamed?.({
              channelId: payload.d.id,
              name: payload.d.name,
              token: state.token,
            });
          }
          return;
        }
        if (t === 'THREAD_UPDATE') {
          // When a thread is archived (not just edited), clean up bridge state
          // but DON'T delete the session — a thread can auto-archive after
          // inactivity and be reopened later.
          const meta = payload.d?.thread_metadata;
          if (meta?.archived === true) {
            void dispatchThreadDelete(state, payload.d, bridge, 'archived');
          }
          return;
        }
        return;
      }
      default:
        return;
    }
  });

  const cleanupAndMaybeReconnect = (codeOrErr) => {
    if (state.heartbeatTimer) {
      clearInterval(state.heartbeatTimer);
      state.heartbeatTimer = null;
    }
    state.connected = false;
    state.lastDisconnectAt = Date.now();
    if (state.totalReconnects === undefined) state.totalReconnects = 0;
    state.ws = null;
    if (codeOrErr instanceof Error) state.lastError = codeOrErr.message;
    if (state.stopRequested) {
      state.running = false;
      return;
    }
    scheduleReconnect(state, broadcastEvent, bridge);
  };

  ws.on('close', (code, reason) => {
    if (code && code !== 1000) {
      state.lastError = `gateway closed ${code}${reason ? ` — ${reason.toString().slice(0, 200)}` : ''}`;
    }
    // 4014 = disallowed intent — most commonly MESSAGE_CONTENT not enabled in dev portal.
    if (code === 4014) {
      state.lastError =
        'Gateway 4014: Message Content intent is not enabled. Open the Discord Developer Portal → your app → Bot → enable "MESSAGE CONTENT INTENT", then restart the listener.';
      state.stopRequested = true;
    }
    if (code === 4004) {
      state.lastError = 'Gateway 4004: Invalid bot token.';
      state.stopRequested = true;
    }
    cleanupAndMaybeReconnect();
  });

  ws.on('error', (err) => {
    state.consecutiveErrors += 1;
    cleanupAndMaybeReconnect(err);
  });
}

function scheduleReconnect(state, broadcastEvent, bridge) {
  if (state.stopRequested) {
    state.running = false;
    return;
  }

  // Exponential backoff with jitter: base * 2^consecutiveErrors, capped at max,
  // then ±25% jitter to avoid thundering herd if multiple listeners reconnect.
  const exponential = RECONNECT_BASE_DELAY_MS * Math.pow(2, Math.min(state.consecutiveErrors, 10));
  const clamped = Math.min(exponential, RECONNECT_MAX_DELAY_MS);
  const jitter = clamped * (0.75 + Math.random() * 0.5); // ±25%
  const delay = Math.round(jitter);

  console.log(
    `[DISCORD] Reconnecting in ${delay}ms ` +
    `(attempt #${(state.totalReconnects || 0) + 1}, consecutiveErrors=${state.consecutiveErrors}, ` +
    `lastError=${state.lastError?.slice(0, 80) || 'none'})`
  );

  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    startSession(state, broadcastEvent, bridge);
  }, delay);
}

export function createDiscordListenerRegistry({ broadcastEvent, bridge = null } = {}) {
  // Interactive select-menu wizards, shared across every listener token started
  // by this registry; wizard state is keyed by hash so one instance is safe.
  const modelWizard = createDiscordModelWizard({ restCall, bridge });
  const commandWizards = createDiscordCommandWizards({ restCall, bridge });

  function start(token, opts = {}) {
    const key = tokenKey(token);
    const existing = listeners.get(key);
    if (existing && existing.running) {
      return { ok: true, alreadyRunning: true, ...statusSnapshot(existing) };
    }
    const state = {
      token,
      guildId: opts.guildId ?? null,
      // Off by default so a multi-server bot's events all reach the UI. When
      // explicitly requested via opts.scopeToGuild, we still filter — but
      // record what we filter so the user can tell why.
      scopeToGuild: Boolean(opts.scopeToGuild),
      intents: opts.intents ?? DEFAULT_INTENTS,
      autoReply: opts.autoReply !== false,
      bridgeEnabled: opts.bridgeEnabled !== false,
      resolveProject: opts.resolveProject ?? null,
      ws: null,
      heartbeatTimer: null,
      heartbeatAcked: true,
      sequence: null,
      sessionId: null,
      botId: null,
      botUsername: null,
      connected: false,
      running: true,
      stopRequested: false,
      startedAt: Date.now(),
      lastUpdateAt: null,
      lastDisconnectAt: null,
      lastError: null,
      consecutiveErrors: 0,
      totalReconnects: 0,
      totalReceived: 0,
      totalReplied: 0,
      totalRawMessages: 0,
      lastRawMessageAt: null,
      lastRawMessageGuildId: null,
      filteredOutCount: 0,
      lastFilteredGuildId: null,
      totalThreadsDeleted: 0,
      recent: [],
      reconnectTimer: null,
      applicationId: null,
      slashCommandsRegistered: false,
      modelWizard,
      commandWizards,
    };
    listeners.set(key, state);
    startSession(state, broadcastEvent, bridge);
    return { ok: true, alreadyRunning: false, ...statusSnapshot(state) };
  }

  function stop(token) {
    const key = tokenKey(token);
    const state = listeners.get(key);
    if (!state) return { ok: true, running: false };
    state.stopRequested = true;
    state.running = false;
    if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
    if (state.heartbeatTimer) clearInterval(state.heartbeatTimer);
    if (state.ws) {
      try {
        state.ws.close(1000, 'stop requested');
      } catch {
        // ignore
      }
    }
    listeners.delete(key);
    return { ok: true, running: false, stoppedAt: new Date().toISOString() };
  }

  function status(token) {
    const state = listeners.get(tokenKey(token));
    if (!state) return { ok: true, running: false };
    return { ok: true, ...statusSnapshot(state) };
  }

  function recent(token, limit = RECENT_BUFFER_SIZE) {
    const state = listeners.get(tokenKey(token));
    if (!state) return { ok: true, messages: [], running: false };
    const n = Math.max(1, Math.min(RECENT_BUFFER_SIZE, Number(limit) || RECENT_BUFFER_SIZE));
    return {
      ok: true,
      running: state.running,
      connected: state.connected,
      messages: state.recent.slice(-n).reverse(),
    };
  }

  function statusSnapshot(state) {
    return {
      running: state.running,
      connected: state.connected,
      autoReply: state.autoReply,
      bridgeEnabled: state.bridgeEnabled,
      scopeToGuild: state.scopeToGuild,
      guildId: state.guildId,
      botId: state.botId,
      botUsername: state.botUsername,
      startedAt: state.startedAt,
      lastUpdateAt: state.lastUpdateAt,
      lastError: state.lastError,
      totalReceived: state.totalReceived,
      totalReplied: state.totalReplied,
      totalRawMessages: state.totalRawMessages,
      lastRawMessageAt: state.lastRawMessageAt,
      lastRawMessageGuildId: state.lastRawMessageGuildId,
      filteredOutCount: state.filteredOutCount,
      lastFilteredGuildId: state.lastFilteredGuildId,
      recentCount: state.recent.length,
    };
  }

  /** Allow other modules (e.g. diagnose) to peek at the live state. */
  function inspect(token) {
    const state = listeners.get(tokenKey(token));
    if (!state) return null;
    return statusSnapshot(state);
  }

  return { start, stop, status, recent, inspect };
}

export function generateApprovalId() {
  return `appr_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
}

export { DEFAULT_INTENTS };
