import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { getSafeStorage } from './utils/safeStorage';
import { useProjectsStore } from './useProjectsStore';
import { runtimeFetch } from '@/lib/runtime-fetch';
import type { ProjectEntry } from '@/lib/api/types';

export type MessengerType = 'discord';
export type SyncMode = 'full' | 'notifications' | 'off';
export type MessengerVerbosity = 'quiet' | 'normal' | 'verbose';

/** Tool permission mode for the OpenCode bridge (`/yolo` / `/permissions`). */
export type MessengerPermissionMode = 'ask' | 'yolo' | 'agent';

export type DiscordReplyMode = 'always' | 'mention' | 'inherit';

/**
 * Per-server (guild) configuration. A single object holds both how the bot
 * *responds* in a server and whether that server *mirrors projects*, so every
 * server the bot is in is configured independently in one place.
 */
export interface DiscordGuildPolicy {
  /**
   * Respond in this server — the master per-server switch. When false the
   * server is filtered out of the entire gateway pipeline (no listening, no
   * OpenCode bridging, no replies). Absent/true = respond.
   */
  enabled?: boolean;
  /** How the bot decides to reply in this server. `inherit` uses the default. */
  replyMode?: DiscordReplyMode;
  /** Mirror per-project channels into this server when syncing projects. */
  syncProjects?: boolean;
  /** Category to nest new project channels under, for this server. */
  parentCategoryId?: string;
  /** Start a thread from each project status message, in this server. */
  createThreads?: boolean;
}

/** Cached channel/category topology for one guild, from `resolve-guild`. */
export interface DiscordGuildResolved {
  name?: string;
  channels: { id: string; name: string; type: number; parentId: string | null }[];
  categories: { id: string; name: string }[];
  activeThreadCount: number;
}

export const MESSENGER_INTERRUPT_TIMEOUT_DEFAULT_MS = 8000;
export const MESSENGER_INTERRUPT_TIMEOUT_MIN_MS = 1000;
export const MESSENGER_INTERRUPT_TIMEOUT_MAX_MS = 60000;

export interface MessengerConnection {
  type: MessengerType;
  enabled: boolean;
  status: 'disconnected' | 'connecting' | 'connected' | 'error';
  error: string | null;
  lastConnectedAt: number | null;

  // Discord-specific
  botToken?: string;
  /**
   * True when the server-side settings.json has a Discord bot token
   * configured, regardless of whether the local store has the token.
   * Set by `refreshDiscordListenerStatus` after probing the runtime.
   * Lets the settings view show "configured" (server settings) instead
   * of the "Connect Discord" tile when the server already has a working
   * bot but the local state was lost (e.g. localStorage cleared).
   */
  discordServerConfigured?: boolean;
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
  /** Bot user IDs allowed to talk to OpenChamber agent without the OpenChamber role. */
  trustedBotIds?: string[];
  /**
   * When true, register OpenCode commands/skills as Discord `-cmd`/`-skill`
   * slash commands (opt-in; default false). Requires listener restart.
   */
  registerDynamicSlashCommands?: boolean;
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
    /** Which server this row was synced to (multi-server sync). */
    guildId?: string;
    guildName?: string | null;
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
  /**
   * Whether the server should keep the gateway listening.
   * Default/absent = true (start on boot). Explicit false is sticky until
   * the user starts listening again — health checks must not auto-restart.
   */
  discordListenerEnabled?: boolean;
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
  discordDefaultReplyMode?: 'always' | 'mention';
  discordGuildPolicies?: Record<string, DiscordGuildPolicy>;
  /**
   * Per-guild resolved channel/category topology, cached from `resolve-guild`
   * so each server's "sync projects here" options (category picker, thread
   * toggle) render without re-fetching. Keyed by guild id.
   */
  discordGuildResolved?: Record<string, DiscordGuildResolved>;
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
  /** True after Zustand persist rehydration completes.  Used to prevent the
   *  "Connect Discord" card from flashing before the persisted token loads. */
  hasHydrated: boolean;

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

  /**
   * True while a Discord guild-list refresh (/api/messenger/test) is in flight.
   * Store-root transient — not persisted.
   */
  discordGuildsRefreshing: boolean;
  /** Soft error from a quiet guild refresh; does not flip connection.status. */
  discordGuildsError: string | null;

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
   * (`ask` | `yolo` | `agent`). `null` means "never configured — the
   * bridge uses its built-in `agent` (follow agent settings) default".
   * Mirrors `/yolo default <mode>` / `/permissions default <mode>`;
   * refreshed from /bridge/status.
   */
  bridgePermissionMode: Partial<Record<MessengerType, MessengerPermissionMode | null>>;

  bridgeNotifyOnComplete: Partial<Record<MessengerType, boolean>>;
  bridgeInterruptTimeoutMs: Partial<Record<MessengerType, number>>;

