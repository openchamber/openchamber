import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { getSafeStorage } from './utils/safeStorage';
import { useProjectsStore } from './useProjectsStore';
import type { ProjectEntry } from '@/lib/api/types';

export type MessengerType = 'discord';
export type SyncMode = 'full' | 'notifications' | 'off';
export type MessengerVerbosity = 'quiet' | 'normal' | 'verbose';

/** Tool permission mode for the OpenCode bridge (`/yolo` / `/permissions`). */
export type MessengerPermissionMode = 'ask' | 'auto-edit' | 'yolo';

export interface MessengerConnection {
  type: MessengerType;
  enabled: boolean;
  status: 'disconnected' | 'connecting' | 'connected' | 'error';
  error: string | null;
  lastConnectedAt: number | null;

  // Discord-specific
  botToken?: string;
  guildId?: string;
  guildName?: string;
  /** Default Discord channel id that summary / test messages are sent to. */
  defaultChannelId?: string;
  /**
   * Discord user id of the bot's human owner. Web-created threads are
   * auto-joined by this user so they appear under the channel for them.
   */
  defaultUserId?: string;
  discordBotId?: string;
  discordBotUsername?: string;
  discordBotDiscriminator?: string;
  discordChannelName?: string;
  discordChannelType?: number;
  discordChannelTypeLabel?: string;
  discordGuilds?: { id: string; name: string }[];
  /** Cached invite URL built from discordBotId so the user can re-invite the bot. */
  discordInviteUrl?: string;
  // ---- Server-wide sync state ----
  /** Discord guild (server) id selected for per-project channel sync. */
  discordGuildId?: string;
  discordGuildIconHash?: string | null;
  /** Channels listed by /discord/resolve-guild (only post-able types). */
  discordGuildChannels?: {
    id: string;
    name: string;
    type: number;
    parentId: string | null;
  }[];
  /** Categories (channel type 4) — used for the "create channels under this category" picker. */
  discordGuildCategories?: { id: string; name: string }[];
  discordGuildActiveThreadCount?: number;
  /** Selected category id to nest new project channels under (optional). */
  discordParentCategoryId?: string;
  /** Whether sync-now should start a thread from each project status message. */
  discordCreateThreads?: boolean;
  webhookSecret?: string;

  // Last activity (test message / sync now)
  lastSyncAt: number | null;
  lastSyncStatus: 'idle' | 'sending' | 'ok' | 'error';
  lastSyncMessage: string | null;
  /** Per-project results from the most recent Discord guild sync. */
  lastSyncChannels?: {
    projectId: string;
    projectPath?: string | null;
    projectLabel: string;
    channelId: string | null;
    channelName: string | null;
    messageId: string | null;
    threadId: string | null;
    threadName: string | null;
    created: boolean;
    threadCreated: boolean;
    /** True when the request asked for a thread (toggle was on at sync time). */
    threadRequested?: boolean;
    /** Channel / message-level error — fatal for this row. */
    error: string | null;
    /** Thread-level error only — channel + message still succeeded. */
    threadError?: string | null;
  }[];

  // Discord Gateway listener state.
  discordListenerRunning?: boolean;
  discordListenerConnected?: boolean;
  discordListenerStartedAt?: number | null;
  discordListenerLastUpdateAt?: number | null;
  discordListenerTotalReceived?: number;
  discordListenerTotalReplied?: number;
  /** Every MESSAGE_CREATE the gateway delivered, even those filtered out. */
  discordListenerTotalRawMessages?: number;
  discordListenerLastRawMessageAt?: number | null;
  discordListenerLastRawMessageGuildId?: string | null;
  discordListenerFilteredOutCount?: number;
  discordListenerLastFilteredGuildId?: string | null;
  discordListenerError?: string | null;
  discordListenerAutoReply?: boolean;
  /** When true, scope the listener strictly to the saved Server (Guild) ID. */
  discordListenerScopeToGuild?: boolean;
  /**
   * Bridge inbound channel/chat messages to OpenCode (default true). When
   * off, the listener only does the legacy "OpenChamber agent received: ..." auto-reply.
   */
  bridgeEnabled?: boolean;

  // Sync config
  syncMode: SyncMode;
  syncProjects: boolean;
  syncTasks: boolean;
  syncSchedule: boolean;
  autoCreateThreads: boolean;
}

export interface ProjectMessengerMapping {
  projectId: string;
  projectLabel: string;
  discord?: {
    channelId: string;
    channelName: string;
    /** Stored from previous sync so threads are re-used instead of created. */
    threadId?: string;
    threadName?: string;
  };
}

export interface MessengerDiagnosisCheck {
  id: string;
  ok: boolean;
  severity: 'ok' | 'warn' | 'error' | 'info';
  title: string;
  detail: string;
  fix?: string;
}

export interface MessengerInboundMessage {
  /** Discord message id. */
  updateId: number | string;
  chatId: number | string | null;
  chatTitle: string | null;
  chatType: string | null;
  threadId: number | string | null;
  from:
    | {
        id: number | string | null;
        username: string | null;
        firstName: string | null;
        isBot: boolean;
      }
    | null;
  text: string | null;
  receivedAt: string;
  /** Discord-only extras (guildId, messageId etc.) when present. */
  discord?: {
    guildId: string | null;
    messageId: string;
    authorId: string | null;
  };
}

export interface DiscordHistoryMessage {
  id: string;
  channelId: string;
  content: string;
  timestamp: string;
  author: {
    id: string;
    username: string | null;
    globalName: string | null;
    isBot: boolean;
  };
  attachmentCount: number;
}

