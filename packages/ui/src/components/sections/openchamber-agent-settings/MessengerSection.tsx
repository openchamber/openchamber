import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  RiDiscordLine,
  RiCheckLine,
  RiLoader4Line,
  RiAddLine,
  RiSendPlaneLine,
  RiRefreshLine,
  RiAlertLine,
  RiExternalLinkLine,
  RiEyeLine,
  RiEyeOffLine,
  RiPlayCircleLine,
  RiStopCircleLine,
  RiChatSmile3Line,
  RiStethoscopeLine,
} from '@remixicon/react';
import {
  MESSENGER_INTERRUPT_TIMEOUT_DEFAULT_MS,
  MESSENGER_INTERRUPT_TIMEOUT_MAX_MS,
  MESSENGER_INTERRUPT_TIMEOUT_MIN_MS,
  deriveDiscordDisplayStatus,
  useMessengerStore,
  type MessengerType,
  type MessengerConnection,
  type MessengerVerbosity,
  type MessengerPermissionMode,
  type MessengerDiagnosisCheck,
  type MessengerInboundMessage,
} from '@/stores/useMessengerStore';
import { useOpenChamberAgentEventsStore, type OpenChamberAgentUiRealtimeEvent } from '@/stores/useOpenChamberAgentEventsStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { Checkbox } from '@/components/ui/checkbox';
import { Collapsible, CollapsibleContent } from '@/components/ui/collapsible';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { Icon } from '@/components/icon/Icon';
import { DiscordOnboardingWizard } from './DiscordOnboardingWizard';
import { DiscordCommandsButton } from './DiscordCommandPalette';

interface MessengerMeta {
  name: string;
  icon: typeof RiDiscordLine;
  color: string;
  tokenLabel: string;
  tokenHelp: React.ReactNode;
  targetLabel: string;
  targetPlaceholder: string;
  targetHelp: React.ReactNode;
}

const MESSENGER_META: Record<MessengerType, MessengerMeta> = {
  discord: {
    name: 'Discord',
    icon: RiDiscordLine,
    color: 'text-[#5865F2]',
    tokenLabel: 'Bot Token',
    tokenHelp: (
      <>
        Create a bot at{' '}
        <a
          href="https://discord.com/developers/applications"
          target="_blank"
          rel="noreferrer"
          className="text-primary hover:underline inline-flex items-center gap-0.5"
        >
          discord.com/developers <RiExternalLinkLine className="size-3" />
        </a>{' '}
        → Bot → Reset Token. Enable the <em>Message Content</em> intent so OpenChamber agent can read replies.
      </>
    ),
    targetLabel: 'Channel ID',
    targetPlaceholder: 'e.g. 1234567890123456789',
    targetHelp: (
      <>
        Enable Developer Mode, then right-click a text channel → <strong>Copy Channel ID</strong>.
      </>
    ),
  },
};

const VERBOSITY_OPTIONS: { id: MessengerVerbosity; label: string; desc: string }[] = [
  { id: 'quiet', label: 'Quiet', desc: 'Final answer only — hides reasoning and tool activity' },
  {
    id: 'normal',
    label: 'Normal',
    desc: 'Compact activity feed — tool names with short summaries and a thinking marker, no payloads',
  },
  {
    id: 'verbose',
    label: 'Verbose',
    desc: 'Full detail — commands, diffs, outputs and reasoning, formatted for reading',
  },
];

const PERMISSION_MODE_OPTIONS: {
  id: MessengerPermissionMode;
  labelKey: I18nKey;
  descKey: I18nKey;
}[] = [
  {
    id: 'ask',
    labelKey: 'settings.integrations.discord.bridge.permissionMode.ask.label',
    descKey: 'settings.integrations.discord.bridge.permissionMode.ask.desc',
  },
  {
    id: 'auto-edit',
    labelKey: 'settings.integrations.discord.bridge.permissionMode.autoEdit.label',
    descKey: 'settings.integrations.discord.bridge.permissionMode.autoEdit.desc',
  },
  {
    id: 'yolo',
    labelKey: 'settings.integrations.discord.bridge.permissionMode.yolo.label',
    descKey: 'settings.integrations.discord.bridge.permissionMode.yolo.desc',
  },
];

function StatusBadge({ status }: { status: MessengerConnection['status'] }) {
  const styles: Record<string, string> = {
    connected: 'bg-green-500/20 text-green-600 dark:text-green-400',
    connecting: 'bg-yellow-500/20 text-yellow-600 dark:text-yellow-400',
    error: 'bg-red-500/20 text-red-600 dark:text-red-400',
    disconnected: 'bg-muted text-muted-foreground',
  };
  return (
    <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-medium', styles[status])}>
      {status === 'connecting' && (
        <RiLoader4Line className="inline size-3 animate-spin mr-0.5" />
      )}
      {status}
    </span>
  );
}

function formatRelative(ts: number | null | undefined): string {
  if (!ts) return 'never';
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(ts).toLocaleString();
}

function severityClass(s: MessengerDiagnosisCheck['severity']) {
  if (s === 'ok') return 'text-green-600 dark:text-green-400';
  if (s === 'warn') return 'text-yellow-600 dark:text-yellow-400';
  if (s === 'error') return 'text-destructive';
  return 'text-muted-foreground';
}