  addConnection: (type: MessengerType) => void;
  updateConnection: (type: MessengerType, updates: Partial<MessengerConnection>) => void;
  removeConnection: (type: MessengerType) => void;
  /** Stop the live gateway, clear server Discord config, and drop local connection. */
  disconnectDiscord: () => Promise<void>;
  testConnection: (type: MessengerType) => Promise<boolean>;
  /**
   * Quiet re-fetch of Discord bot identity + guild membership via
   * `/api/messenger/test`. Does not flash `status: 'connecting'` when already
   * live; failures preserve existing `discordGuilds`.
   */
  refreshDiscordGuilds: () => Promise<boolean>;
  resolveDiscordChannel: () => Promise<boolean>;
  resolveDiscordGuild: (guildId?: string) => Promise<boolean>;
  fetchDiscordInviteUrl: () => Promise<string | null>;
  syncDiscordGuildProjects: (
    projects: { id: string; label: string; body: string }[],
    summary: string,
    opts?: { guildIds?: string[] },
  ) => Promise<boolean>;
  sendTestMessage: (type: MessengerType, opts?: { guildId?: string }) => Promise<boolean>;
  diagnoseDiscord: () => Promise<boolean>;
  refreshBridgeStatus: (type?: MessengerType) => Promise<void>;
  setBridgeVerbosity: (type: MessengerType, level: MessengerVerbosity) => Promise<boolean>;
  setBridgePermissionMode: (
    type: MessengerType,
    mode: MessengerPermissionMode,
  ) => Promise<boolean>;
  setBridgeNotifyOnComplete: (
    type: MessengerType,
    enabled: boolean,
  ) => Promise<boolean>;
  setBridgeInterruptTimeoutMs: (
    type: MessengerType,
    timeoutMs: number,
  ) => Promise<boolean>;
  saveDiscordConfig: () => Promise<void>;
  startDiscordListener: () => Promise<boolean>;
  stopDiscordListener: () => Promise<boolean>;
  refreshDiscordListenerStatus: () => Promise<void>;
  setDiscordGuildPolicy: (
    guildId: string,
    patch: Partial<DiscordGuildPolicy>,
  ) => void;
  setDiscordDefaultReplyMode: (mode: 'always' | 'mention') => void;
  /**
   * Reconcile UI Discord status with the live server after reload / server
   * rebuild. Persisted store fields intentionally reset listener + verify
   * status to "disconnected"; this pulls authoritative state back.
   */
  resyncDiscordStatus: () => Promise<void>;
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

async function parseRuntimeJson<T>(res: Response, url: string): Promise<T> {
  let data: T;
  try {
    data = (await res.json()) as T;
  } catch {
    throw new Error(`Invalid JSON from ${url} (HTTP ${res.status})`);
  }
  if (!res.ok) {
    const error =
      data &&
      typeof data === 'object' &&
      'error' in data &&
      typeof (data as { error: unknown }).error === 'string'
        ? (data as { error: string }).error
        : `HTTP ${res.status}`;
    throw new Error(error);
  }
  return data;
}

/** Messenger routes must use runtimeFetch so desktop/auth base URL + bearer apply. */
async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await runtimeFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return parseRuntimeJson<T>(res, url);
}

async function getJson<T>(url: string): Promise<T> {
  const res = await runtimeFetch(url);
  return parseRuntimeJson<T>(res, url);
}

/** Dedupes concurrent resync calls from hydration + reconnect + settings mount. */
let discordStatusResyncInFlight: Promise<void> | null = null;

type DiscordTestPayload = {
  ok: boolean;
  error?: string;
  id?: string;
  username?: string;
  discriminator?: string;
  guilds?: { id: string; name: string }[];
};

type MessengerStoreGet = () => MessengerState;
type MessengerStoreSet = (
  partial:
    | Partial<MessengerState>
    | ((state: MessengerState) => Partial<MessengerState>),
) => void;

/**
 * Shared Discord token verify + guild membership fetch for `testConnection`
 * and `refreshDiscordGuilds`. Quiet mode skips the connecting spinner and
 * avoids flipping an already-connected status to error on soft failures.
 */
async function verifyDiscordBotAndGuilds(
  get: MessengerStoreGet,
  set: MessengerStoreSet,
  opts: { quiet?: boolean } = {},
): Promise<boolean> {
  const quiet = Boolean(opts.quiet);
  const conn = get().connections.find((c) => c.type === 'discord');
  // Allow refresh when the server still has the token even if the local
  // store lost it (localStorage cleared / rehydrate race). The /test
  // endpoint falls back to settings.json when no token is sent.
  if (!conn) return false;
  if (!conn.botToken && !conn.discordServerConfigured) return false;

  const alreadyLive =
    conn.status === 'connected' ||
    conn.status === 'connecting' ||
    Boolean(conn.discordListenerConnected);

  if (!quiet) {
    get().updateConnection('discord', { status: 'connecting', error: null });
  }

  set({ discordGuildsRefreshing: true, discordGuildsError: null });
  try {
    const data = await postJson<DiscordTestPayload>('/api/messenger/test', {
      type: 'discord',
      ...(conn.botToken ? { token: conn.botToken } : {}),
    });
    if (!data.ok) throw new Error(data.error ?? 'Discord API failed');

    const updates: Partial<MessengerConnection> = {
      discordBotId: data.id,
      discordBotUsername: data.username,
      discordBotDiscriminator: data.discriminator,
      // Successful verify (local or server-token fallback) means the bot is
      // configured — keep the configured view even if localStorage lost the token.
      discordServerConfigured: true,
    };

    // Only replace guilds when the server included an authoritative list.
    // Omitting `guilds` means the guilds fetch failed — preserve prior state.
    if (Array.isArray(data.guilds)) {
      updates.discordGuilds = data.guilds;
      // Keep the primary-sync guild's display name in sync when we know that id.
      // Never blindly overwrite with guilds[0] — Discord's order is not the
      // user's selected project-sync server.
      if (conn.discordGuildId) {
        const matched = data.guilds.find((g) => g.id === conn.discordGuildId);
        if (matched) updates.guildName = matched.name;
      } else if (!conn.guildName && data.guilds.length > 0) {
        updates.guildName = data.guilds[0].name;
      }
    }

    if (!quiet || conn.status === 'disconnected' || conn.status === 'error') {
      updates.status = 'connected';
      updates.lastConnectedAt = Date.now();
      updates.error = null;
    } else if (alreadyLive) {
      // Stay quiet — keep status/error as-is while refreshing membership.
      updates.lastConnectedAt = Date.now();
    }

    get().updateConnection('discord', updates);
    if (data.id) {
      void get().fetchDiscordInviteUrl();
    }
    return true;
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Connection failed';
    if (quiet && alreadyLive) {
      // Soft failure: keep connected badge + prior guilds.
      set({ discordGuildsError: message });
      return false;
    }
    get().updateConnection('discord', {
      status: 'error',
      error: message,
    });
    return false;
  } finally {
    set({ discordGuildsRefreshing: false });
  }
}