export type MessengerApprovalDecision = 'approve' | 'approve-always' | 'deny';

export interface MessengerApproval {
  id: string;
  type: MessengerType;
  prompt: string;
  /** Discord channel_id. */
  target: string;
  /** Discord message id. */
  messageId: string | number | null;
  sentAt: number;
  decision: MessengerApprovalDecision | null;
  decidedAt: number | null;
  decidedBy: string | null;
  error: string | null;
  /** OpenCode session ID that this approval is for (optional). */
  sessionID?: string;
  /** OpenCode permission request ID. */
  requestID?: string;
  /** Tool name (bash, read, edit, webfetch, external_directory, etc.). */
  permissionTool?: string;
  /** Rich permission context rendered for display. */
  permissionContext?: string;
}

interface MessengerState {
  connections: MessengerConnection[];
  projectMappings: ProjectMessengerMapping[];
  onboardingStep: number | null;
  onboardingType: MessengerType | null;

  /** Same shape for Discord — newest first, capped at 50. */
  discordInbound: MessengerInboundMessage[];
  /** Last-50-messages history fetched via /discord/history. */
  discordHistory: DiscordHistoryMessage[];

  /** Latest diagnose-run output. Cleared when token/guild id changes. */
  discordDiagnosis: {
    runAt: number;
    ok: boolean;
    checks: MessengerDiagnosisCheck[];
  } | null;
  discordDiagnosisRunning: boolean;

  /** Pending + answered approvals, newest first. */
  approvals: MessengerApproval[];

  /**
   * Snapshot of OpenCode↔messenger session bindings (per channel/topic) +
   * in-flight prompt contexts. Refreshed on demand from /bridge/status.
   */
  bridgeStatus: {
    enabled: boolean;
    bindings: {
      type: MessengerType;
      targetKey: string;
      sessionId: string;
      projectPath: string | null;
      projectLabel: string | null;
      createdAt: string;
      lastUsedAt: string;
    }[];
    active: {
      type: MessengerType;
      channelId: string;
      threadId: string | null;
      messageId: string | number | null;
      startedAt: number;
      lastError: string | null;
    }[];
  };

  /**
   * Per-messenger default output verbosity for the OpenCode bridge
   * (`quiet` | `normal` | `verbose`). `null` means "never configured —
   * the bridge uses its built-in `normal` default". Mirrors the in-chat
   * `/verbosity default <level>` command; refreshed from /bridge/status.
   */
  bridgeVerbosity: Partial<Record<MessengerType, MessengerVerbosity | null>>;

  /**
   * Per-messenger default tool permission mode for the OpenCode bridge
   * (`ask` | `auto-edit` | `yolo`). `null` means "never configured — the
   * bridge uses its built-in `ask` default". Mirrors `/yolo default <mode>`
   * / `/permissions default <mode>`; refreshed from /bridge/status.
   */
  bridgePermissionMode: Partial<Record<MessengerType, MessengerPermissionMode | null>>;

  addConnection: (type: MessengerType) => void;
  updateConnection: (type: MessengerType, updates: Partial<MessengerConnection>) => void;
  removeConnection: (type: MessengerType) => void;
  testConnection: (type: MessengerType) => Promise<boolean>;
  resolveDiscordChannel: () => Promise<boolean>;
  resolveDiscordGuild: () => Promise<boolean>;
  fetchDiscordInviteUrl: () => Promise<string | null>;
  syncDiscordGuildProjects: (
    projects: { id: string; label: string; body: string }[],
    summary: string,
  ) => Promise<boolean>;
  sendTestMessage: (type: MessengerType) => Promise<boolean>;
  sendSyncSummary: (type: MessengerType, summary: string) => Promise<boolean>;
  diagnoseDiscord: () => Promise<boolean>;
  refreshBridgeStatus: (type?: MessengerType) => Promise<void>;
  setBridgeVerbosity: (type: MessengerType, level: MessengerVerbosity) => Promise<boolean>;
  setBridgePermissionMode: (
    type: MessengerType,
    mode: MessengerPermissionMode,
  ) => Promise<boolean>;
  saveDiscordConfig: () => Promise<void>;
  startDiscordListener: () => Promise<boolean>;
  stopDiscordListener: () => Promise<boolean>;
  refreshDiscordListenerStatus: () => Promise<void>;
  loadRecentDiscordMessages: () => Promise<void>;
  ingestDiscordInbound: (msg: MessengerInboundMessage) => void;
  loadDiscordHistory: (channelId: string, limit?: number) => Promise<boolean>;
  sendApprovalRequest: (
    type: MessengerType,
    prompt: string,
    opts?: {
      target?: string;
      threadId?: string;
      /** Structured permission data for rich rendering in messenger. */
      permission?: {
        id?: string;
        sessionID?: string;
        permission?: string;
        patterns?: string[];
        metadata?: Record<string, unknown>;
        always?: string[];
      };
    },
  ) => Promise<MessengerApproval | null>;
  ingestApprovalDecision: (
    approvalId: string,
    decision: MessengerApprovalDecision,
    by: string | null,
  ) => void;
  clearApprovals: () => void;
  setProjectMapping: (mapping: ProjectMessengerMapping) => void;
  removeProjectMapping: (projectId: string) => void;
  /**
   * Project lifecycle → Discord channel sync. Called when a project is
   * added/renamed/removed in the UI so each project gets its own channel
   * (instead of web conversations dumping into the default/#general channel).
   * No-ops unless a Discord connection with a bot token + Server ID is
   * configured and project sync is enabled.
   */
  ensureProjectChannel: (project: ProjectEntry) => Promise<void>;
  renameProjectChannel: (project: ProjectEntry) => Promise<void>;
  removeProjectChannel: (projectId: string, projectPath: string) => Promise<void>;
  startOnboarding: (type: MessengerType) => void;
  nextOnboardingStep: () => void;
  prevOnboardingStep: () => void;
  finishOnboarding: () => void;
}