function DiscordListenerPanel({
  conn,
  inbound,
  history,
  startListener,
  stopListener,
  refreshStatus,
  loadRecent,
  loadHistory,
  onToggleAutoReply,
}: {
  conn: MessengerConnection;
  inbound: MessengerInboundMessage[];
  history: ReturnType<typeof useMessengerStore.getState>['discordHistory'];
  startListener: () => Promise<boolean>;
  stopListener: () => Promise<boolean>;
  refreshStatus: () => Promise<void>;
  loadRecent: () => Promise<void>;
  loadHistory: (channelId: string, limit?: number) => Promise<boolean>;
  onToggleAutoReply: (v: boolean) => void;
}) {
  const { t } = useI18n();
  const running = Boolean(conn.discordListenerRunning);
  const connected = Boolean(conn.discordListenerConnected);
  const autoReply = conn.discordListenerAutoReply !== false;
  const subscribeToEvents = useOpenChamberAgentEventsStore((s) => s.subscribeToEvents);
  const ingestDiscordInbound = useMessengerStore((s) => s.ingestDiscordInbound);

  useEffect(() => {
    if (!running) return;
    const handler = (event: OpenChamberAgentUiRealtimeEvent) => {
      if (event.eventType !== 'messenger.discord.message_received') return;
      const data = event.data as MessengerInboundMessage | undefined;
      if (data && typeof data === 'object' && 'updateId' in data) {
        ingestDiscordInbound(data);
      }
    };
    return subscribeToEvents(handler);
  }, [running, subscribeToEvents, ingestDiscordInbound]);

  useEffect(() => {
    if (!running) return;
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      await Promise.all([refreshStatus(), loadRecent()]);
    };
    tick();
    const id = setInterval(tick, 10_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [running, refreshStatus, loadRecent]);

  // Reconcile with the live server (settings.json auto-start). Re-run when the
  // hydrated token appears so we don't race Zustand persist.
  useEffect(() => {
    void useMessengerStore.getState().resyncDiscordStatus();
    if (conn.botToken) void loadRecent();
  }, [conn.botToken, loadRecent]);

  const historyTarget = conn.defaultChannelId;

  return (
    <div className="rounded-md border border-border/60 bg-muted/30 p-3 space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 text-xs font-medium text-foreground">
          <RiChatSmile3Line className="size-4 text-primary" />
          {t('settings.integrations.discord.listener.title')}
          <span
            className={cn(
              'rounded-full px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide',
              connected
                ? 'bg-[var(--status-success)]/20 text-[var(--status-success)]'
                : running
                  ? 'bg-[var(--status-warning)]/20 text-[var(--status-warning)]'
                  : 'bg-muted text-muted-foreground',
            )}
          >
            {connected
              ? t('settings.integrations.discord.listener.status.live')
              : running
                ? t('settings.integrations.discord.listener.status.connecting')
                : t('settings.integrations.discord.listener.status.off')}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {!running ? (
            <Button
              type="button"
              variant="default"
              size="xs"
              className="!font-normal"
              onClick={() => void startListener()}
            >
              <RiPlayCircleLine className="size-3.5" />
              {t('settings.integrations.discord.listener.start')}
            </Button>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="!font-normal text-[var(--status-error)] hover:text-[var(--status-error)]"
              onClick={() => void stopListener()}
            >
              <RiStopCircleLine className="size-3.5" />
              {t('settings.integrations.discord.listener.stop')}
            </Button>
          )}
          <label className="flex items-center gap-1 text-[10px] text-muted-foreground cursor-pointer">
            <input
              type="checkbox"
              checked={autoReply}
              onChange={(e) => onToggleAutoReply(e.target.checked)}
              className="rounded border-border accent-primary"
            />
            Auto-reply
          </label>
          <label
            className="flex items-center gap-1 text-[10px] text-muted-foreground cursor-pointer"
            title="When on, only messages from the saved Server (Guild) ID reach the UI. When off (default) every message the bot can see is forwarded."
          >
            <input
              type="checkbox"
              checked={Boolean(conn.discordListenerScopeToGuild)}
              onChange={(e) => {
                useMessengerStore
                  .getState()
                  .updateConnection('discord', { discordListenerScopeToGuild: e.target.checked });
                // Persist to server-side settings.json so auto-start works on reboot
                setTimeout(() => useMessengerStore.getState().saveDiscordConfig(), 0);
              }}
              className="rounded border-border accent-primary"
            />
            Scope to saved server
          </label>
        </div>
      </div>

      <div className="grid grid-cols-4 gap-2 text-[10px]">
        <div className="rounded bg-background border border-border px-2 py-1.5">
          <div className="text-muted-foreground">Gateway saw</div>
          <div className="text-foreground font-medium">
            {conn.discordListenerTotalRawMessages ?? 0}
          </div>
        </div>
        <div className="rounded bg-background border border-border px-2 py-1.5">
          <div className="text-muted-foreground">Forwarded</div>
          <div className="text-foreground font-medium">
            {conn.discordListenerTotalReceived ?? 0}
          </div>
        </div>
        <div className="rounded bg-background border border-border px-2 py-1.5">
          <div className="text-muted-foreground">Replied</div>
          <div className="text-foreground font-medium">
            {conn.discordListenerTotalReplied ?? 0}
          </div>
        </div>
        <div className="rounded bg-background border border-border px-2 py-1.5">
          <div className="text-muted-foreground">Last update</div>
          <div className="text-foreground font-medium">
            {formatRelative(conn.discordListenerLastUpdateAt ?? null)}
          </div>
        </div>
      </div>

      {/* Loud diagnostic when the saved guild ID doesn't match the guild the
          gateway is actually delivering messages from — common root cause of
          "the bot doesn't reply to my messages". */}
      {(conn.discordListenerFilteredOutCount ?? 0) > 0 &&
        conn.discordListenerScopeToGuild &&
        conn.discordListenerLastFilteredGuildId &&
        conn.discordListenerLastFilteredGuildId !== conn.discordGuildId && (
          <div className="rounded-md border border-yellow-500/30 bg-yellow-500/10 px-3 py-2 text-[11px] text-yellow-800 dark:text-yellow-300 flex items-start gap-2 leading-snug">
            <RiAlertLine className="size-3.5 shrink-0 mt-0.5" />
            <div>
              <div className="font-medium">
                Filtered out {conn.discordListenerFilteredOutCount} message
                {conn.discordListenerFilteredOutCount === 1 ? '' : 's'} from guild{' '}
                <code className="bg-muted px-1 rounded">{conn.discordListenerLastFilteredGuildId}</code>
              </div>
              <div className="mt-0.5">
                The listener is scoped to your saved Server ID (
                <code className="bg-muted px-1 rounded">{conn.discordGuildId}</code>) but the bot
                is also hearing from another server. Update the Server ID, or turn off
                "Scope to saved server" below.
              </div>
            </div>
          </div>
        )}

      {/* Hint when the gateway is connected but no messages have arrived yet —
          either the bot has no channel access, or MESSAGE_CONTENT is off. */}
      {connected && (conn.discordListenerTotalRawMessages ?? 0) === 0 && (
        <div className="rounded-md border border-border/60 bg-muted/40 px-3 py-2 text-[11px] text-muted-foreground leading-snug">
          Connected. If messages don't arrive, give the bot <em>View Channel</em> access and enable
          the <em>Message Content</em> intent, then restart the listener.
        </div>
      )}

      {conn.discordListenerError && (
        <div className="text-[11px] text-destructive flex items-start gap-1.5 leading-snug">
          <RiAlertLine className="size-3.5 shrink-0 mt-0.5" />
          {conn.discordListenerError}
        </div>
      )}

      {!running ? (
        <div className="text-[11px] text-muted-foreground leading-snug">
          Start the listener so OpenChamber agent can answer messages sent to the bot.
        </div>
      ) : inbound.length === 0 ? (
        <div className="text-[11px] text-muted-foreground italic">
          Waiting for messages… Mention or DM the bot in your server.
        </div>
      ) : (
        <ul className="space-y-1.5 max-h-48 overflow-y-auto">
          {inbound.slice(0, 8).map((m) => (
            <li
              key={String(m.updateId)}
              className="rounded bg-background border border-border px-2 py-1.5 text-[11px] space-y-0.5"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-foreground truncate">
                  {m.from?.firstName ?? m.from?.username ?? 'Unknown'}
                  {m.from?.username ? (
                    <span className="text-muted-foreground"> @{m.from.username}</span>
                  ) : null}
                </span>
                <span className="text-[9px] text-muted-foreground shrink-0">
                  {new Date(m.receivedAt).toLocaleTimeString()}
                </span>
              </div>
              <div className="text-muted-foreground break-words">
                {m.text ?? <em>(non-text message)</em>}
              </div>
              <div className="text-[9px] text-muted-foreground">
                channel {m.chatId}
                {m.discord?.guildId ? ` · guild ${m.discord.guildId}` : ''}
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* History fetch — last messages from the configured channel. */}
      <div className="border-t border-border/60 pt-2 space-y-1.5">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="text-[11px] font-medium text-foreground">Channel history</div>
          <button
            type="button"
            onClick={() => historyTarget && loadHistory(historyTarget, 50)}
            disabled={!historyTarget}
            className="rounded bg-primary/10 px-2 py-0.5 text-[10px] text-primary hover:bg-primary/20 disabled:opacity-50"
          >
            Fetch last 50
          </button>
        </div>
        {!historyTarget && (
          <div className="text-[10px] text-muted-foreground">
            Save a default Channel ID to enable history fetch.
          </div>
        )}
        {historyTarget && history.length === 0 && (
          <div className="text-[10px] text-muted-foreground italic">
            No history loaded yet — click "Fetch last 50".
          </div>
        )}
        {history.length > 0 && (
          <ul className="space-y-1 max-h-40 overflow-y-auto">
            {history.slice(0, 10).map((m) => (
              <li
                key={m.id}
                className="rounded bg-background border border-border px-2 py-1 text-[10px]"
              >
                <span className="font-medium text-foreground">
                  {m.author.globalName ?? m.author.username ?? m.author.id}
                </span>{' '}
                <span className="text-[9px] text-muted-foreground">
                  {new Date(m.timestamp).toLocaleTimeString()}
                </span>
                <div className="text-muted-foreground break-words">
                  {m.content || <em>(no text — {m.attachmentCount} attachment{m.attachmentCount === 1 ? '' : 's'})</em>}
                </div>
              </li>
            ))}
            {history.length > 10 && (
              <li className="text-[10px] text-muted-foreground italic px-2">
                + {history.length - 10} older message{history.length - 10 === 1 ? '' : 's'}
              </li>
            )}
          </ul>
        )}
      </div>
    </div>
  );
}

function DiscordDiagnosePanel({
  conn,
  diagnosis,
  running,
  runDiagnose,
}: {
  conn: MessengerConnection;
  diagnosis: ReturnType<typeof useMessengerStore.getState>['discordDiagnosis'];
  running: boolean;
  runDiagnose: () => Promise<boolean>;
}) {
  const hasIssue = diagnosis?.checks?.some((c) => !c.ok && c.severity !== 'info') ?? false;
  return (
    <div className="rounded-md border border-border/60 bg-muted/30 p-3 space-y-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 text-xs font-medium text-foreground">
          <RiStethoscopeLine className="size-4 text-primary" />
          Diagnose
          {diagnosis && (
            <span
              className={cn(
                'rounded-full px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide',
                hasIssue
                  ? 'bg-yellow-500/20 text-yellow-700 dark:text-yellow-300'
                  : 'bg-green-500/20 text-green-700 dark:text-green-400',
              )}
            >
              {hasIssue ? 'issues' : 'all clear'}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => runDiagnose()}
          disabled={running}
          className="inline-flex items-center gap-1 rounded bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {running ? (
            <RiLoader4Line className="size-3.5 animate-spin" />
          ) : (
            <RiStethoscopeLine className="size-3.5" />
          )}
          {running ? 'Running…' : diagnosis ? 'Re-run diagnose' : 'Run diagnose'}
        </button>
      </div>
      {!diagnosis && (
        <div className="text-[11px] text-muted-foreground leading-snug">
          Diagnose validates token, server access, default channel posting permissions, and
          flags the Message Content intent requirement for the gateway listener.
        </div>
      )}
      {diagnosis && diagnosis.checks.length > 0 && (
        <ul className="space-y-1.5">
          {diagnosis.checks.map((c) => (
            <li key={c.id} className="rounded bg-background border border-border px-2 py-1.5">
              <div className="flex items-start gap-1.5">
                <span className={cn('text-xs leading-none mt-0.5', severityClass(c.severity))}>
                  {c.severity === 'ok' ? '✓' : c.severity === 'warn' ? '⚠' : c.severity === 'error' ? '✗' : 'ⓘ'}
                </span>
                <div className="flex-1 min-w-0">
                  <div className={cn('text-[11px] font-medium', severityClass(c.severity))}>
                    {c.title}
                  </div>
                  <div className="text-[10px] text-muted-foreground leading-snug mt-0.5 break-words">
                    {c.detail}
                  </div>
                  {c.fix && (
                    <div className="text-[10px] text-foreground leading-snug mt-1">
                      <span className="font-medium">Fix: </span>
                      {c.fix}
                    </div>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
      {diagnosis && (
        <div className="text-[10px] text-muted-foreground">
          Last run {formatRelative(diagnosis.runAt)} for {conn.discordBotUsername ? `bot ${conn.discordBotUsername}` : 'this bot'}.
        </div>
      )}
    </div>
  );
}

function BridgePanel({
  conn,
  type,
  bridgeStatus,
  refreshBridgeStatus,
  onToggle,
}: {
  conn: MessengerConnection;
  type: MessengerType;
  bridgeStatus: ReturnType<typeof useMessengerStore.getState>['bridgeStatus'];
  refreshBridgeStatus: (t?: MessengerType) => Promise<void>;
  onToggle: (v: boolean) => void;
}) {
  const { t } = useI18n();
  const enabled = conn.bridgeEnabled !== false;
  const bridgeVerbosity = useMessengerStore((s) => s.bridgeVerbosity);
  const setBridgeVerbosity = useMessengerStore((s) => s.setBridgeVerbosity);
  const bridgePermissionMode = useMessengerStore((s) => s.bridgePermissionMode);
  const setBridgePermissionMode = useMessengerStore((s) => s.setBridgePermissionMode);
  const bridgeNotifyOnComplete = useMessengerStore((s) => s.bridgeNotifyOnComplete);
  const setBridgeNotifyOnComplete = useMessengerStore((s) => s.setBridgeNotifyOnComplete);
  const bridgeInterruptTimeoutMs = useMessengerStore((s) => s.bridgeInterruptTimeoutMs);
  const setBridgeInterruptTimeoutMs = useMessengerStore((s) => s.setBridgeInterruptTimeoutMs);
  useEffect(() => {
    refreshBridgeStatus(type);
    const id = setInterval(() => refreshBridgeStatus(type), 8000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type]);

  const bindings = bridgeStatus.bindings.filter((b) => b.type === type);
  const active = bridgeStatus.active.filter((a) => a.type === type);
  const currentVerbosity: MessengerVerbosity = bridgeVerbosity[type] ?? 'normal';
  const currentPermissionMode: MessengerPermissionMode = bridgePermissionMode[type] ?? 'ask';
  const currentPermissionOption =
    PERMISSION_MODE_OPTIONS.find((o) => o.id === currentPermissionMode) ??
    PERMISSION_MODE_OPTIONS[0];
  const notifyOnComplete = bridgeNotifyOnComplete[type] ?? false;
  const interruptTimeoutMs =
    bridgeInterruptTimeoutMs[type] ?? MESSENGER_INTERRUPT_TIMEOUT_DEFAULT_MS;

  return (
    <div className="rounded-md border border-primary/30 bg-primary/5 p-3 space-y-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 text-xs font-medium text-foreground">
          <RiChatSmile3Line className="size-4 text-primary" />
          OpenCode bridge
          <span
            className={cn(
              'rounded-full px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide',
              bridgeStatus.enabled && enabled
                ? 'bg-green-500/20 text-green-700 dark:text-green-400'
                : 'bg-muted text-muted-foreground',
            )}
          >
            {!bridgeStatus.enabled ? 'unavailable' : enabled ? 'on' : 'off'}
          </span>
        </div>
        <label className="flex items-center gap-1 text-[10px] text-muted-foreground cursor-pointer">
          <input
            type="checkbox"
            checked={enabled}
            disabled={!bridgeStatus.enabled}
            onChange={(e) => onToggle(e.target.checked)}
            className="rounded border-border accent-primary"
          />
          Forward messages to OpenCode
        </label>
      </div>
      <div className="text-[11px] text-muted-foreground leading-snug">
        Forwards channel messages to an OpenCode session in the matching project and streams the
        reply back, so the conversation is shared with the web UI.
      </div>
      <div data-settings-item="integrations.discord.proxy-worktrees" className="text-[10px] text-muted-foreground leading-snug">
        {t('settings.integrations.discord.bridge.proxyNote')}
      </div>
      <div className="text-[10px] text-muted-foreground leading-snug">
        {t('settings.integrations.discord.bridge.autoWorktreeNote')}
      </div>
      {!bridgeStatus.enabled && (
        <div className="text-[10px] text-yellow-700 dark:text-yellow-400">
          The web server reports the bridge is unavailable — OpenCode may not be reachable yet.
        </div>
      )}

      {/* Output verbosity — how much of each OpenCode turn is mirrored back. */}
      <div className="space-y-1.5 border-t border-border/60 pt-2">
        <div className="text-[11px] font-medium text-foreground">Output verbosity</div>
        <div className="flex gap-1">
          {VERBOSITY_OPTIONS.map((opt) => (
            <button
              key={opt.id}
              type="button"
              onClick={() => setBridgeVerbosity(type, opt.id)}
              disabled={!bridgeStatus.enabled}
              className={cn(
                'flex-1 rounded-md px-2 py-1.5 text-[10px] font-medium transition-colors disabled:opacity-50',
                currentVerbosity === opt.id
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted text-muted-foreground hover:text-foreground',
              )}
              title={opt.desc}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <div className="text-[10px] text-muted-foreground leading-snug">
          {VERBOSITY_OPTIONS.find((o) => o.id === currentVerbosity)?.desc}.
        </div>
      </div>

      {/* Tool permission mode — same defaults as /yolo and /permissions. */}
      <div className="space-y-1.5 border-t border-border/60 pt-2">
        <div className="text-[11px] font-medium text-foreground">
          {t('settings.integrations.discord.bridge.permissionMode.title')}
        </div>
        <div className="flex gap-1">
          {PERMISSION_MODE_OPTIONS.map((opt) => (
            <button
              key={opt.id}
              type="button"
              onClick={() => setBridgePermissionMode(type, opt.id)}
              disabled={!bridgeStatus.enabled}
              className={cn(
                'flex-1 rounded-md px-2 py-1.5 text-[10px] font-medium transition-colors disabled:opacity-50',
                currentPermissionMode === opt.id
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted text-muted-foreground hover:text-foreground',
              )}
              title={t(opt.descKey)}
            >
              {t(opt.labelKey)}
            </button>
          ))}
        </div>
        <div className="text-[10px] text-muted-foreground leading-snug">
          {t(currentPermissionOption.descKey)}
        </div>
      </div>

      <div
        data-settings-item="integrations.discord.notify-on-complete"
        className="space-y-1.5 border-t border-border/60 pt-2"
      >
        <label className="flex cursor-pointer items-start gap-2 py-1">
          <Checkbox
            checked={notifyOnComplete}
            onChange={(checked) => setBridgeNotifyOnComplete(type, checked)}
            disabled={!bridgeStatus.enabled}
            ariaLabel={t('settings.integrations.discord.bridge.notifyOnComplete.title')}
          />
          <span className="min-w-0">
            <span className="block text-[11px] font-medium text-foreground">
              {t('settings.integrations.discord.bridge.notifyOnComplete.title')}
            </span>
            <span className="block text-[10px] text-muted-foreground leading-snug">
              {t('settings.integrations.discord.bridge.notifyOnComplete.description')}
            </span>
          </span>
        </label>
      </div>

      <div
        data-settings-item="integrations.discord.interrupt-timeout"
        className="space-y-1.5 border-t border-border/60 pt-2"
      >
        <label className="text-[11px] font-medium text-foreground" htmlFor="discord-interrupt-timeout-ms">
          {t('settings.integrations.discord.bridge.interruptTimeout.title')}
        </label>
        <div className="flex items-center gap-2">
          <input
            id="discord-interrupt-timeout-ms"
            type="number"
            min={MESSENGER_INTERRUPT_TIMEOUT_MIN_MS}
            max={MESSENGER_INTERRUPT_TIMEOUT_MAX_MS}
            step={500}
            disabled={!bridgeStatus.enabled}
            value={interruptTimeoutMs}
            onChange={(event) => {
              const next = Number(event.target.value);
              if (Number.isFinite(next)) {
                setBridgeInterruptTimeoutMs(type, next);
              }
            }}
            className="h-7 w-24 rounded-md border border-border bg-background px-2 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
          />
          <span className="text-[10px] text-muted-foreground">
            {t('settings.integrations.discord.bridge.interruptTimeout.unit')}
          </span>
        </div>
        <div className="text-[10px] text-muted-foreground leading-snug">
          {t('settings.integrations.discord.bridge.interruptTimeout.description')}
        </div>
      </div>

      {bindings.length > 0 && (
        <div className="space-y-1">
          <div className="text-[10px] font-medium text-foreground">
            Channel ↔ session bindings ({bindings.length})
          </div>
          <ul className="space-y-0.5 max-h-32 overflow-y-auto">
            {bindings.slice(0, 8).map((b) => (
              <li
                key={`${b.type}:${b.targetKey}:${b.sessionId}`}
                className="text-[10px] text-muted-foreground"
              >
                <code className="bg-muted px-1 rounded">{b.targetKey}</code> →{' '}
                <code className="bg-muted px-1 rounded">{b.sessionId.slice(0, 16)}…</code>
                {b.projectLabel ? ` · ${b.projectLabel}` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}
      {active.length > 0 && (
        <div className="text-[10px] text-muted-foreground">
          <span className="text-primary">▶</span> {active.length} prompt
          {active.length === 1 ? '' : 's'} streaming…
        </div>
      )}
    </div>
  );
}

function DiscordSyncResults({
  channels,
  guildName,
}: {
  channels: NonNullable<MessengerConnection['lastSyncChannels']>;
  guildName?: string;
}) {
  return (
    <div className="rounded-md border border-border/60 bg-muted/30 p-3 space-y-2">
      <div className="text-xs font-medium text-foreground flex items-center gap-1.5">
        <RiCheckLine className="size-3.5 text-primary" />
        Last sync result{' '}
        {guildName && (
          <span className="text-[10px] font-normal text-muted-foreground">({guildName})</span>
        )}
      </div>
      <ul className="space-y-1">
        {channels.map((c) => {
          const channelOk = !c.error && Boolean(c.messageId);
          const threadAsked = c.threadRequested !== false;
          // Status icon priority: channel-failed > thread-failed-but-channel-ok > all-ok > nothing-done
          const iconState = c.error
            ? 'channel-error'
            : threadAsked && c.threadError
              ? 'thread-error'
              : c.created
                ? 'new'
                : channelOk
                  ? 'reused'
                  : 'idle';
          return (
            <li
              key={c.projectId}
              className="rounded bg-background border border-border px-2 py-1.5 text-[11px] flex items-start gap-2"
            >
              <span
                className={cn(
                  'mt-0.5',
                  iconState === 'channel-error' && 'text-destructive',
                  iconState === 'thread-error' && 'text-yellow-600 dark:text-yellow-400',
                  iconState === 'new' && 'text-green-600 dark:text-green-400',
                  (iconState === 'reused' || iconState === 'idle') && 'text-muted-foreground',
                )}
              >
                {iconState === 'channel-error'
                  ? '✗'
                  : iconState === 'thread-error'
                    ? '⚠'
                    : iconState === 'new'
                      ? '✓ new'
                      : '·'}
              </span>
              <div className="flex-1 min-w-0">
                <div className="font-medium text-foreground truncate">
                  {c.projectLabel}{' '}
                  <span className="text-muted-foreground font-normal">
                    → {c.channelName ? `#${c.channelName}` : '(no channel)'}
                    {c.threadId ? ` › ${c.threadName ?? 'thread'}` : ''}
                  </span>
                </div>
                {channelOk && (
                  <div className="text-[10px] text-muted-foreground">
                    message {c.messageId} sent
                    {c.threadCreated
                      ? ' · thread opened'
                      : threadAsked
                        ? ' · thread NOT opened'
                        : ''}
                  </div>
                )}
                {c.error && (
                  <div className="text-destructive leading-snug">{c.error}</div>
                )}
                {!c.error && c.threadError && (
                  <div className="text-yellow-700 dark:text-yellow-400 leading-snug">
                    Thread skipped — {c.threadError}
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function DiscordAdvancedSettings({
  conn,
  guildSectionRef,
  open,
  onOpenChange,
  hideTrigger = false,
}: {
  conn: MessengerConnection;
  guildSectionRef?: React.RefObject<HTMLDivElement | null>;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** When true, the parent owns the open control (e.g. connected-state button). */
  hideTrigger?: boolean;
}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const isOpen = open ?? internalOpen;
  const setOpen = onOpenChange ?? setInternalOpen;
  const { t } = useI18n();

  const updateConnection = useMessengerStore((s) => s.updateConnection);
  const saveDiscordConfig = useMessengerStore((s) => s.saveDiscordConfig);
  const resolveDiscordChannel = useMessengerStore((s) => s.resolveDiscordChannel);
  const resolveDiscordGuild = useMessengerStore((s) => s.resolveDiscordGuild);
  const diagnoseDiscord = useMessengerStore((s) => s.diagnoseDiscord);
  const discordDiagnosis = useMessengerStore((s) => s.discordDiagnosis);
  const discordDiagnosisRunning = useMessengerStore((s) => s.discordDiagnosisRunning);
  const refreshBridgeStatus = useMessengerStore((s) => s.refreshBridgeStatus);
  const bridgeStatus = useMessengerStore((s) => s.bridgeStatus);
  const startDiscordListener = useMessengerStore((s) => s.startDiscordListener);
  const stopDiscordListener = useMessengerStore((s) => s.stopDiscordListener);
  const refreshDiscordListenerStatus = useMessengerStore((s) => s.refreshDiscordListenerStatus);
  const loadRecentDiscordMessages = useMessengerStore((s) => s.loadRecentDiscordMessages);
  const discordInbound = useMessengerStore((s) => s.discordInbound);
  const discordHistory = useMessengerStore((s) => s.discordHistory);
  const loadDiscordHistory = useMessengerStore((s) => s.loadDiscordHistory);
  const projects = useProjectsStore((s) => s.projects);
  const projectMappings = useMessengerStore((s) => s.projectMappings);
  const setProjectMapping = useMessengerStore((s) => s.setProjectMapping);

  const inputClass =
    'w-full rounded-md border border-border bg-background px-3 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring';

  const meta = MESSENGER_META[conn.type];
  const target = conn.defaultChannelId;
  const hasTarget = Boolean(target);

  const [targetInput, setTargetInput] = useState('');
  const [guildInput, setGuildInput] = useState('');

  const handleSaveTarget = async () => {
    const value = targetInput.trim();
    if (!value) return;
    updateConnection('discord', { defaultChannelId: value });
    // Persist to server-side settings.json so auto-start works on reboot
    setTimeout(() => saveDiscordConfig(), 0);
    setTimeout(() => {
      resolveDiscordChannel();
    }, 0);
    setTargetInput('');
  };

  return (
    <Collapsible
      open={isOpen}
      onOpenChange={setOpen}
      className={cn(!hideTrigger && 'border-t border-border/60 pt-3')}
    >
      {!hideTrigger && (
        <label className="flex cursor-pointer select-none items-center gap-2">
          <Checkbox
            checked={isOpen}
            onChange={setOpen}
            ariaLabel={t('settings.integrations.discord.actions.advancedSettings')}
          />
          <span className="text-xs font-medium text-foreground">
            {t('settings.integrations.discord.actions.advancedSettings')}
          </span>
          <span className="text-[10px] font-normal text-muted-foreground">
            {t('settings.integrations.discord.actions.advancedSettingsHint')}
          </span>
        </label>
      )}
      <CollapsibleContent className="space-y-4 pt-3">
        {/* Server (Guild) ID — server-wide project sync */}
        <div
          ref={guildSectionRef}
          data-settings-item="integrations.discord.guild"
          className="rounded-md border border-primary/20 bg-primary/5 p-3 text-xs space-y-2"
        >
          <div className="font-medium text-foreground flex items-center gap-1.5">
            <RiDiscordLine className="size-3.5 text-[#5865F2]" />
            Server (Guild) ID
            <span className="text-[10px] font-normal text-muted-foreground">
              — for server-wide sync
            </span>
            {conn.discordGuildId && <RiCheckLine className="size-3 text-green-500" />}
          </div>
          {!conn.discordGuildId ? (
            <>
              <div className="text-[11px] text-muted-foreground leading-snug">
                Right-click the server name → <strong>Copy Server ID</strong> to sync a channel per
                project across the whole server.{' '}
                <a
                  href="https://support.discord.com/hc/en-us/articles/206346498-Where-can-I-find-my-User-Server-Message-ID"
                  target="_blank"
                  rel="noreferrer"
                  className="text-primary hover:underline"
                >
                  ID guide
                </a>
              </div>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={guildInput}
                  onChange={(e) => setGuildInput(e.target.value)}
                  placeholder="e.g. 1234567890123456789"
                  className={inputClass}
                />
                <button
                  type="button"
                  onClick={() => {
                    const v = guildInput.trim();
                    if (!v) return;
                    updateConnection('discord', { discordGuildId: v });
                    setGuildInput('');
                    setTimeout(() => saveDiscordConfig(), 0);
                    setTimeout(() => resolveDiscordGuild(), 0);
                  }}
                  disabled={!guildInput.trim()}
                  className="shrink-0 rounded bg-primary px-3 py-1.5 text-xs text-primary-foreground disabled:opacity-50"
                >
                  Save
                </button>
              </div>
              {conn.discordGuilds && conn.discordGuilds.length > 0 && (
                <div className="text-[10px] text-muted-foreground">
                  Quick pick from servers the bot is already in:
                  <div className="flex flex-wrap gap-1 mt-1">
                    {conn.discordGuilds.slice(0, 6).map((g) => (
                      <button
                        key={g.id}
                        type="button"
                        onClick={() => {
                          updateConnection('discord', { discordGuildId: g.id, guildName: g.name });
                          setTimeout(() => saveDiscordConfig(), 0);
                          setTimeout(() => resolveDiscordGuild(), 0);
                        }}
                        className="rounded-full bg-background border border-border px-2 py-0.5 text-foreground hover:border-primary/40"
                        title={g.id}
                      >
                        {g.name}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-xs flex-wrap">
                <code className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-foreground">
                  {conn.discordGuildId}
                </code>
                {conn.guildName && (
                  <span className="text-muted-foreground">{conn.guildName}</span>
                )}
                {typeof conn.discordGuildChannels !== 'undefined' && (
                  <span className="text-muted-foreground">
                    · {conn.discordGuildChannels.length} channel
                    {conn.discordGuildChannels.length === 1 ? '' : 's'}
                    {conn.discordGuildCategories && conn.discordGuildCategories.length > 0
                      ? ` · ${conn.discordGuildCategories.length} categor${conn.discordGuildCategories.length === 1 ? 'y' : 'ies'}`
                      : ''}
                    {typeof conn.discordGuildActiveThreadCount === 'number'
                      ? ` · ${conn.discordGuildActiveThreadCount} active thread${conn.discordGuildActiveThreadCount === 1 ? '' : 's'}`
                      : ''}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => resolveDiscordGuild()}
                  className="text-primary text-[10px] hover:underline"
                  title="Re-fetch server channel topology"
                >
                  Re-scan
                </button>
                <button
                  type="button"
                  onClick={() => {
                    updateConnection('discord', {
                      discordGuildId: undefined,
                      discordGuildChannels: undefined,
                      discordGuildCategories: undefined,
                      discordGuildActiveThreadCount: undefined,
                      discordParentCategoryId: undefined,
                    });
                    setTimeout(() => saveDiscordConfig(), 0);
                  }}
                  className="text-primary text-[10px] hover:underline"
                >
                  Change
                </button>
              </div>
              {conn.discordGuildCategories && conn.discordGuildCategories.length > 0 && (
                <div className="flex items-center gap-2 text-[11px]">
                  <label htmlFor={`cat-${conn.type}`} className="text-muted-foreground">
                    Parent category:
                  </label>
                  <select
                    id={`cat-${conn.type}`}
                    value={conn.discordParentCategoryId ?? ''}
                    onChange={(e) => {
                      updateConnection('discord', {
                        discordParentCategoryId: e.target.value || undefined,
                      });
                      setTimeout(() => saveDiscordConfig(), 0);
                    }}
                    className="rounded border border-border bg-background px-2 py-0.5 text-foreground text-[11px]"
                  >
                    <option value="">(none — root of server)</option>
                    {conn.discordGuildCategories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <label className="flex items-center gap-1.5 text-[11px] cursor-pointer">
                <input
                  type="checkbox"
                  checked={conn.discordCreateThreads !== false}
                  onChange={(e) =>
                    updateConnection('discord', { discordCreateThreads: e.target.checked })
                  }
                  className="rounded border-border accent-primary"
                />
                <span className="text-muted-foreground">
                  Start a thread from each project status message
                </span>
              </label>
            </div>
          )}
        </div>

        {/* Single Channel ID — the fallback "post to one channel" destination.
            Advanced because the primary flow is server-wide (Guild) sync. */}
        <div className="space-y-2">
          <div className="text-xs font-medium text-foreground flex items-center gap-2">
            {meta.targetLabel}
            {hasTarget && <RiCheckLine className="size-3 text-green-500" />}
          </div>
          {!hasTarget ? (
            <>
              <div className="text-[11px] text-muted-foreground leading-snug">
                {meta.targetHelp}
              </div>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={targetInput}
                  onChange={(e) => setTargetInput(e.target.value)}
                  placeholder={meta.targetPlaceholder}
                  className={inputClass}
                />
                <button
                  type="button"
                  onClick={handleSaveTarget}
                  disabled={!targetInput.trim()}
                  className="shrink-0 rounded bg-primary px-3 py-1.5 text-xs text-primary-foreground disabled:opacity-50"
                >
                  Save
                </button>
              </div>
            </>
          ) : (
            <div className="flex items-center gap-2 text-xs flex-wrap">
              <code className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-foreground">
                {target}
              </code>
              {conn.discordChannelName && (
                <span className="text-muted-foreground">
                  #{conn.discordChannelName}
                  {conn.guildName ? ` · ${conn.guildName}` : ''}
                  {conn.discordChannelTypeLabel ? ` · ${conn.discordChannelTypeLabel}` : ''}
                </span>
              )}
              {conn.botToken && conn.defaultChannelId && !conn.discordChannelName && (
                <button
                  type="button"
                  onClick={() => resolveDiscordChannel()}
                  className="text-primary text-[10px] hover:underline"
                  title="Look up channel info via Discord API"
                >
                  Look up
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  updateConnection('discord', {
                    defaultChannelId: undefined,
                    discordChannelName: undefined,
                    discordChannelType: undefined,
                    discordChannelTypeLabel: undefined,
                  });
                  // Persist to server-side settings.json so auto-start works on reboot
                  setTimeout(() => saveDiscordConfig(), 0);
                }}
                className="text-primary text-[10px] hover:underline"
              >
                Change
              </button>
            </div>
          )}
        </div>

        {/* Optional: Discord owner user ID — auto-joins web-created threads so
            they appear under the channel for you (a bot-only thread stays hidden). */}
        <div className="space-y-2">
          <div className="text-xs font-medium text-foreground">Your Discord user ID (optional)</div>
          <div className="text-[11px] text-muted-foreground leading-snug">
            Auto-joins web-created threads so they show up for you. Right-click your name → Copy User ID.
          </div>
          <input
            type="text"
            value={conn.defaultUserId ?? ''}
            onChange={(e) => updateConnection('discord', { defaultUserId: e.target.value.trim() })}
            onBlur={() => setTimeout(() => saveDiscordConfig(), 0)}
            placeholder="e.g. 123456789012345678"
            className={inputClass}
          />
        </div>

        <div data-settings-item="integrations.discord.trusted-bots" className="space-y-2">
          <div className="text-xs font-medium text-foreground">
            {t('settings.integrations.discord.trustedBots.title')}
          </div>
          <div className="text-[11px] text-muted-foreground leading-snug">
            {t('settings.integrations.discord.trustedBots.description')}
          </div>
          <textarea
            value={(conn.trustedBotIds ?? []).join('\n')}
            onChange={(e) => {
              const trustedBotIds = e.target.value
                .split(/[\s,]+/)
                .map((id) => id.trim())
                .filter(Boolean);
              updateConnection('discord', { trustedBotIds });
            }}
            onBlur={() => setTimeout(() => saveDiscordConfig(), 0)}
            placeholder={t('settings.integrations.discord.trustedBots.placeholder')}
            className={cn(inputClass, 'min-h-16 resize-y')}
          />
        </div>

        <div data-settings-item="integrations.discord.dynamic-slash" className="space-y-1.5">
          <label className="flex cursor-pointer items-start gap-2 py-1">
            <Checkbox
              checked={Boolean(conn.registerDynamicSlashCommands)}
              onChange={(checked) => {
                updateConnection('discord', { registerDynamicSlashCommands: Boolean(checked) });
                setTimeout(() => saveDiscordConfig(), 0);
              }}
              ariaLabel={t('settings.integrations.discord.dynamicSlash.title')}
            />
            <span className="min-w-0">
              <span className="block text-xs font-medium text-foreground">
                {t('settings.integrations.discord.dynamicSlash.title')}
              </span>
              <span className="block text-[11px] text-muted-foreground leading-snug">
                {t('settings.integrations.discord.dynamicSlash.description')}
              </span>
            </span>
          </label>
        </div>

        {/* OpenCode bridge — when on, the listeners route inbound messages
            through OpenCode and stream the response back. This is what turns
            the messenger into a real OpenChamber chat surface, instead of the
            legacy "OpenChamber agent received: ..." ping echo. */}
        {(hasTarget || conn.discordGuildId) && (
          <BridgePanel
            conn={conn}
            type={conn.type}
            bridgeStatus={bridgeStatus}
            refreshBridgeStatus={refreshBridgeStatus}
            onToggle={(v) => {
              updateConnection(conn.type, { bridgeEnabled: v });
              // Persist to server-side settings.json when toggling the bridge
              setTimeout(() => saveDiscordConfig(), 0);
            }}
          />
        )}

        {/* Discord Gateway listener + history */}
        {(conn.discordGuildId || conn.defaultChannelId) && (
          <DiscordListenerPanel
            conn={conn}
            inbound={discordInbound}
            history={discordHistory}
            startListener={startDiscordListener}
            stopListener={stopDiscordListener}
            refreshStatus={refreshDiscordListenerStatus}
            loadRecent={loadRecentDiscordMessages}
            loadHistory={loadDiscordHistory}
            onToggleAutoReply={(v) =>
              updateConnection('discord', { discordListenerAutoReply: v })
            }
          />
        )}

        {/* Discord diagnose */}
        <DiscordDiagnosePanel
          conn={conn}
          diagnosis={discordDiagnosis}
          running={discordDiagnosisRunning}
          runDiagnose={diagnoseDiscord}
        />

        {conn.lastSyncChannels && conn.lastSyncChannels.length > 0 && (
          <DiscordSyncResults channels={conn.lastSyncChannels} guildName={conn.guildName} />
        )}

        {/* Project ↔ Channel mappings */}
        {conn.syncProjects && projects.length > 0 && (
          <details className="group">
            <summary className="cursor-pointer text-xs font-medium text-foreground select-none">
              Project → Channel Mapping{' '}
              <span className="text-[10px] text-muted-foreground font-normal">(optional)</span>
            </summary>
            <div className="mt-2 space-y-2">
              {projects.slice(0, 10).map((project) => {
                const mapping = projectMappings.find((m) => m.projectId === project.id);
                const channelName = mapping?.discord?.channelName;
                return (
                  <div key={project.id} className="flex items-center gap-2 text-xs">
                    <span className="text-foreground min-w-0 truncate flex-1">
                      {project.label || project.path.split('/').pop()}
                    </span>
                    <span className="text-muted-foreground">→</span>
                    <input
                      type="text"
                      value={channelName ?? ''}
                      onChange={(e) => {
                        const name = e.target.value;
                        const update = {
                          projectId: project.id,
                          projectLabel:
                            project.label || project.path.split('/').pop() || project.path,
                          discord: { channelId: project.id, channelName: name },
                        };
                        setProjectMapping(update);
                      }}
                      placeholder={`#${(project.label || project.path.split('/').pop() || '')
                        .toLowerCase()
                        .replace(/\s+/g, '-')}`}
                      className="w-32 rounded border border-border bg-background px-2 py-0.5 text-xs text-foreground"
                    />
                  </div>
                );
              })}
            </div>
          </details>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

type DiscordReplyMode = 'always' | 'mention' | 'inherit';

const DISCORD_DEFAULT_REPLY_MODES = ['always', 'mention'] as const;
const DISCORD_GUILD_REPLY_MODES = ['always', 'mention', 'inherit'] as const;

function DiscordServersAndInviteBlock({ conn }: { conn: MessengerConnection }) {
  const { t } = useI18n();
  const fetchDiscordInviteUrl = useMessengerStore((s) => s.fetchDiscordInviteUrl);
  const setDiscordGuildPolicy = useMessengerStore((s) => s.setDiscordGuildPolicy);
  const setDiscordDefaultReplyMode = useMessengerStore((s) => s.setDiscordDefaultReplyMode);

  const guildCount = conn.discordGuilds?.length ?? 0;
  const hasGuilds = guildCount > 0;
  const defaultReplyMode = conn.discordDefaultReplyMode ?? 'always';

  const replyModeLabelKey = (mode: DiscordReplyMode): I18nKey => {
    if (mode === 'always') return 'settings.integrations.discord.servers.replyMode.always';
    if (mode === 'mention') return 'settings.integrations.discord.servers.replyMode.mention';
    return 'settings.integrations.discord.servers.replyMode.inherit';
  };

  return (
    <div
      data-settings-item="integrations.discord.servers"
      className="space-y-3 rounded-md border border-border/60 bg-muted/20 p-3"
    >
      <div>
        <div className="text-xs font-medium text-foreground">
          {t('settings.integrations.discord.servers.title')}
        </div>
        <p className="mt-1 text-[11px] text-muted-foreground leading-snug">
          {t('settings.integrations.discord.servers.description')}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {conn.discordInviteUrl ? (
          <Button
            type="button"
            variant="outline"
            size="xs"
            className="!font-normal"
            onClick={() =>
              window.open(conn.discordInviteUrl!, '_blank', 'noopener,noreferrer')
            }
          >
            <Icon name="external-link" className="size-3.5" />
            {t('settings.integrations.discord.servers.inviteButton')}
          </Button>
        ) : (
          <Button
            type="button"
            variant="default"
            size="xs"
            className="!font-normal"
            onClick={() => void fetchDiscordInviteUrl()}
          >
            {t('settings.integrations.discord.servers.generateInvite')}
          </Button>
        )}
      </div>

      <div className="text-[11px] text-muted-foreground">
        {hasGuilds
          ? t('settings.integrations.discord.wizard.step2.botInServers', { count: guildCount })
          : t('settings.integrations.discord.wizard.step2.botNotInServers')}
      </div>

      <p className="text-[10px] text-muted-foreground leading-snug">
        {t('settings.integrations.discord.servers.inviteHint')}
      </p>

      {hasGuilds && (
        <>
          <div className="space-y-1.5 border-t border-border/60 pt-2">
            <div className="text-[11px] font-medium text-foreground">
              {t('settings.integrations.discord.servers.defaultReplyMode.label')}
            </div>
            <p className="text-[10px] text-muted-foreground leading-snug">
              {t('settings.integrations.discord.servers.defaultReplyMode.hint')}
            </p>
            <div className="mt-1 flex flex-wrap items-center gap-1">
              {DISCORD_DEFAULT_REPLY_MODES.map((mode) => (
                <Button
                  key={mode}
                  type="button"
                  variant="outline"
                  size="xs"
                  className={cn(
                    '!font-normal',
                    defaultReplyMode === mode
                      ? 'border-[var(--primary-base)] text-[var(--primary-base)] bg-[var(--primary-base)]/10'
                      : 'text-foreground',
                  )}
                  onClick={() => setDiscordDefaultReplyMode(mode)}
                >
                  {t(replyModeLabelKey(mode))}
                </Button>
              ))}
            </div>
          </div>

          <div className="space-y-2 border-t border-border/60 pt-2">
            {(conn.discordGuilds ?? []).map((g) => {
              const policy = conn.discordGuildPolicies?.[g.id];
              const enabled = policy?.enabled !== false;
              const replyMode = policy?.replyMode ?? 'inherit';
              return (
                <div
                  key={g.id}
                  className="space-y-1.5 rounded-md border border-border/40 px-2 py-1.5"
                >
                  <div className="truncate text-[11px] font-medium text-foreground">{g.name}</div>
                  <label className="flex cursor-pointer items-center gap-2 py-0.5">
                    <Checkbox
                      checked={enabled}
                      onChange={(checked) => setDiscordGuildPolicy(g.id, { enabled: checked })}
                      ariaLabel={t('settings.integrations.discord.servers.enabled.label')}
                    />
                    <span className="text-[11px] text-foreground">
                      {t('settings.integrations.discord.servers.enabled.label')}
                    </span>
                  </label>
                  <div className="flex flex-wrap items-center gap-1">
                    {DISCORD_GUILD_REPLY_MODES.map((mode) => (
                      <Button
                        key={mode}
                        type="button"
                        variant="outline"
                        size="xs"
                        disabled={!enabled}
                        className={cn(
                          '!font-normal',
                          replyMode === mode
                            ? 'border-[var(--primary-base)] text-[var(--primary-base)] bg-[var(--primary-base)]/10'
                            : 'text-foreground',
                        )}
                        onClick={() => setDiscordGuildPolicy(g.id, { replyMode: mode })}
                      >
                        {t(replyModeLabelKey(mode))}
                      </Button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>

          <p className="text-[10px] text-muted-foreground leading-snug">
            {t('settings.integrations.discord.servers.mentionHint')}
          </p>
        </>
      )}
    </div>
  );
}

function ConnectionCard({ conn }: { conn: MessengerConnection }) {
  const { t } = useI18n();
  const onboardingStep = useMessengerStore((s) => s.onboardingStep);
  const onboardingType = useMessengerStore((s) => s.onboardingType);
  const showWizard = onboardingStep !== null && onboardingType === 'discord';

  const updateConnection = useMessengerStore((s) => s.updateConnection);
  const testConnection = useMessengerStore((s) => s.testConnection);
  const disconnectDiscord = useMessengerStore((s) => s.disconnectDiscord);
  const startDiscordListener = useMessengerStore((s) => s.startDiscordListener);
  const stopDiscordListener = useMessengerStore((s) => s.stopDiscordListener);
  const syncDiscordGuildProjects = useMessengerStore((s) => s.syncDiscordGuildProjects);
  const sendTestMessage = useMessengerStore((s) => s.sendTestMessage);
  const sendSyncSummary = useMessengerStore((s) => s.sendSyncSummary);
  const saveDiscordConfig = useMessengerStore((s) => s.saveDiscordConfig);
  const projects = useProjectsStore((s) => s.projects);
  const [disconnecting, setDisconnecting] = useState(false);

  const tokenSectionRef = useRef<HTMLDivElement>(null);
  const guildSectionRef = useRef<HTMLDivElement>(null);
  const testSectionRef = useRef<HTMLDivElement>(null);
  const advancedSectionRef = useRef<HTMLDivElement>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const scrollToSection = (section: 'token' | 'guild' | 'channel' | 'test' | 'advanced') => {
    const needsAdvanced = section === 'guild' || section === 'channel' || section === 'advanced';
    if (needsAdvanced) {
      setAdvancedOpen(true);
    }
    if (section === 'token') {
      setShowToken(true);
    }
    const ref =
      section === 'token'
        ? tokenSectionRef
        : section === 'test'
          ? testSectionRef
          : needsAdvanced
            ? guildSectionRef
            : advancedSectionRef;
    window.requestAnimationFrame(() => {
      ref.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  };

  const meta = MESSENGER_META[conn.type];
  const Icon = meta.icon;
  const displayStatus = deriveDiscordDisplayStatus(conn);

  const [showToken, setShowToken] = useState(false);
  const [tokenInput, setTokenInput] = useState('');
  const [showTokenPlain, setShowTokenPlain] = useState(false);
  const [disconnectConfirmOpen, setDisconnectConfirmOpen] = useState(false);

  const token = conn.botToken;
  const target = conn.defaultChannelId;

  const hasToken = Boolean(token);
  const hasTarget = Boolean(target);
  const isConnectedView = displayStatus === 'connected';

  // Reconcile badge + listener with the live server when this card opens.
  // Depends on botToken so we still run after Zustand persist hydration.
  useEffect(() => {
    void useMessengerStore.getState().resyncDiscordStatus();
  }, [conn.botToken]);

  const handleSaveToken = () => {
    if (!tokenInput.trim()) return;
    updateConnection('discord', { botToken: tokenInput.trim(), enabled: true });
    // Persist to server-side settings.json so auto-start works on reboot
    setTimeout(() => saveDiscordConfig(), 0);
    setTokenInput('');
    setShowToken(false);
    setShowTokenPlain(false);
  };

  const inputClass =
    'w-full rounded-md border border-border bg-background px-3 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring';

  const buildProjectPayloads = (): { id: string; path: string; label: string; body: string }[] => {
    const now = new Date().toLocaleString();
    return projects.map((p) => {
      const label = p.label || p.path.split('/').pop() || p.path;
      const lines = [`🤖 OpenChamber agent sync — ${label}`, '', `Last synced ${now}`];
      return { id: p.id, path: p.path, label, body: lines.join('\n') };
    });
  };

  const buildSummary = (): string => {
    const lines = [
      '**🤖 OpenChamber agent sync summary**',
      '',
      `• Projects: ${projects.length}`,
      '',
      `_Sent ${new Date().toLocaleString()}_`,
    ];
    return lines.join('\n');
  };

  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Icon className={cn('size-5', meta.color)} />
          <span className="text-sm font-medium text-foreground">{meta.name}</span>
          <StatusBadge status={displayStatus} />
          {conn.discordBotUsername && (
            <span className="text-[10px] text-muted-foreground">
              {conn.discordBotUsername}
              {conn.discordBotDiscriminator && conn.discordBotDiscriminator !== '0'
                ? `#${conn.discordBotDiscriminator}`
                : ''}
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div data-settings-item="integrations.discord.commands">
            <DiscordCommandsButton />
          </div>
          {/* Setup-only header actions. When connected, Disconnect lives with
              Change token / Advanced below so it stays visible. */}
          {hasToken && !isConnectedView && (
            <>
              <Button
                type="button"
                variant="outline"
                size="xs"
                className="!font-normal"
                onClick={() => testConnection(conn.type)}
                disabled={!token || conn.status === 'connecting'}
              >
                {conn.status === 'connecting'
                  ? t('settings.integrations.discord.wizard.step1.verifying')
                  : t('settings.integrations.discord.wizard.step1.verify')}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="xs"
                className="!font-normal text-[var(--status-error)] hover:text-[var(--status-error)]"
                onClick={() => setDisconnectConfirmOpen(true)}
              >
                {t('settings.integrations.discord.disconnect.button')}
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Connection error */}
      {conn.error && (
        <div className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive flex items-start gap-2">
          <RiAlertLine className="size-3.5 shrink-0 mt-0.5" />
          <span>{conn.error}</span>
        </div>
      )}

      {/* Onboarding wizard — shown during first-time setup */}
      {showWizard && (
        <DiscordOnboardingWizard conn={conn} onScrollToSection={scrollToSection} />
      )}

      {isConnectedView ? (
        <>
          {/* Connected: change token, advanced, and disconnect — always visible. */}
          <div ref={tokenSectionRef} className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="!font-normal"
              onClick={() => setShowToken((v) => !v)}
            >
              {showToken
                ? t('settings.common.actions.cancel')
                : t('settings.integrations.discord.actions.changeToken')}
            </Button>
            <Button
              type="button"
              variant={advancedOpen ? 'secondary' : 'outline'}
              size="xs"
              className="!font-normal"
              onClick={() => setAdvancedOpen((open) => !open)}
            >
              {t('settings.integrations.discord.actions.advancedSettings')}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="!font-normal text-[var(--status-error)] hover:text-[var(--status-error)]"
              onClick={() => setDisconnectConfirmOpen(true)}
            >
              {t('settings.integrations.discord.disconnect.button')}
            </Button>
          </div>

          <DiscordServersAndInviteBlock conn={conn} />

          {/* Default connected controls: start/stop listening (sticky stop). */}
          <div className="flex flex-wrap items-center gap-2">
            {conn.discordListenerRunning ? (
              <Button
                type="button"
                variant="outline"
                size="xs"
                className="!font-normal text-[var(--status-error)] hover:text-[var(--status-error)]"
                onClick={() => void stopDiscordListener()}
              >
                <RiStopCircleLine className="size-3.5" />
                {t('settings.integrations.discord.listener.stop')}
              </Button>
            ) : (
              <Button
                type="button"
                variant="default"
                size="xs"
                className="!font-normal"
                onClick={() => void startDiscordListener()}
              >
                <RiPlayCircleLine className="size-3.5" />
                {t('settings.integrations.discord.listener.start')}
              </Button>
            )}
            <span className="typography-meta text-muted-foreground">
              {conn.discordListenerConnected
                ? t('settings.integrations.discord.listener.status.live')
                : conn.discordListenerRunning
                  ? t('settings.integrations.discord.listener.status.connecting')
                  : t('settings.integrations.discord.listener.status.off')}
            </span>
          </div>

          {showToken && (
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <input
                type="password"
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                placeholder={t('settings.integrations.discord.wizard.step1.tokenLabel')}
                className={cn(inputClass, 'min-w-[12rem] flex-1')}
              />
              <Button
                type="button"
                variant="default"
                size="xs"
                className="!font-normal shrink-0"
                onClick={handleSaveToken}
                disabled={!tokenInput.trim()}
              >
                {t('settings.integrations.discord.actions.updateToken')}
              </Button>
            </div>
          )}

          {(hasTarget || conn.discordGuildId) && (
            <div
              ref={testSectionRef}
              className="space-y-2 rounded-md border border-border/60 bg-muted/30 p-3"
            >
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="default"
                  size="xs"
                  className="!font-normal"
                  onClick={() => sendTestMessage(conn.type)}
                  disabled={conn.lastSyncStatus === 'sending'}
                >
                  {conn.lastSyncStatus === 'sending' ? (
                    <RiLoader4Line className="size-3.5 animate-spin" />
                  ) : (
                    <RiSendPlaneLine className="size-3.5" />
                  )}
                  {t('settings.integrations.discord.wizard.step3.sendTest')}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  className="!font-normal"
                  onClick={() => {
                    if (conn.discordGuildId) {
                      syncDiscordGuildProjects(buildProjectPayloads(), buildSummary());
                    } else {
                      sendSyncSummary(conn.type, buildSummary());
                    }
                  }}
                  disabled={conn.lastSyncStatus === 'sending'}
                >
                  {conn.lastSyncStatus === 'sending' ? (
                    <RiLoader4Line className="size-3.5 animate-spin" />
                  ) : (
                    <RiRefreshLine className="size-3.5" />
                  )}
                  {t('settings.integrations.discord.wizard.step3.syncNow')}
                </Button>
                <div className="ml-auto text-[10px] text-muted-foreground">
                  {t('settings.integrations.discord.actions.lastActivity', {
                    when: formatRelative(conn.lastSyncAt),
                  })}
                </div>
              </div>
              {conn.lastSyncMessage && (
                <div
                  className={cn(
                    'text-[11px] leading-snug',
                    conn.lastSyncStatus === 'error' && 'text-destructive',
                    conn.lastSyncStatus === 'ok' && 'text-[var(--status-success)]',
                    conn.lastSyncStatus === 'sending' && 'text-muted-foreground',
                  )}
                >
                  {conn.lastSyncMessage}
                </div>
              )}
            </div>
          )}

          {advancedOpen && (
            <div ref={advancedSectionRef}>
              <DiscordAdvancedSettings
                conn={conn}
                guildSectionRef={guildSectionRef}
                open={advancedOpen}
                onOpenChange={setAdvancedOpen}
                hideTrigger
              />
            </div>
          )}
        </>
      ) : (
        <>
          {/* Setup: token field + instructions until the bot is connected. */}
          {!token ? (
            <div ref={tokenSectionRef} className="space-y-2">
              <div className="text-xs font-medium text-foreground">{meta.tokenLabel}</div>
              <div className="text-[11px] text-muted-foreground leading-snug">{meta.tokenHelp}</div>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <input
                    type={showTokenPlain ? 'text' : 'password'}
                    value={tokenInput}
                    onChange={(e) => setTokenInput(e.target.value)}
                    placeholder={meta.tokenLabel}
                    className={cn(inputClass, 'pr-8')}
                  />
                  <button
                    type="button"
                    onClick={() => setShowTokenPlain((v) => !v)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    title={showTokenPlain ? 'Hide' : 'Show'}
                  >
                    {showTokenPlain ? (
                      <RiEyeOffLine className="size-3.5" />
                    ) : (
                      <RiEyeLine className="size-3.5" />
                    )}
                  </button>
                </div>
                <Button
                  type="button"
                  variant="default"
                  size="xs"
                  className="!font-normal shrink-0"
                  onClick={handleSaveToken}
                  disabled={!tokenInput.trim()}
                >
                  {t('settings.integrations.discord.actions.saveToken')}
                </Button>
              </div>
            </div>
          ) : (
            <div ref={tokenSectionRef} className="flex flex-wrap items-center gap-2 text-xs">
              <RiCheckLine className="size-3 text-[var(--status-success)]" />
              <span className="text-muted-foreground">
                {t('settings.integrations.discord.actions.tokenConfigured')}
              </span>
              <Button
                type="button"
                variant="outline"
                size="xs"
                className="!font-normal"
                onClick={() => setShowToken(!showToken)}
              >
                {showToken
                  ? t('settings.common.actions.cancel')
                  : t('settings.integrations.discord.actions.changeToken')}
              </Button>
              {showToken && (
                <div className="flex min-w-0 flex-1 gap-2">
                  <input
                    type="password"
                    value={tokenInput}
                    onChange={(e) => setTokenInput(e.target.value)}
                    placeholder={t('settings.integrations.discord.wizard.step1.tokenLabel')}
                    className={inputClass}
                  />
                  <Button
                    type="button"
                    variant="default"
                    size="xs"
                    className="!font-normal shrink-0"
                    onClick={handleSaveToken}
                    disabled={!tokenInput.trim()}
                  >
                    {t('settings.integrations.discord.actions.updateToken')}
                  </Button>
                </div>
              )}
            </div>
          )}

          {hasToken && (hasTarget || conn.discordGuildId) && (
            <div
              ref={testSectionRef}
              className="space-y-2 rounded-md border border-border/60 bg-muted/30 p-3"
            >
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="default"
                  size="xs"
                  className="!font-normal"
                  onClick={() => sendTestMessage(conn.type)}
                  disabled={conn.lastSyncStatus === 'sending'}
                >
                  {conn.lastSyncStatus === 'sending' ? (
                    <RiLoader4Line className="size-3.5 animate-spin" />
                  ) : (
                    <RiSendPlaneLine className="size-3.5" />
                  )}
                  {t('settings.integrations.discord.wizard.step3.sendTest')}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  className="!font-normal"
                  onClick={() => {
                    if (conn.discordGuildId) {
                      syncDiscordGuildProjects(buildProjectPayloads(), buildSummary());
                    } else {
                      sendSyncSummary(conn.type, buildSummary());
                    }
                  }}
                  disabled={conn.lastSyncStatus === 'sending'}
                >
                  {conn.lastSyncStatus === 'sending' ? (
                    <RiLoader4Line className="size-3.5 animate-spin" />
                  ) : (
                    <RiRefreshLine className="size-3.5" />
                  )}
                  {t('settings.integrations.discord.wizard.step3.syncNow')}
                </Button>
                <div className="ml-auto text-[10px] text-muted-foreground">
                  {t('settings.integrations.discord.actions.lastActivity', {
                    when: formatRelative(conn.lastSyncAt),
                  })}
                </div>
              </div>
              {conn.lastSyncMessage && (
                <div
                  className={cn(
                    'text-[11px] leading-snug',
                    conn.lastSyncStatus === 'error' && 'text-destructive',
                    conn.lastSyncStatus === 'ok' && 'text-[var(--status-success)]',
                    conn.lastSyncStatus === 'sending' && 'text-muted-foreground',
                  )}
                >
                  {conn.lastSyncMessage}
                </div>
              )}
            </div>
          )}

          {hasToken && (
            <div ref={advancedSectionRef}>
              <DiscordAdvancedSettings
                conn={conn}
                guildSectionRef={guildSectionRef}
                open={advancedOpen}
                onOpenChange={setAdvancedOpen}
              />
            </div>
          )}
        </>
      )}

      <Dialog open={disconnectConfirmOpen} onOpenChange={setDisconnectConfirmOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('settings.integrations.discord.disconnect.dialog.title')}</DialogTitle>
            <DialogDescription>
              {t('settings.integrations.discord.disconnect.dialog.description')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setDisconnectConfirmOpen(false)}
            >
              {t('settings.common.actions.cancel')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={disconnecting}
              onClick={() => {
                setDisconnecting(true);
                void disconnectDiscord().finally(() => {
                  setDisconnecting(false);
                  setDisconnectConfirmOpen(false);
                });
              }}
            >
              {t('settings.integrations.discord.disconnect.dialog.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export const MessengerSection: React.FC = () => {
  const connections = useMessengerStore((s) => s.connections);
  const startOnboarding = useMessengerStore((s) => s.startOnboarding);

  const availableTypes: MessengerType[] = useMemo(
    () =>
      (['discord'] as const).filter(
        (type) => !connections.some((c) => c.type === type),
      ),
    [connections],
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium text-foreground">Messenger Sync</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Chat with your assistant from Discord and mirror project updates into your server.
          </p>
        </div>
      </div>

      {connections.map((conn) => (
        <ConnectionCard key={conn.type} conn={conn} />
      ))}

      {availableTypes.length > 0 && (
        <div className="flex gap-2">
          {availableTypes.map((type) => {
            const meta = MESSENGER_META[type];
            const Icon = meta.icon;
            return (
              <button
                key={type}
                type="button"
                onClick={() => startOnboarding(type)}
                className="flex items-center gap-2 rounded-lg border border-dashed border-border px-4 py-3 text-sm text-muted-foreground hover:border-primary/30 hover:text-foreground transition-colors"
              >
                <RiAddLine className="size-4" />
                <Icon className={cn('size-4', meta.color)} />
                Connect {meta.name}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};