type DiscordListenerStatusPayload = {
  ok: boolean;
  configured?: boolean;
  listenerEnabled?: boolean;
  running?: boolean;
  connected?: boolean;
  autoReply?: boolean;
  scopeToGuild?: boolean;
  guildId?: string | null;
  botId?: string | null;
  botUsername?: string | null;
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
  defaultReplyMode?: 'always' | 'mention';
  guildPolicies?: Record<string, DiscordGuildPolicy>;
};

/**
 * Derive the Discord settings badge from live listener state first, then the
 * last token-verify result. Persisted verify status is forced to
 * `disconnected` on every reload, while the server-side gateway may already be
 * live after auto-start — prefer that stronger signal.
 */
export function deriveDiscordDisplayStatus(
  conn: Pick<
    MessengerConnection,
    'status' | 'botToken' | 'discordServerConfigured' | 'discordListenerRunning' | 'discordListenerConnected'
  >,
): MessengerConnection['status'] {
  if (conn.discordListenerConnected) return 'connected';
  if (conn.status === 'connecting') return 'connecting';
  if (conn.discordListenerRunning) return 'connecting';
  if (conn.status === 'connected') return 'connected';
  if (conn.status === 'error') return 'error';
  // Token is configured but live state has not reconciled yet (reload /
  // rebuild). Never flash "disconnected" for a bot that is still working.
  if (conn.botToken || conn.discordServerConfigured) return 'connecting';
  return 'disconnected';
}

/**
 * Which Discord surface the settings section shows. Keyed on *persistent*
 * intent (a saved bot token) plus the explicit onboarding flag — never on the
 * transient verify/listener status, so the view is stable across reloads:
 *
 * - `connect-card`: nothing connected → the square "Connect Discord" tile.
 *   Also the correct state for a stale persisted connection that never got a
 *   token (unfinished onboarding survives in localStorage; onboardingStep
 *   does not).
 * - `wizard`: explicit onboarding in progress. The wizard is the ONLY token
 *   entry UI — there is no non-wizard token form.
 * - `configured`: a token exists and onboarding is over. The configured view
 *   renders the same regardless of whether the live status currently reads
 *   connecting/connected/error — the badge carries the transient state.
 */
export type DiscordViewState = 'connect-card' | 'wizard' | 'configured';

export function deriveDiscordViewState(input: {
  hasToken: boolean;
  /** True when the server-side runtime reports a configured bot even if the
   *  local store doesn't have the token.  Prevents the connect-card from
   *  appearing after a localStorage loss while the server is live. */
  serverConfigured: boolean;
  wizardActive: boolean;
}): DiscordViewState {
  if (input.wizardActive) return 'wizard';
  if (!input.hasToken && !input.serverConfigured) return 'connect-card';
  return 'configured';
}

/**
 * Whether a given server mirrors projects. Once any server has an explicit
 * `syncProjects` flag we honor those exactly; otherwise we fall back to the
 * legacy single "primary sync server" (`discordGuildId`) so existing setups
 * keep working before the user touches the new per-server toggles.
 */
export function isDiscordGuildSyncing(
  conn: Pick<MessengerConnection, 'discordGuildPolicies' | 'discordGuildId'>,
  guildId: string,
): boolean {
  const policies = conn.discordGuildPolicies ?? {};
  const anyExplicit = Object.values(policies).some((p) => p?.syncProjects);
  if (anyExplicit) return Boolean(policies[guildId]?.syncProjects);
  return guildId === conn.discordGuildId;
}

/** The set of server ids that should receive per-project channel mirroring. */
function getDiscordSyncGuildIds(
  conn: Pick<MessengerConnection, 'discordGuildPolicies' | 'discordGuildId' | 'discordGuilds'>,
): string[] {
  const policies = conn.discordGuildPolicies ?? {};
  const explicit = Object.entries(policies)
    .filter(([, p]) => p?.syncProjects)
    .map(([gid]) => gid);
  if (explicit.length > 0) return explicit;
  return conn.discordGuildId ? [conn.discordGuildId] : [];
}

/**
 * Whether the bot should keep a live gateway connection: any joined server is
 * set to respond (absent/true = respond). When membership is not loaded yet we
 * fall back to "has a target" so the listener isn't stopped prematurely.
 */
function anyDiscordGuildResponds(
  conn: Pick<
    MessengerConnection,
    'discordGuilds' | 'discordGuildPolicies' | 'discordGuildId' | 'defaultChannelId'
  >,
): boolean {
  const guilds = conn.discordGuilds ?? [];
  if (guilds.length === 0) {
    return Boolean(conn.discordGuildId || conn.defaultChannelId);
  }
  return guilds.some((g) => conn.discordGuildPolicies?.[g.id]?.enabled !== false);
}