const DEFAULT_CONNECTION: Omit<MessengerConnection, 'type'> = {
  enabled: false,
  status: 'disconnected',
  error: null,
  lastConnectedAt: null,
  lastSyncAt: null,
  lastSyncStatus: 'idle',
  lastSyncMessage: null,
  syncMode: 'full',
  syncProjects: true,
  syncTasks: true,
  syncSchedule: true,
  autoCreateThreads: true,
};

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (await res.json()) as T;
}

export const useMessengerStore = create<MessengerState>()(
  persist(
    (set, get) => ({
      connections: [],
      projectMappings: [],
      onboardingStep: null,
      onboardingType: null,
      discordInbound: [],
      discordHistory: [],
      discordDiagnosis: null,
      discordDiagnosisRunning: false,
      approvals: [],
      bridgeStatus: { enabled: false, bindings: [], active: [] },
      bridgeVerbosity: {},
      bridgePermissionMode: {},

      addConnection: (type) => {
        const existing = get().connections.find((c) => c.type === type);
        if (existing) return;
        set({ connections: [...get().connections, { ...DEFAULT_CONNECTION, type }] });
      },

      updateConnection: (type, updates) => {
        set({
          connections: get().connections.map((c) =>
            c.type === type ? { ...c, ...updates } : c,
          ),
        });
      },

      removeConnection: (type) => {
        set({
          connections: get().connections.filter((c) => c.type !== type),
          projectMappings: get().projectMappings.map((m) => {
            const next = { ...m };
            if (type === 'discord') delete next.discord;
            return next;
          }),
        });
      },

      testConnection: async (type) => {
        const conn = get().connections.find((c) => c.type === type);
        if (!conn) return false;

        get().updateConnection(type, { status: 'connecting', error: null });

        try {
          if (type === 'discord' && conn.botToken) {
            // Route through backend so we also get guild list + bot id in one call.
            const data = await postJson<{
              ok: boolean;
              error?: string;
              id?: string;
              username?: string;
              discriminator?: string;
              guilds?: { id: string; name: string }[];
            }>('/api/otto/messenger/test', { type: 'discord', token: conn.botToken });
            if (!data.ok) throw new Error(data.error ?? 'Discord API failed');
            get().updateConnection(type, {
              status: 'connected',
              lastConnectedAt: Date.now(),
              discordBotId: data.id,
              discordBotUsername: data.username,
              discordBotDiscriminator: data.discriminator,
              discordGuilds: data.guilds ?? [],
              guildName: data.guilds && data.guilds.length > 0 ? data.guilds[0].name : undefined,
            });
            // Best-effort: pre-fetch the invite URL so the user can re-invite if needed.
            if (data.id) {
              get().fetchDiscordInviteUrl();
            }
            return true;
          }

          throw new Error('No token configured');
        } catch (e) {
          get().updateConnection(type, {
            status: 'error',
            error: e instanceof Error ? e.message : 'Connection failed',
          });
          return false;
        }
      },

      resolveDiscordChannel: async () => {
        const conn = get().connections.find((c) => c.type === 'discord');
        if (!conn?.botToken || !conn.defaultChannelId) return false;
        try {
          const data = await postJson<{
            ok: boolean;
            error?: string;
            channelName?: string | null;
            channelType?: number;
            channelTypeLabel?: string;
            guildId?: string | null;
            guildName?: string | null;
          }>('/api/otto/messenger/discord/resolve-channel', {
            token: conn.botToken,
            channelId: conn.defaultChannelId,
          });
          if (!data.ok) {
            get().updateConnection('discord', { error: data.error ?? 'Could not resolve channel' });
            return false;
          }
          get().updateConnection('discord', {
            discordChannelName: data.channelName ?? undefined,
            discordChannelType: data.channelType,
            discordChannelTypeLabel: data.channelTypeLabel,
            guildId: data.guildId ?? undefined,
            guildName: data.guildName ?? undefined,
            error: null,
          });
          return true;
        } catch (e) {
          get().updateConnection('discord', {
            error: e instanceof Error ? e.message : 'resolve-channel failed',
          });
          return false;
        }
      },

      resolveDiscordGuild: async () => {
        const conn = get().connections.find((c) => c.type === 'discord');
        if (!conn?.botToken || !conn.discordGuildId) return false;
        try {
          const data = await postJson<{
            ok: boolean;
            error?: string;
            id?: string;
            name?: string;
            iconHash?: string | null;
            channels?: { id: string; name: string; type: number; parentId: string | null }[];
            categories?: { id: string; name: string }[];
            activeThreads?: { id: string; name: string; parentId: string | null }[];
            defaultChannelId?: string | null;
          }>('/api/otto/messenger/discord/resolve-guild', {
            token: conn.botToken,
            guildId: conn.discordGuildId,
          });
          if (!data.ok) {
            get().updateConnection('discord', { error: data.error ?? 'resolve-guild failed' });
            return false;
          }
          get().updateConnection('discord', {
            guildName: data.name ?? undefined,
            discordGuildIconHash: data.iconHash ?? null,
            discordGuildChannels: data.channels ?? [],
            discordGuildCategories: data.categories ?? [],
            discordGuildActiveThreadCount: data.activeThreads?.length ?? 0,
            // If no default channel was set yet, auto-pick the first text channel
            // of the server so Send-test-message just works.
            defaultChannelId: conn.defaultChannelId ?? data.defaultChannelId ?? undefined,
            error: null,
          });
          return true;
        } catch (e) {
          get().updateConnection('discord', {
            error: e instanceof Error ? e.message : 'resolve-guild failed',
          });
          return false;
        }
      },

      syncDiscordGuildProjects: async (projects, summary) => {
        const conn = get().connections.find((c) => c.type === 'discord');
        if (!conn?.botToken || !conn.discordGuildId) {
          get().updateConnection('discord', {
            lastSyncStatus: 'error',
            lastSyncMessage: 'Add Discord bot token and Server ID first',
          });
          return false;
        }

        const applySyncResponse = (
          data: {
            ok: boolean;
            error?: string;
            channels?: NonNullable<MessengerConnection['lastSyncChannels']>;
          },
        ) => {
          const results = data.channels ?? [];
          for (const r of results) {
            if (!r.channelId) continue;
            get().setProjectMapping({
              projectId: r.projectId,
              projectLabel: r.projectLabel,
              discord: {
                channelId: r.channelId,
                channelName: r.channelName ?? '',
                ...(r.threadId
                  ? { threadId: r.threadId, threadName: r.threadName ?? undefined }
                  : {}),
              },
            });
          }

          const errored = results.filter((r) => r.error);
          const threadFailed = results.filter((r) => r.threadError);
          const threadRequested = results.filter((r) => r.threadRequested).length;
          const createdCh = results.filter((r) => r.created).length;
          const createdTh = results.filter((r) => r.threadCreated).length;
          const postedMsgs = results.filter((r) => r.messageId).length;

          const parts: string[] = [];
          if (createdCh > 0) parts.push(`${createdCh} channel${createdCh === 1 ? '' : 's'} created`);
          if (postedMsgs > 0)
            parts.push(`${postedMsgs} message${postedMsgs === 1 ? '' : 's'} posted`);
          if (createdTh > 0) parts.push(`${createdTh} thread${createdTh === 1 ? '' : 's'} opened`);
          if (threadRequested > 0 && threadFailed.length > 0) {
            parts.push(
              `${threadFailed.length}/${threadRequested} thread${threadRequested === 1 ? '' : 's'} failed`,
            );
          }
          if (errored.length > 0)
            parts.push(`${errored.length} error${errored.length === 1 ? '' : 's'}`);
          const summaryMsg = parts.length > 0 ? parts.join(', ') + ' ✓' : 'Sync sent ✓';

          const hasAnyError = errored.length > 0 || threadFailed.length > 0;
          const firstErrorMsg = errored[0]?.error ?? threadFailed[0]?.threadError;

          get().updateConnection('discord', {
            lastSyncAt: Date.now(),
            lastSyncStatus: hasAnyError ? 'error' : 'ok',
            lastSyncMessage: hasAnyError
              ? `${summaryMsg} — first error: ${firstErrorMsg}`
              : summaryMsg,
            lastSyncChannels: results,
          });

          return {
            results,
            hasAnyError,
            rateLimited: [...errored, ...threadFailed].some((r) =>
              String(r.error ?? r.threadError ?? '').includes('429'),
            ),
          };
        };

        get().updateConnection('discord', {
          lastSyncStatus: 'sending',
          lastSyncMessage:
            projects.length > 0
              ? `Syncing ${projects.length} project${projects.length === 1 ? '' : 's'} to ${conn.guildName ?? 'server'}…`
              : 'Sending sync summary…',
        });

        const runSync = async () =>
          postJson<{
            ok: boolean;
            error?: string;
            channels?: NonNullable<MessengerConnection['lastSyncChannels']>;
          }>('/api/otto/messenger/discord/sync-projects', {
            token: conn.botToken,
            guildId: conn.discordGuildId,
            parentCategoryId: conn.discordParentCategoryId,
            createThreads: conn.discordCreateThreads !== false,
            summary,
            projects,
            mappings: get().projectMappings,
          });

        try {
          let data = await runSync();

          if (data.error && (!data.channels || data.channels.length === 0)) {
            get().updateConnection('discord', {
              lastSyncStatus: 'error',
              lastSyncMessage: data.error,
            });
            return false;
          }

          let outcome = applySyncResponse(data);

          if (outcome.rateLimited && outcome.hasAnyError) {
            get().updateConnection('discord', {
              lastSyncStatus: 'sending',
              lastSyncMessage: 'Discord rate limit hit — retrying failed items in a few seconds…',
            });
            await new Promise((resolve) => setTimeout(resolve, 5_000));
            data = await runSync();
            outcome = applySyncResponse(data);
          }

          return !outcome.hasAnyError;
        } catch (e) {
          get().updateConnection('discord', {
            lastSyncStatus: 'error',
            lastSyncMessage: e instanceof Error ? e.message : 'Sync failed',
          });
          return false;
        }
      },

      fetchDiscordInviteUrl: async () => {
        const conn = get().connections.find((c) => c.type === 'discord');
        if (!conn?.discordBotId) return null;
        try {
          const data = await postJson<{ ok: boolean; url?: string; error?: string }>(
            '/api/otto/messenger/discord/invite-url',
            { clientId: conn.discordBotId },
          );
          if (!data.ok || !data.url) return null;
          get().updateConnection('discord', { discordInviteUrl: data.url });
          return data.url;
        } catch {
          return null;
        }
      },

      sendTestMessage: async (type) => {
        const conn = get().connections.find((c) => c.type === type);
        if (!conn) return false;

        const token = conn.botToken;
        // Fall back to the first text channel of the resolved server if no
        // default channel is configured but a guild is set.
        let target = conn.defaultChannelId;
        if (!target && conn.discordGuildChannels && conn.discordGuildChannels.length > 0) {
          target = conn.discordGuildChannels[0].id;
        }
        if (!token || !target) {
          get().updateConnection(type, {
            lastSyncStatus: 'error',
            lastSyncMessage: 'Add a Discord channel ID or Server ID before sending',
          });
          return false;
        }

        get().updateConnection(type, {
          lastSyncStatus: 'sending',
          lastSyncMessage: 'Sending test message…',
        });

        const text = `**OpenChamber agent connected ✓**\nThis is a test message from your OpenChamber agent.\nOpenChamber agent can now post project updates to this channel.`;

        try {
          const data = await postJson<{ ok: boolean; error?: string }>(
            '/api/otto/messenger/send',
            { type, token, target, text },
          );
          if (!data.ok) {
            get().updateConnection(type, {
              lastSyncStatus: 'error',
              lastSyncMessage: data.error ?? 'Send failed',
            });
            return false;
          }
          get().updateConnection(type, {
            lastSyncAt: Date.now(),
            lastSyncStatus: 'ok',
            lastSyncMessage: 'Test message delivered ✓',
          });
          return true;
        } catch (e) {
          get().updateConnection(type, {
            lastSyncStatus: 'error',
            lastSyncMessage: e instanceof Error ? e.message : 'Send failed',
          });
          return false;
        }
      },

      sendSyncSummary: async (type, summary) => {
        const conn = get().connections.find((c) => c.type === type);
        if (!conn) return false;
        const token = conn.botToken;
        const target = conn.defaultChannelId;
        if (!token || !target) {
          get().updateConnection(type, {
            lastSyncStatus: 'error',
            lastSyncMessage: 'Add a Discord channel ID first',
          });
          return false;
        }
        get().updateConnection(type, {
          lastSyncStatus: 'sending',
          lastSyncMessage: 'Sending sync summary…',
        });
        try {
          const data = await postJson<{ ok: boolean; error?: string }>(
            '/api/otto/messenger/send',
            { type, token, target, text: summary },
          );
          if (!data.ok) {
            get().updateConnection(type, {
              lastSyncStatus: 'error',
              lastSyncMessage: data.error ?? 'Sync failed',
            });
            return false;
          }
          get().updateConnection(type, {
            lastSyncAt: Date.now(),
            lastSyncStatus: 'ok',
            lastSyncMessage: 'Sync summary sent ✓',
          });
          return true;
        } catch (e) {
          get().updateConnection(type, {
            lastSyncStatus: 'error',
            lastSyncMessage: e instanceof Error ? e.message : 'Sync failed',
          });
          return false;
        }
      },

      refreshBridgeStatus: async (type) => {
        const conn = type ? get().connections.find((c) => c.type === type) : undefined;
        const token = conn?.botToken;
        try {
          const data = await postJson<{
            ok: boolean;
            enabled?: boolean;
            bindings?: MessengerState['bridgeStatus']['bindings'];
            active?: MessengerState['bridgeStatus']['active'];
            verbosity?: Partial<Record<MessengerType, MessengerVerbosity | null>>;
            permissionMode?: Partial<Record<MessengerType, MessengerPermissionMode | null>>;
          }>('/api/otto/messenger/bridge/status', { type, token });
          set({
            bridgeStatus: {
              enabled: Boolean(data.enabled),
              bindings: data.bindings ?? [],
              active: data.active ?? [],
            },
            bridgeVerbosity: data.verbosity ?? get().bridgeVerbosity,
            bridgePermissionMode: data.permissionMode ?? get().bridgePermissionMode,
          });
        } catch {
          // ignore
        }
      },

      setBridgeVerbosity: async (type, level) => {
        try {
          const data = await postJson<{ ok: boolean; level?: MessengerVerbosity | null }>(
            '/api/otto/messenger/bridge/verbosity',
            { type, level },
          );
          if (!data.ok) return false;
          set({
            bridgeVerbosity: { ...get().bridgeVerbosity, [type]: data.level ?? level },
          });
          return true;
        } catch {
          return false;
        }
      },

      setBridgePermissionMode: async (type, mode) => {
        try {
          const data = await postJson<{ ok: boolean; mode?: MessengerPermissionMode | null }>(
            '/api/otto/messenger/bridge/permission-mode',
            { type, mode },
          );
          if (!data.ok) return false;
          set({
            bridgePermissionMode: {
              ...get().bridgePermissionMode,
              [type]: data.mode ?? mode,
            },
          });
          return true;
        } catch {
          return false;
        }
      },

      diagnoseDiscord: async () => {
        const conn = get().connections.find((c) => c.type === 'discord');
        if (!conn?.botToken) return false;
        set({ discordDiagnosisRunning: true });
        try {
          const data = await postJson<{
            ok: boolean;
            checks?: MessengerDiagnosisCheck[];
          }>('/api/otto/messenger/discord/diagnose', {
            token: conn.botToken,
            guildId: conn.discordGuildId,
            channelId: conn.defaultChannelId,
          });
          set({
            discordDiagnosis: {
              runAt: Date.now(),
              ok: Boolean(data.ok),
              checks: data.checks ?? [],
            },
            discordDiagnosisRunning: false,
          });
          return Boolean(data.ok);
        } catch (e) {
          set({
            discordDiagnosis: {
              runAt: Date.now(),
              ok: false,
              checks: [
                {
                  id: 'network',
                  ok: false,
                  severity: 'error',
                  title: 'Diagnose failed',
                  detail: e instanceof Error ? e.message : 'Unknown error',
                },
              ],
            },
            discordDiagnosisRunning: false,
          });
          return false;
        }
      },

      saveDiscordConfig: async () => {
        const conn = get().connections.find((c) => c.type === 'discord');
        if (!conn?.botToken) return;
        const projects = useProjectsStore.getState().projects;
        const projectBindings = get()
          .projectMappings.flatMap((m) => {
            if (!m.discord?.channelId) return [];
            const project = projects.find((p) => p.id === m.projectId);
            if (!project) return [];
            return [
              {
                channelId: m.discord.channelId,
                projectPath: project.path,
                projectLabel: project.label ?? project.path,
              },
            ];
          });
        try {
          await postJson('/api/otto/messenger/discord/save-config', {
            botToken: conn.botToken,
            guildId: conn.discordGuildId,
            autoReply: conn.discordListenerAutoReply !== false,
            scopeToGuild: Boolean(conn.discordListenerScopeToGuild),
            bridgeEnabled: conn.bridgeEnabled !== false,
            defaultChannelId: conn.defaultChannelId,
            defaultUserId: conn.defaultUserId,
            projectBindings,
          });
        } catch {
          // silent — config save is best-effort
        }
      },

      startDiscordListener: async () => {
        const conn = get().connections.find((c) => c.type === 'discord');
        if (!conn?.botToken) return false;
        const projects = useProjectsStore.getState().projects;
        const projectBindings = get()
          .projectMappings.flatMap((m) => {
            if (!m.discord?.channelId) return [];
            const project = projects.find((p) => p.id === m.projectId);
            if (!project) return [];
            return [
              {
                channelId: m.discord.channelId,
                projectPath: project.path,
                projectLabel: project.label ?? project.path,
              },
            ];
          });
        try {
          const data = await postJson<{
            ok: boolean;
            running?: boolean;
            connected?: boolean;
            startedAt?: number;
            autoReply?: boolean;
            bridgeEnabled?: boolean;
            lastUpdateAt?: number | null;
            totalReceived?: number;
            totalReplied?: number;
            totalRawMessages?: number;
            lastError?: string | null;
            botUsername?: string;
          }>('/api/otto/messenger/discord/listener/start', {
            token: conn.botToken,
            guildId: conn.discordGuildId,
            defaultChannelId: conn.defaultChannelId,
            defaultUserId: conn.defaultUserId,
            // Default OFF — we'd rather show every message the gateway
            // delivers than silently drop messages from a different guild
            // because the saved Server ID is wrong by one digit.
            scopeToGuild: Boolean(conn.discordListenerScopeToGuild),
            autoReply: conn.discordListenerAutoReply !== false,
            bridgeEnabled: conn.bridgeEnabled !== false,
            projectBindings,
          });
          if (!data.ok) return false;
          get().updateConnection('discord', {
            discordListenerRunning: data.running ?? true,
            discordListenerConnected: data.connected ?? false,
            discordListenerStartedAt: data.startedAt ?? Date.now(),
            discordListenerLastUpdateAt: data.lastUpdateAt ?? null,
            discordListenerTotalReceived: data.totalReceived ?? 0,
            discordListenerTotalReplied: data.totalReplied ?? 0,
            discordListenerTotalRawMessages: data.totalRawMessages ?? 0,
            discordListenerError: data.lastError ?? null,
            discordListenerAutoReply: data.autoReply ?? true,
          });
          // Gateway IDENTIFY is async — poll until connected or timeout.
          for (let attempt = 0; attempt < 24; attempt++) {
            const latest = get().connections.find((c) => c.type === 'discord');
            if (latest?.discordListenerConnected) break;
            if (
              latest?.discordListenerError &&
              (latest.discordListenerError.includes('4014') ||
                latest.discordListenerError.includes('Invalid'))
            ) {
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 500));
            await get().refreshDiscordListenerStatus();
          }
          // Persist config server-side so it auto-starts on server restart
          get().saveDiscordConfig();
          const finalConn = get().connections.find((c) => c.type === 'discord');
          return Boolean(finalConn?.discordListenerRunning);
        } catch (e) {
          get().updateConnection('discord', {
            discordListenerError: e instanceof Error ? e.message : 'start failed',
            discordListenerRunning: false,
          });
          return false;
        }
      },

      stopDiscordListener: async () => {
        const conn = get().connections.find((c) => c.type === 'discord');
        if (!conn?.botToken) return false;
        try {
          await postJson('/api/otto/messenger/discord/listener/stop', {
            token: conn.botToken,
          });
          get().updateConnection('discord', {
            discordListenerRunning: false,
            discordListenerConnected: false,
          });
          return true;
        } catch (e) {
          get().updateConnection('discord', {
            discordListenerError: e instanceof Error ? e.message : 'stop failed',
          });
          return false;
        }
      },

      refreshDiscordListenerStatus: async () => {
        const conn = get().connections.find((c) => c.type === 'discord');
        if (!conn?.botToken) return;
        try {
          const data = await postJson<{
            ok: boolean;
            running?: boolean;
            connected?: boolean;
            autoReply?: boolean;
            scopeToGuild?: boolean;
            guildId?: string | null;
            startedAt?: number;
            lastUpdateAt?: number | null;
            totalReceived?: number;
            totalReplied?: number;
            totalRawMessages?: number;
            lastRawMessageAt?: number | null;
            lastRawMessageGuildId?: string | null;
            filteredOutCount?: number;
            lastFilteredGuildId?: string | null;
            lastError?: string | null;
          }>('/api/otto/messenger/discord/listener/status', { token: conn.botToken });
          if (!data.ok) return;
          get().updateConnection('discord', {
            discordListenerRunning: data.running ?? false,
            discordListenerConnected: data.connected ?? false,
            discordListenerStartedAt: data.startedAt ?? null,
            discordListenerLastUpdateAt: data.lastUpdateAt ?? null,
            discordListenerTotalReceived: data.totalReceived ?? 0,
            discordListenerTotalReplied: data.totalReplied ?? 0,
            discordListenerTotalRawMessages: data.totalRawMessages ?? 0,
            discordListenerLastRawMessageAt: data.lastRawMessageAt ?? null,
            discordListenerLastRawMessageGuildId: data.lastRawMessageGuildId ?? null,
            discordListenerFilteredOutCount: data.filteredOutCount ?? 0,
            discordListenerLastFilteredGuildId: data.lastFilteredGuildId ?? null,
            discordListenerError: data.lastError ?? null,
            discordListenerAutoReply: data.autoReply ?? true,
            discordListenerScopeToGuild: data.scopeToGuild ?? false,
          });
        } catch {
          // ignore
        }
      },

      loadRecentDiscordMessages: async () => {
        const conn = get().connections.find((c) => c.type === 'discord');
        if (!conn?.botToken) return;
        try {
          const data = await postJson<{
            ok: boolean;
            messages?: MessengerInboundMessage[];
          }>('/api/otto/messenger/discord/listener/recent', {
            token: conn.botToken,
            limit: 25,
          });
          if (data.ok && Array.isArray(data.messages)) {
            set({ discordInbound: data.messages });
          }
        } catch {
          // ignore
        }
      },

      ingestDiscordInbound: (msg) => {
        const cur = get().discordInbound;
        const next = [msg, ...cur.filter((m) => m.updateId !== msg.updateId)].slice(0, 50);
        set({ discordInbound: next });
      },

      loadDiscordHistory: async (channelId, limit = 50) => {
        const conn = get().connections.find((c) => c.type === 'discord');
        if (!conn?.botToken) return false;
        try {
          const data = await postJson<{
            ok: boolean;
            error?: string;
            messages?: DiscordHistoryMessage[];
          }>('/api/otto/messenger/discord/history', {
            token: conn.botToken,
            channelId,
            limit,
          });
          if (!data.ok) {
            get().updateConnection('discord', { error: data.error ?? 'history fetch failed' });
            return false;
          }
          set({ discordHistory: data.messages ?? [] });
          return true;
        } catch (e) {
          get().updateConnection('discord', {
            error: e instanceof Error ? e.message : 'history fetch failed',
          });
          return false;
        }
      },

      sendApprovalRequest: async (type, prompt, opts) => {
        const conn = get().connections.find((c) => c.type === type);
        if (!conn) return null;

        // Resolve a target channel. Fall back to the first text channel of
        // the resolved server when defaultChannelId is unset.
        let target = opts?.target ?? conn.defaultChannelId;
        if (!target && conn.discordGuildChannels && conn.discordGuildChannels.length > 0) {
          target = conn.discordGuildChannels[0].id;
        }
        const token = conn.botToken;
        if (!token || !target) {
          const failed: MessengerApproval = {
            id: `failed_${Date.now()}`,
            type,
            prompt,
            target: String(target ?? ''),
            messageId: null,
            sentAt: Date.now(),
            decision: null,
            decidedAt: null,
            decidedBy: null,
            error: !token
              ? 'Bot token is missing'
              : 'No Discord channel configured — save a Channel ID or Server ID first',
          };
          set({ approvals: [failed, ...get().approvals].slice(0, 50) });
          return null;
        }

        try {
          const url = '/api/otto/messenger/discord/send-approval';
          const perm = opts?.permission;
          // Build the request body — include structured permission data when available
          const body: Record<string, unknown> = {
            token,
            prompt,
            ...(perm
              ? {
                  permission: {
                    id: perm.id,
                    sessionID: perm.sessionID,
                    permission: perm.permission,
                    patterns: perm.patterns ?? [],
                    metadata: perm.metadata ?? {},
                    always: perm.always ?? [],
                  },
                }
              : {}),
          };
          body.channelId = target;
          const data = await postJson<{
            ok: boolean;
            error?: string;
            approvalId?: string;
            messageId?: string | number;
          }>(url, body);
          if (!data.ok || !data.approvalId) {
            // Record the failure so the UI can show it instead of swallowing
            // the click silently.
            const failed: MessengerApproval = {
              id: `failed_${Date.now()}`,
              type,
              prompt,
              target: String(target),
              messageId: null,
              sentAt: Date.now(),
              decision: null,
              decidedAt: null,
              decidedBy: null,
              error: data.error ?? 'send-approval failed',
              sessionID: perm?.sessionID,
              requestID: perm?.id,
              permissionTool: perm?.permission,
            };
            set({ approvals: [failed, ...get().approvals].slice(0, 50) });
            return null;
          }
          const approval: MessengerApproval = {
            id: data.approvalId,
            type,
            prompt,
            target: String(target),
            messageId: data.messageId ?? null,
            sentAt: Date.now(),
            decision: null,
            decidedAt: null,
            decidedBy: null,
            error: null,
            sessionID: perm?.sessionID,
            requestID: perm?.id,
            permissionTool: perm?.permission,
          };
          set({ approvals: [approval, ...get().approvals].slice(0, 50) });
          return approval;
        } catch (e) {
          // Record a failed approval so the UI can show what went wrong.
          const approval: MessengerApproval = {
            id: `failed_${Date.now()}`,
            type,
            prompt,
            target: String(target),
            messageId: null,
            sentAt: Date.now(),
            decision: null,
            decidedAt: null,
            decidedBy: null,
            error: e instanceof Error ? e.message : 'send-approval failed',
          };
          set({ approvals: [approval, ...get().approvals].slice(0, 50) });
          return null;
        }
      },

      ingestApprovalDecision: (approvalId, decision, by) => {
        const list = get().approvals;
        const idx = list.findIndex((a) => a.id === approvalId);
        if (idx === -1) return;
        const next = list.slice();
        next[idx] = {
          ...next[idx],
          decision,
          decidedAt: Date.now(),
          decidedBy: by,
        };
        set({ approvals: next });
      },

      clearApprovals: () => set({ approvals: [] }),

      setProjectMapping: (mapping) => {
        set({
          projectMappings: [
            ...get().projectMappings.filter((m) => m.projectId !== mapping.projectId),
            mapping,
          ],
        });
      },

      removeProjectMapping: (projectId) => {
        set({
          projectMappings: get().projectMappings.filter((m) => m.projectId !== projectId),
        });
      },

      ensureProjectChannel: async (project) => {
        const conn = get().connections.find((c) => c.type === 'discord');
        // Per-project channels require a server (guild). Without one we can only
        // post to a single default channel, so leave the legacy behavior alone.
        if (!conn?.botToken || !conn.discordGuildId || conn.syncProjects === false) return;
        const projectLabel = project.label ?? project.path;
        try {
          const data = await postJson<{
            ok: boolean;
            results?: { ok: boolean; channelId?: string; channelName?: string }[];
          }>('/api/otto/messenger/bridge/project-added', {
            project: { id: project.id, path: project.path, label: projectLabel },
            discord: {
              token: conn.botToken,
              guildId: conn.discordGuildId,
              parentCategoryId: conn.discordParentCategoryId,
            },
          });
          const created = data.results?.find((r) => r.ok && r.channelId);
          if (created?.channelId) {
            get().setProjectMapping({
              projectId: project.id,
              projectLabel,
              discord: { channelId: created.channelId, channelName: created.channelName ?? '' },
            });
            get().saveDiscordConfig();
          }
        } catch {
          // best-effort — channel sync must never break project creation
        }
      },

      renameProjectChannel: async (project) => {
        const conn = get().connections.find((c) => c.type === 'discord');
        if (!conn?.botToken || !conn.discordGuildId || conn.syncProjects === false) return;
        const projectLabel = project.label ?? project.path;
        try {
          const data = await postJson<{
            ok: boolean;
            channelId?: string | null;
            channelName?: string | null;
          }>('/api/otto/messenger/bridge/project-renamed', {
            project: { id: project.id, path: project.path, label: projectLabel },
            discord: {
              token: conn.botToken,
              guildId: conn.discordGuildId,
              parentCategoryId: conn.discordParentCategoryId,
            },
          });
          if (data.channelId) {
            get().setProjectMapping({
              projectId: project.id,
              projectLabel,
              discord: { channelId: data.channelId, channelName: data.channelName ?? '' },
            });
            get().saveDiscordConfig();
          }
        } catch {
          // best-effort
        }
      },

      removeProjectChannel: async (projectId, projectPath) => {
        const conn = get().connections.find((c) => c.type === 'discord');
        if (!conn?.botToken) {
          get().removeProjectMapping(projectId);
          return;
        }
        const channelId = get().projectMappings.find((m) => m.projectId === projectId)?.discord
          ?.channelId;
        try {
          await postJson('/api/otto/messenger/bridge/project-removed', {
            project: { id: projectId, path: projectPath, channelId },
            discord: { token: conn.botToken },
          });
        } catch {
          // best-effort — still drop the local mapping below
        }
        get().removeProjectMapping(projectId);
        get().saveDiscordConfig();
      },

      startOnboarding: (type) => {
        get().addConnection(type);
        set({ onboardingStep: 0, onboardingType: type });
      },

      nextOnboardingStep: () => {
        const step = get().onboardingStep;
        if (step !== null) set({ onboardingStep: step + 1 });
      },

      prevOnboardingStep: () => {
        const step = get().onboardingStep;
        if (step !== null && step > 0) set({ onboardingStep: step - 1 });
      },

      finishOnboarding: () => {
        set({ onboardingStep: null, onboardingType: null });
      },
    }),
    {
      name: 'otto-messenger-config',
      storage: createJSONStorage(() => getSafeStorage()),
      partialize: (state) => ({
        connections: state.connections.map((c) => ({
          ...c,
          status: 'disconnected' as const,
          error: null,
          lastSyncStatus: 'idle' as const,
          lastSyncMessage: null,
          // Listener state lives on the server — clear it on persist so the
          // UI always re-syncs from the server after reload (via auto-start).
          discordListenerRunning: false,
          discordListenerConnected: false,
          discordListenerStartedAt: null,
          discordListenerLastUpdateAt: null,
          discordListenerError: null,
        })),
        projectMappings: state.projectMappings,
      }),
    },
  ),
);