export const useMessengerStore = create<MessengerState>()(
  persist(
    (set, get) => ({
      connections: [],
      projectMappings: [],
      onboardingStep: null,
      onboardingType: null,
      hasHydrated: typeof window === 'undefined',
      discordInbound: [],
      discordHistory: [],
      discordDiagnosis: null,
      discordDiagnosisRunning: false,
      discordGuildsRefreshing: false,
      discordGuildsError: null,
      approvals: [],
      bridgeStatus: { enabled: false, bindings: [], active: [] },
      bridgeVerbosity: {},
      bridgePermissionMode: {},
      bridgeNotifyOnComplete: {},
      bridgeInterruptTimeoutMs: {},

      addConnection: (type) => {
        const existing = get().connections.find((c) => c.type === type);
        if (existing) return;
        set({ connections: [...get().connections, { ...DEFAULT_CONNECTION, type }] });
      },

  updateConnection: (type, updates) => {
    const existing = get().connections.find((c) => c.type === type);
    if (!existing) {
      // Recover a connection from server-side config (e.g. after
      // localStorage was cleared).  The caller may not know a
      // connection exists yet, but the server is configured and
      // returning live data — materialise the entry so the view
      // can transition to "configured" instead of staying on the
      // connect-card.
      set({
        connections: [
          ...get().connections,
          { ...DEFAULT_CONNECTION, type, ...updates },
        ],
      });
      return;
    }
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

      disconnectDiscord: async () => {
        const conn = get().connections.find((c) => c.type === 'discord');
        try {
          await postJson<{ ok: boolean }>('/api/messenger/discord/disconnect', {
            token: conn?.botToken,
          });
        } catch {
          // Fallback: at least stop the in-process gateway before clearing UI.
          if (conn?.botToken) {
            try {
              await postJson('/api/messenger/discord/listener/stop', {
                token: conn.botToken,
              });
            } catch {
              // ignore — local clear still proceeds
            }
          }
        }
        get().removeConnection('discord');
      },

      testConnection: async (type) => {
        const conn = get().connections.find((c) => c.type === type);
        if (!conn) return false;

        if (type === 'discord') {
          if (!conn.botToken) {
            get().updateConnection(type, {
              status: 'error',
              error: 'No token configured',
            });
            return false;
          }
          return verifyDiscordBotAndGuilds(get, set, { quiet: false });
        }

        get().updateConnection(type, {
          status: 'error',
          error: 'No token configured',
        });
        return false;
      },

      refreshDiscordGuilds: async () => {
        return verifyDiscordBotAndGuilds(get, set, { quiet: true });
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
          }>('/api/messenger/discord/resolve-channel', {
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

      resolveDiscordGuild: async (guildIdArg) => {
        const conn = get().connections.find((c) => c.type === 'discord');
        const guildId = guildIdArg ?? conn?.discordGuildId;
        // Server falls back to the saved token, so a tokenless-but-configured
        // client can still resolve a server's channels/categories.
        if (!conn || (!conn.botToken && !conn.discordServerConfigured) || !guildId) return false;
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
          }>('/api/messenger/discord/resolve-guild', {
            ...(conn.botToken ? { token: conn.botToken } : {}),
            guildId,
          });
          if (!data.ok) {
            get().updateConnection('discord', { error: data.error ?? 'resolve-guild failed' });
            return false;
          }
          const cur = get().connections.find((c) => c.type === 'discord');
          const resolvedEntry: DiscordGuildResolved = {
            name: data.name ?? undefined,
            channels: data.channels ?? [],
            categories: data.categories ?? [],
            activeThreadCount: data.activeThreads?.length ?? 0,
          };
          const updates: Partial<MessengerConnection> = {
            discordGuildResolved: {
              ...(cur?.discordGuildResolved ?? {}),
              [guildId]: resolvedEntry,
            },
            error: null,
          };
          // Keep the legacy single-guild fields in sync when we resolved the
          // primary server, so diagnose / the single Channel ID fallback stay
          // populated for existing flows.
          if (guildId === cur?.discordGuildId) {
            updates.guildName = data.name ?? undefined;
            updates.discordGuildIconHash = data.iconHash ?? null;
            updates.discordGuildChannels = data.channels ?? [];
            updates.discordGuildCategories = data.categories ?? [];
            updates.discordGuildActiveThreadCount = data.activeThreads?.length ?? 0;
            updates.defaultChannelId =
              cur?.defaultChannelId ?? data.defaultChannelId ?? undefined;
          }
          get().updateConnection('discord', updates);
          return true;
        } catch (e) {
          get().updateConnection('discord', {
            error: e instanceof Error ? e.message : 'resolve-guild failed',
          });
          return false;
        }
      },

      syncDiscordGuildProjects: async (projects, summary, opts) => {
        const conn = get().connections.find((c) => c.type === 'discord');
        // The badge reads "connected" from the live server gateway even when
        // this browser never stored the token (second device / cleared
        // storage). The server falls back to the saved settings.json token, so
        // gate on "configured" (local token OR server-side config) rather than
        // the local token alone — otherwise a connected bot can't sync.
        if (!conn || (!conn.botToken && !conn.discordServerConfigured)) {
          get().updateConnection('discord', {
            lastSyncStatus: 'error',
            lastSyncMessage: 'Connect Discord before syncing projects',
          });
          return false;
        }
        // An explicit guild list (per-server "Sync now") wins; otherwise sync
        // every server that has "Sync projects here" enabled.
        const syncGuildIds =
          opts?.guildIds && opts.guildIds.length > 0
            ? opts.guildIds
            : getDiscordSyncGuildIds(conn);
        if (syncGuildIds.length === 0) {
          get().updateConnection('discord', {
            lastSyncStatus: 'error',
            lastSyncMessage: 'Turn on "Sync projects here" for at least one server first',
          });
          return false;
        }

        const guildNameOf = (gid: string): string | null =>
          conn.discordGuilds?.find((g) => g.id === gid)?.name ??
          conn.discordGuildResolved?.[gid]?.name ??
          (gid === conn.discordGuildId ? conn.guildName ?? null : null);

        const runSyncForGuild = (gid: string) => {
          const policy = conn.discordGuildPolicies?.[gid] ?? {};
          // Legacy primary keeps using the old top-level category/threads until
          // the user sets per-server values.
          const isLegacyPrimary = gid === conn.discordGuildId;
          return postJson<{
            ok: boolean;
            error?: string;
            channels?: NonNullable<MessengerConnection['lastSyncChannels']>;
          }>('/api/messenger/discord/sync-projects', {
            ...(conn.botToken ? { token: conn.botToken } : {}),
            guildId: gid,
            parentCategoryId:
              policy.parentCategoryId ?? (isLegacyPrimary ? conn.discordParentCategoryId : undefined),
            createThreads:
              policy.createThreads ??
              (isLegacyPrimary ? conn.discordCreateThreads !== false : true),
            summary,
            projects,
            mappings: get().projectMappings,
          });
        };

        get().updateConnection('discord', {
          lastSyncStatus: 'sending',
          lastSyncMessage:
            projects.length > 0
              ? `Syncing ${projects.length} project${projects.length === 1 ? '' : 's'} to ${syncGuildIds.length} server${syncGuildIds.length === 1 ? '' : 's'}…`
              : 'Sending sync summary…',
        });

        const allRows: NonNullable<MessengerConnection['lastSyncChannels']> = [];
        let hadError = false;

        for (const gid of syncGuildIds) {
          const guildName = guildNameOf(gid);
          try {
            const data = await runSyncForGuild(gid);
            const rows = (data.channels ?? []).map((r) => ({ ...r, guildId: gid, guildName }));
            allRows.push(...rows);

            // Store the primary (first) server's channels as the project mapping
            // so the bridge keeps a stable per-project channel to route into.
            if (gid === syncGuildIds[0]) {
              for (const r of data.channels ?? []) {
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
            }

            if (data.error && (data.channels?.length ?? 0) === 0) {
              hadError = true;
              allRows.push({
                projectId: `__guild_${gid}`,
                projectLabel: guildName ?? gid,
                guildId: gid,
                guildName,
                channelId: null,
                channelName: null,
                messageId: null,
                threadId: null,
                threadName: null,
                created: false,
                threadCreated: false,
                error: data.error,
              });
            } else if ((data.channels ?? []).some((r) => r.error || r.threadError)) {
              hadError = true;
            }
          } catch (e) {
            hadError = true;
            allRows.push({
              projectId: `__guild_${gid}`,
              projectLabel: guildName ?? gid,
              guildId: gid,
              guildName,
              channelId: null,
              channelName: null,
              messageId: null,
              threadId: null,
              threadName: null,
              created: false,
              threadCreated: false,
              error: e instanceof Error ? e.message : 'Sync failed',
            });
          }
        }

        const createdCh = allRows.filter((r) => r.created).length;
        const postedMsgs = allRows.filter((r) => r.messageId).length;
        const createdTh = allRows.filter((r) => r.threadCreated).length;
        const errored = allRows.filter((r) => r.error);
        const parts: string[] = [];
        if (createdCh > 0) parts.push(`${createdCh} channel${createdCh === 1 ? '' : 's'} created`);
        if (postedMsgs > 0) parts.push(`${postedMsgs} message${postedMsgs === 1 ? '' : 's'} posted`);
        if (createdTh > 0) parts.push(`${createdTh} thread${createdTh === 1 ? '' : 's'} opened`);
        if (errored.length > 0) parts.push(`${errored.length} error${errored.length === 1 ? '' : 's'}`);
        const summaryMsg = parts.length > 0 ? `${parts.join(', ')} ✓` : 'Sync sent ✓';

        get().updateConnection('discord', {
          lastSyncAt: Date.now(),
          lastSyncStatus: hadError ? 'error' : 'ok',
          lastSyncMessage: hadError
            ? `${summaryMsg} — first error: ${errored[0]?.error ?? 'sync failed'}`
            : summaryMsg,
          lastSyncChannels: allRows,
        });

        return !hadError;
      },

      fetchDiscordInviteUrl: async () => {
        const conn = get().connections.find((c) => c.type === 'discord');
        if (!conn?.discordBotId) return null;
        try {
          const data = await postJson<{ ok: boolean; url?: string; error?: string }>(
            '/api/messenger/discord/invite-url',
            { clientId: conn.discordBotId },
          );
          if (!data.ok || !data.url) return null;
          get().updateConnection('discord', { discordInviteUrl: data.url });
          return data.url;
        } catch {
          return null;
        }
      },

      sendTestMessage: async (type, opts) => {
        const conn = get().connections.find((c) => c.type === type);
        if (!conn) return false;

        // "Connected" can be true purely from the live server gateway while
        // this browser holds no token (second device / cleared storage). The
        // server falls back to the saved token, so gate on configured state,
        // not the local token — otherwise a connected bot can't send.
        const configured = Boolean(conn.botToken || conn.discordServerConfigured);
        if (!configured) {
          get().updateConnection(type, {
            lastSyncStatus: 'error',
            lastSyncMessage: 'Connect Discord before sending a test message',
          });
          return false;
        }

        // Per-server "Send test" passes a guildId — the server resolves that
        // server's first text channel. Otherwise target the configured default
        // channel, falling back to the first channel of the resolved server.
        const guildId = opts?.guildId;
        let target = guildId ? undefined : conn.defaultChannelId;
        if (!guildId && !target && conn.discordGuildChannels && conn.discordGuildChannels.length > 0) {
          target = conn.discordGuildChannels[0].id;
        }
        if (!guildId && !target) {
          get().updateConnection(type, {
            lastSyncStatus: 'error',
            lastSyncMessage: 'Pick a server or channel to send the test to',
          });
          return false;
        }

        const guildName = guildId
          ? conn.discordGuilds?.find((g) => g.id === guildId)?.name ?? null
          : null;

        get().updateConnection(type, {
          lastSyncStatus: 'sending',
          lastSyncMessage: guildName
            ? `Sending test message to ${guildName}…`
            : 'Sending test message…',
        });

        const text = `**OpenChamber agent connected ✓**\nThis is a test message from your OpenChamber agent.\nOpenChamber agent can now post project updates to this channel.`;

        try {
          const data = await postJson<{ ok: boolean; error?: string }>('/api/messenger/send', {
            type,
            ...(conn.botToken ? { token: conn.botToken } : {}),
            ...(target ? { target } : {}),
            ...(guildId ? { guildId } : {}),
            text,
          });
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
            lastSyncMessage: guildName
              ? `Test message delivered to ${guildName} ✓`
              : 'Test message delivered ✓',
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
            notifyOnComplete?: Partial<Record<MessengerType, boolean>>;
            interruptTimeoutMs?: Partial<Record<MessengerType, number>>;
          }>('/api/messenger/bridge/status', { type, token });
          set({
            bridgeStatus: {
              enabled: Boolean(data.enabled),
              bindings: data.bindings ?? [],
              active: data.active ?? [],
            },
            bridgeVerbosity: data.verbosity ?? get().bridgeVerbosity,
            bridgePermissionMode: data.permissionMode ?? get().bridgePermissionMode,
            bridgeNotifyOnComplete: data.notifyOnComplete ?? get().bridgeNotifyOnComplete,
            bridgeInterruptTimeoutMs: data.interruptTimeoutMs ?? get().bridgeInterruptTimeoutMs,
          });
        } catch {
          // ignore
        }
      },

      setBridgeVerbosity: async (type, level) => {
        try {
          const data = await postJson<{ ok: boolean; level?: MessengerVerbosity | null }>(
            '/api/messenger/bridge/verbosity',
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
            '/api/messenger/bridge/permission-mode',
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

      setBridgeNotifyOnComplete: async (type, enabled) => {
        try {
          const data = await postJson<{ ok: boolean; enabled?: boolean }>(
            '/api/messenger/bridge/notify-on-complete',
            { type, enabled },
          );
          if (!data.ok) return false;
          set({
            bridgeNotifyOnComplete: {
              ...get().bridgeNotifyOnComplete,
              [type]: data.enabled ?? enabled,
            },
          });
          return true;
        } catch {
          return false;
        }
      },

      setBridgeInterruptTimeoutMs: async (type, timeoutMs) => {
        const clamped = Math.min(
          MESSENGER_INTERRUPT_TIMEOUT_MAX_MS,
          Math.max(MESSENGER_INTERRUPT_TIMEOUT_MIN_MS, Math.round(timeoutMs)),
        );
        try {
          const data = await postJson<{ ok: boolean; timeoutMs?: number }>(
            '/api/messenger/bridge/interrupt-timeout',
            { type, timeoutMs: clamped },
          );
          if (!data.ok) return false;
          set({
            bridgeInterruptTimeoutMs: {
              ...get().bridgeInterruptTimeoutMs,
              [type]: data.timeoutMs ?? clamped,
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
          }>('/api/messenger/discord/diagnose', {
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
        if (!conn) return;
        // Tokenless clients (second device, cleared localStorage) must still
        // save: the server falls back to the settings.json token when the body
        // omits botToken. Without this, every reply-mode/policy toggle in that
        // state silently never reached the server.
        if (!conn.botToken && !conn.discordServerConfigured) return;
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
          await postJson('/api/messenger/discord/save-config', {
            ...(conn.botToken ? { botToken: conn.botToken } : {}),
            guildId: conn.discordGuildId,
            autoReply: conn.discordListenerAutoReply !== false,
            // Listening is governed per-server via guildPolicies[*].enabled now,
            // so the gateway always hears every server and never scopes to one.
            scopeToGuild: false,
            bridgeEnabled: conn.bridgeEnabled !== false,
            defaultChannelId: conn.defaultChannelId,
            defaultUserId: conn.defaultUserId,
            trustedBotIds: conn.trustedBotIds ?? [],
            registerDynamicSlashCommands: Boolean(conn.registerDynamicSlashCommands),
            projectBindings,
            defaultReplyMode: conn.discordDefaultReplyMode ?? 'always',
            guildPolicies: conn.discordGuildPolicies ?? {},
          });
        } catch {
          // silent — config save is best-effort
        }
      },

      startDiscordListener: async () => {
        const conn = get().connections.find((c) => c.type === 'discord');
        // Tokenless start is allowed — the endpoint falls back to the token
        // saved in settings.json (same pattern as /test and /listener/stop).
        if (!conn?.botToken && !conn?.discordServerConfigured) return false;
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
          }>('/api/messenger/discord/listener/start', {
            ...(conn.botToken ? { token: conn.botToken } : {}),
            guildId: conn.discordGuildId,
            defaultChannelId: conn.defaultChannelId,
            defaultUserId: conn.defaultUserId,
            trustedBotIds: conn.trustedBotIds ?? [],
            registerDynamicSlashCommands: Boolean(conn.registerDynamicSlashCommands),
            // Listening is governed per-server (guildPolicies[*].enabled), so
            // the gateway always hears every server; disabled servers are
            // filtered downstream instead of scoping the whole connection.
            scopeToGuild: false,
            autoReply: conn.discordListenerAutoReply !== false,
            bridgeEnabled: conn.bridgeEnabled !== false,
            projectBindings,
            defaultReplyMode: conn.discordDefaultReplyMode ?? 'always',
            guildPolicies: conn.discordGuildPolicies ?? {},
          });
          if (!data.ok) return false;
          get().updateConnection('discord', {
            discordListenerEnabled: true,
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
        // Tokenless stop is allowed — the endpoint falls back to the token
        // saved in settings.json.
        if (!conn?.botToken && !conn?.discordServerConfigured) return false;
        try {
          await postJson('/api/messenger/discord/listener/stop', {
            ...(conn?.botToken ? { token: conn.botToken } : {}),
          });
          get().updateConnection('discord', {
            discordListenerEnabled: false,
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

      setDiscordGuildPolicy: (guildId, patch) => {
        const conn = get().connections.find((c) => c.type === 'discord');
        if (!conn) return;
        const prev = conn.discordGuildPolicies ?? {};
        const existing = prev[guildId] ?? {};
        const nextPolicy = { ...existing, ...patch };
        const updates: Partial<MessengerConnection> = {
          discordGuildPolicies: {
            ...prev,
            [guildId]: nextPolicy,
          },
        };
        // Enabling project sync on a server designates it the primary sync
        // target when none exists yet, so legacy single-server flows (auto
        // channel create on project add, diagnose) keep a server to point at.
        if (patch.syncProjects === true && !conn.discordGuildId) {
          updates.discordGuildId = guildId;
        }
        get().updateConnection('discord', updates);
        setTimeout(() => get().saveDiscordConfig(), 0);

        // Resolve the server's channels/categories so the category picker +
        // thread toggle can render right after "Sync projects here" is enabled.
        if (patch.syncProjects === true && !get().connections.find((c) => c.type === 'discord')?.discordGuildResolved?.[guildId]) {
          setTimeout(() => void get().resolveDiscordGuild(guildId), 0);
        }

        // Auto-manage the single gateway connection: start it as soon as any
        // server is set to respond, stop it when none are (there is no manual
        // Start/Stop in the primary UI anymore). Tokenless clients use the
        // server-saved token fallback on the start/stop endpoints.
        const latest = get().connections.find((c) => c.type === 'discord');
        if (!latest?.botToken && !latest?.discordServerConfigured) return;
        const shouldListen = anyDiscordGuildResponds(latest);
        if (shouldListen && !latest.discordListenerRunning) {
          setTimeout(() => void get().startDiscordListener(), 0);
        } else if (!shouldListen && latest.discordListenerRunning) {
          setTimeout(() => void get().stopDiscordListener(), 0);
        }
      },

      setDiscordDefaultReplyMode: (mode) => {
        get().updateConnection('discord', { discordDefaultReplyMode: mode });
        setTimeout(() => get().saveDiscordConfig(), 0);
      },

      refreshDiscordListenerStatus: async () => {
        const conn = get().connections.find((c) => c.type === 'discord');
        try {
          // Prefer the server-saved config probe. After rebuild the gateway is
          // keyed by settings.json; this does not require the UI token body to
          // match, and works through runtimeFetch auth/base URL.
          let data: DiscordListenerStatusPayload | null = null;
          try {
            data = await getJson<DiscordListenerStatusPayload>(
              '/api/messenger/discord/runtime-status',
            );
          } catch {
            data = null;
          }
          // After Disconnect the server has no config. Do not fall back to a
          // client-token probe that could resurrect a stale "connected" view
          // from a gateway that should already be stopped.
          if (data?.ok && data.configured === false) {
            if (!conn) return;
            get().updateConnection('discord', {
              discordServerConfigured: false,
              discordListenerEnabled: false,
              discordListenerRunning: false,
              discordListenerConnected: false,
              discordListenerError: null,
            });
            return;
          }
          if ((!data || !data.ok) && conn?.botToken) {
            data = await postJson<DiscordListenerStatusPayload>(
              '/api/messenger/discord/listener/status',
              { token: conn.botToken },
            );
          }
          if (!data?.ok) return;

          const updates: Partial<MessengerConnection> = {
            // Reflect server-side config presence so the settings view can
            // show the configured surface even when the local store lost the
            // token (e.g. localStorage cleared).
            discordServerConfigured: data.configured ?? false,
            discordListenerEnabled:
              typeof data.listenerEnabled === 'boolean'
                ? data.listenerEnabled
                : conn?.discordListenerEnabled,
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
            discordDefaultReplyMode:
              data.defaultReplyMode ?? conn?.discordDefaultReplyMode ?? 'always',
            discordGuildPolicies: data.guildPolicies ?? conn?.discordGuildPolicies ?? {},
          };
          if (data.botId) updates.discordBotId = data.botId;
          if (data.botUsername) updates.discordBotUsername = data.botUsername;
          // Authoritative live gateway → keep the header badge in sync even
          // when the separate token-verify call has not completed yet.
          if (data.connected) {
            updates.status = 'connected';
            updates.error = null;
            updates.lastConnectedAt = Date.now();
          } else if (data.running && conn?.status === 'disconnected') {
            updates.status = 'connecting';
            updates.error = null;
          }
          get().updateConnection('discord', updates);
        } catch {
          // ignore — keep prior listener fields; a failed probe must not look
          // like an authoritative "listener stopped" result.
        }
      },

      resyncDiscordStatus: async () => {
        if (discordStatusResyncInFlight) return discordStatusResyncInFlight;
        discordStatusResyncInFlight = (async () => {
          // Persist the UI token to server-side settings.json FIRST so the
          // runtime-status probe below keys by the current token, not a stale
          // one left over from a prior (now-revoked) bot token.
          //
          // Previously saveDiscordConfig ran *after* refreshDiscordListenerStatus,
          // which caused a phantom "Gateway 4004: Invalid bot token" to surface
          // in the onboarding wizard after the user entered a new token: the
          // settings.json still held the old (revoked) token at probe time, and
          // the old listener's corpse state in the in-memory registry returned
          // its lastError — even though REST calls with the new token worked.
          const conn = get().connections.find((c) => c.type === 'discord');
          if (conn?.botToken) {
            await get().saveDiscordConfig();
          }

          // Probe server runtime status (settings.json auto-start). Do this
          // even without a UI token so the badge reflects a server-side
          // auto-started listener.
          await get().refreshDiscordListenerStatus();

          const afterRefresh = get().connections.find((c) => c.type === 'discord');
          // Load guilds when we hold a local token OR when the server reports a
          // configured bot (tokenless second device / cleared storage).
          // refreshDiscordGuilds() uses the /test server-token fallback, so the
          // Servers list + per-server actions render either way. Bail only when
          // neither source is available.
          if (!afterRefresh?.botToken && !afterRefresh?.discordServerConfigured) return;

          // Always refresh guild membership + bot identity when configured.
          // Previously this was gated on !connected, so a live gateway after
          // reload skipped the fetch and left stale/empty discordGuilds.
          await get().refreshDiscordGuilds();

          // One-time migration: fold the legacy single "primary sync server"
          // (discordGuildId + top-level category/threads) into an explicit
          // per-server policy, so the new Servers UI drives project sync
          // uniformly. Idempotent — once any server has an explicit syncProjects
          // flag we never re-seed.
          const preMigrate = get().connections.find((c) => c.type === 'discord');
          if (preMigrate?.discordGuildId) {
            const policies = preMigrate.discordGuildPolicies ?? {};
            const anyExplicit = Object.values(policies).some((p) => p?.syncProjects);
            if (!anyExplicit) {
              const gid = preMigrate.discordGuildId;
              get().updateConnection('discord', {
                discordGuildPolicies: {
                  ...policies,
                  [gid]: {
                    ...(policies[gid] ?? {}),
                    syncProjects: true,
                    parentCategoryId:
                      policies[gid]?.parentCategoryId ?? preMigrate.discordParentCategoryId,
                    createThreads:
                      policies[gid]?.createThreads ?? preMigrate.discordCreateThreads !== false,
                  },
                },
              });
              void get().saveDiscordConfig();
            }
          }

          const latest = get().connections.find((c) => c.type === 'discord');
          // Respect sticky stop — never auto-restart after the user stopped
          // listening (listenerEnabled === false). Otherwise keep the single
          // gateway live whenever at least one joined server should respond.
          // Tokenless clients rely on the server-saved token for the start.
          if (
            (latest?.botToken || latest?.discordServerConfigured) &&
            latest.discordListenerEnabled !== false &&
            !latest.discordListenerRunning &&
            anyDiscordGuildResponds(latest)
          ) {
            await get().startDiscordListener();
          }
        })().finally(() => {
          discordStatusResyncInFlight = null;
        });
        return discordStatusResyncInFlight;
      },

      loadRecentDiscordMessages: async () => {
        const conn = get().connections.find((c) => c.type === 'discord');
        if (!conn?.botToken) return;
        try {
          const data = await postJson<{
            ok: boolean;
            messages?: MessengerInboundMessage[];
          }>('/api/messenger/discord/listener/recent', {
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
          }>('/api/messenger/discord/history', {
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
          const url = '/api/messenger/discord/send-approval';
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
        // Per-project channels require a sync-enabled server. Auto-create targets
        // the primary sync server; "Sync now" propagates to the rest.
        const syncGuildId = conn ? getDiscordSyncGuildIds(conn)[0] : undefined;
        if (!conn?.botToken || !syncGuildId || conn.syncProjects === false) return;
        const policy = conn.discordGuildPolicies?.[syncGuildId] ?? {};
        const parentCategoryId =
          policy.parentCategoryId ??
          (syncGuildId === conn.discordGuildId ? conn.discordParentCategoryId : undefined);
        const projectLabel = project.label ?? project.path;
        try {
          const data = await postJson<{
            ok: boolean;
            results?: { ok: boolean; channelId?: string; channelName?: string }[];
          }>('/api/messenger/bridge/project-added', {
            project: { id: project.id, path: project.path, label: projectLabel },
            discord: {
              token: conn.botToken,
              guildId: syncGuildId,
              parentCategoryId,
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
        const syncGuildId = conn ? getDiscordSyncGuildIds(conn)[0] : undefined;
        if (!conn?.botToken || !syncGuildId || conn.syncProjects === false) return;
        const policy = conn.discordGuildPolicies?.[syncGuildId] ?? {};
        const parentCategoryId =
          policy.parentCategoryId ??
          (syncGuildId === conn.discordGuildId ? conn.discordParentCategoryId : undefined);
        const projectLabel = project.label ?? project.path;
        try {
          const data = await postJson<{
            ok: boolean;
            channelId?: string | null;
            channelName?: string | null;
          }>('/api/messenger/bridge/project-renamed', {
            project: { id: project.id, path: project.path, label: projectLabel },
            discord: {
              token: conn.botToken,
              guildId: syncGuildId,
              parentCategoryId,
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
          await postJson('/api/messenger/bridge/project-removed', {
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
      name: 'openchamber-agent-messenger-config',
      storage: createJSONStorage(() => {
        const storage = getSafeStorage();
        const legacyKey = 'otto-messenger-config';
        return {
          getItem: (name: string) => {
            const current = storage.getItem(name);
            if (current != null) return current;
            const legacy = storage.getItem(legacyKey);
            if (legacy != null) {
              storage.setItem(name, legacy);
              storage.removeItem(legacyKey);
              return legacy;
            }
            return null;
          },
          setItem: (name: string, value: string) => storage.setItem(name, value),
          removeItem: (name: string) => storage.removeItem(name),
        };
      }),
      partialize: (state) => ({
        connections: state.connections.map((c) => ({
          ...c,
          status: 'disconnected' as const,
          error: null,
          lastSyncStatus: 'idle' as const,
          lastSyncMessage: null,
          // Live gateway fields live on the server — clear them on persist so
          // the UI re-syncs after reload. Keep discordListenerEnabled: a sticky
          // local stop must not look like "unset → auto-start" before the
          // server probe returns.
          // Also clear discordServerConfigured — it must be re-acquired from
          // the live server probe on the next load.
          discordServerConfigured: false,
          discordListenerRunning: false,
          discordListenerConnected: false,
          discordListenerStartedAt: null,
          discordListenerLastUpdateAt: null,
          discordListenerError: null,
        })),
        projectMappings: state.projectMappings,
      }),
      merge: (persistedState: unknown, currentState: MessengerState): MessengerState => ({
        ...currentState,
        ...(persistedState as Partial<MessengerState>),
        // Mark the store fully rehydrated so the settings UI won't flash
        // the "Connect Discord" tile on every reload while waiting for
        // localStorage.
        hasHydrated: true,
      }),
      onRehydrateStorage: () => () => {
        // Always unblock the Integrations UI — even when rehydrate fails.
        useMessengerStore.setState({ hasHydrated: true });
        // After localStorage rehydrate, pull live listener + token status
        // from the server.  Defer so the store API is fully wired.
        // Always probe — even a corrupt/empty localStorage still has a
        // server-side settings.json that may hold a live bot token.
        queueMicrotask(() => {
          void useMessengerStore.getState().resyncDiscordStatus();
        });
      },
    },
  ),
);

// Safety net: ensure hasHydrated is set even when no persisted data exists
// (the merge function is only called when storage returns data).  Mirrors
// the pattern from useTerminalStore — including the final else so a missing
// persist API can never leave Integrations blank forever.
if (typeof window !== 'undefined') {
  const persistApi = (
    useMessengerStore as unknown as {
      persist?: {
        hasHydrated?: () => boolean;
        onFinishHydration?: (cb: () => void) => (() => void) | void;
      };
    }
  ).persist;
  const markHydrated = () => {
    if (!useMessengerStore.getState().hasHydrated) {
      useMessengerStore.setState({ hasHydrated: true });
    }
  };
  if (persistApi?.hasHydrated?.()) {
    markHydrated();
  } else if (persistApi?.onFinishHydration) {
    persistApi.onFinishHydration(markHydrated);
  } else {
    markHydrated();
  }
}
