import React, { useEffect, useRef, useState } from 'react';
import {
  RiDiscordLine,
  RiCheckLine,
  RiLoader4Line,
  RiAddLine,
  RiSendPlaneLine,
  RiRefreshLine,
  RiAlertLine,
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
  deriveDiscordViewState,
  isDiscordGuildSyncing,
  useMessengerStore,
  type MessengerType,
  type MessengerConnection,
  type MessengerVerbosity,
  type MessengerPermissionMode,
  type MessengerDiagnosisCheck,
  type MessengerInboundMessage,
} from '@/stores/useMessengerStore';
import { useDiscordGuildMembershipPoll } from './useDiscordGuildMembershipPoll';
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
  targetLabel: string;
  targetPlaceholder: string;
  targetHelp: React.ReactNode;
}

const MESSENGER_META: Record<MessengerType, MessengerMeta> = {
  discord: {
    name: 'Discord',
    icon: RiDiscordLine,
    color: 'text-[#5865F2]',
    targetLabel: 'Channel ID',
    targetPlaceholder: 'e.g. 1234567890123456789',
    targetHelp: (
      <>
        Enable Developer Mode, then right-click a text channel → <strong>Copy Channel ID</strong>.
      </>
    ),
  },
};

const VERBOSITY_OPTIONS: {
  id: MessengerVerbosity;
  labelKey: I18nKey;
  descKey: I18nKey;
}[] = [
  {
    id: 'quiet',
    labelKey: 'settings.integrations.discord.bridge.verbosity.quiet.label',
    descKey: 'settings.integrations.discord.bridge.verbosity.quiet.desc',
  },
  {
    id: 'normal',
    labelKey: 'settings.integrations.discord.bridge.verbosity.normal.label',
    descKey: 'settings.integrations.discord.bridge.verbosity.normal.desc',
  },
  {
    id: 'verbose',
    labelKey: 'settings.integrations.discord.bridge.verbosity.verbose.label',
    descKey: 'settings.integrations.discord.bridge.verbosity.verbose.desc',
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
    id: 'yolo',
    labelKey: 'settings.integrations.discord.bridge.permissionMode.yolo.label',
    descKey: 'settings.integrations.discord.bridge.permissionMode.yolo.desc',
  },
  {
    id: 'agent',
    labelKey: 'settings.integrations.discord.bridge.permissionMode.agent.label',
    descKey: 'settings.integrations.discord.bridge.permissionMode.agent.desc',
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
}: {
  conn: MessengerConnection;
  inbound: MessengerInboundMessage[];
  history: ReturnType<typeof useMessengerStore.getState>['discordHistory'];
  startListener: () => Promise<boolean>;
  stopListener: () => Promise<boolean>;
  refreshStatus: () => Promise<void>;
  loadRecent: () => Promise<void>;
  loadHistory: (channelId: string, limit?: number) => Promise<boolean>;
}) {
  const { t } = useI18n();
  const running = Boolean(conn.discordListenerRunning);
  const connected = Boolean(conn.discordListenerConnected);
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
  const currentVerbosityOption =
    VERBOSITY_OPTIONS.find((o) => o.id === currentVerbosity) ?? VERBOSITY_OPTIONS[0];
  const currentPermissionMode: MessengerPermissionMode = bridgePermissionMode[type] ?? 'agent';
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
        <div className="text-[11px] font-medium text-foreground">
          {t('settings.integrations.discord.bridge.verbosity.title')}
        </div>
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
              title={t(opt.descKey)}
            >
              {t(opt.labelKey)}
            </button>
          ))}
        </div>
        <div className="text-[10px] text-muted-foreground leading-snug">
          {t(currentVerbosityOption.descKey)}
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
}: {
  channels: NonNullable<MessengerConnection['lastSyncChannels']>;
}) {
  // Group per-project rows by the server they were synced to (multi-server).
  const groups = new Map<string, { name: string | null; rows: typeof channels }>();
  for (const c of channels) {
    const key = c.guildId ?? '';
    const group = groups.get(key);
    if (group) {
      group.rows.push(c);
    } else {
      groups.set(key, { name: c.guildName ?? null, rows: [c] });
    }
  }
  return (
    <div className="rounded-md border border-border/60 bg-muted/30 p-3 space-y-2">
      <div className="text-xs font-medium text-foreground flex items-center gap-1.5">
        <RiCheckLine className="size-3.5 text-primary" />
        Last sync result
      </div>
      {Array.from(groups.entries()).map(([groupKey, group]) => (
        <div key={groupKey || 'default'} className="space-y-1">
          {group.name && (
            <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              {group.name}
            </div>
          )}
          <ul className="space-y-1">
            {group.rows.map((c) => {
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
                  key={`${c.guildId ?? ''}:${c.projectId}`}
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
                    {c.error && <div className="text-destructive leading-snug">{c.error}</div>}
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
      ))}
    </div>
  );
}

function DiscordAdvancedSettings({
  conn,
  open,
  onOpenChange,
  hideTrigger = false,
}: {
  conn: MessengerConnection;
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

  const inputClass =
    'w-full rounded-md border border-border bg-background px-3 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring';

  const meta = MESSENGER_META[conn.type];
  const target = conn.defaultChannelId;
  const hasTarget = Boolean(target);

  const [targetInput, setTargetInput] = useState('');

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
        <p className="typography-meta text-muted-foreground/70 px-0.5">
          {t('settings.integrations.discord.advanced.serversNote')}
        </p>

        {/* Fallback single Channel ID — optional destination for test messages,
            approvals and history when no project-sync server is configured. */}
        <div
          data-settings-item="integrations.discord.fallback-channel"
          className="space-y-2"
        >
          <div className="text-xs font-medium text-foreground flex items-center gap-2">
            {t('settings.integrations.discord.advanced.fallbackChannel.title')}
            {hasTarget && <RiCheckLine className="size-3 text-[var(--status-success)]" />}
          </div>
          <div className="text-[11px] text-muted-foreground leading-snug">
            {t('settings.integrations.discord.advanced.fallbackChannel.description')}
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
                <Button
                  type="button"
                  variant="default"
                  size="xs"
                  className="!font-normal shrink-0"
                  onClick={handleSaveTarget}
                  disabled={!targetInput.trim()}
                >
                  {t('settings.integrations.discord.actions.saveToken')}
                </Button>
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
                  title={t('settings.integrations.discord.advanced.fallbackChannel.lookUp')}
                >
                  {t('settings.integrations.discord.advanced.fallbackChannel.lookUp')}
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
                {t('settings.integrations.discord.advanced.primarySyncGuild.change')}
              </button>
            </div>
          )}
        </div>

        {/* Optional: Discord owner user ID — auto-joins web-created threads so
            they appear under the channel for you (a bot-only thread stays hidden). */}
        <div className="space-y-2">
          <div className="text-xs font-medium text-foreground">
            {t('settings.integrations.discord.advanced.ownerUserId.title')}
          </div>
          <div className="text-[11px] text-muted-foreground leading-snug">
            {t('settings.integrations.discord.advanced.ownerUserId.description')}
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

        {/* OpenCode bridge — routes inbound messages through OpenCode and streams
            the response back. Global (per bot token). */}
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

        {/* Discord Gateway listener diagnostics + channel history */}
        <DiscordListenerPanel
          conn={conn}
          inbound={discordInbound}
          history={discordHistory}
          startListener={startDiscordListener}
          stopListener={stopDiscordListener}
          refreshStatus={refreshDiscordListenerStatus}
          loadRecent={loadRecentDiscordMessages}
          loadHistory={loadDiscordHistory}
        />

        {/* Discord diagnose */}
        <DiscordDiagnosePanel
          conn={conn}
          diagnosis={discordDiagnosis}
          running={discordDiagnosisRunning}
          runDiagnose={diagnoseDiscord}
        />

        {conn.lastSyncChannels && conn.lastSyncChannels.length > 0 && (
          <DiscordSyncResults channels={conn.lastSyncChannels} />
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

type DiscordReplyMode = 'always' | 'mention' | 'inherit';

const DISCORD_DEFAULT_REPLY_MODES = ['always', 'mention'] as const;
const DISCORD_GUILD_REPLY_MODES = ['always', 'mention', 'inherit'] as const;

function discordReplyModeLabelKey(mode: DiscordReplyMode): I18nKey {
  if (mode === 'always') return 'settings.integrations.discord.servers.replyMode.always';
  if (mode === 'mention') return 'settings.integrations.discord.servers.replyMode.mention';
  return 'settings.integrations.discord.servers.replyMode.inherit';
}

/**
 * One server the bot is in. This is the central per-server control: whether the
 * bot responds here (which also governs listening + OpenCode sync for this
 * server), how it replies, and whether it mirrors projects into this server.
 */
type DiscordSyncProject = { id: string; path: string; label?: string };

/**
 * Per-project Discord sync payloads (the message body posted into each
 * project's channel). Shared by the card-level "Sync projects now" and the
 * per-server "Sync now" action so both produce identical content.
 */
function buildProjectSyncPayloads(
  projects: DiscordSyncProject[],
): { id: string; path: string; label: string; body: string }[] {
  const now = new Date().toLocaleString();
  return projects.map((p) => {
    const label = p.label || p.path.split('/').pop() || p.path;
    const lines = [`🤖 OpenChamber agent sync — ${label}`, '', `Last synced ${now}`];
    return { id: p.id, path: p.path, label, body: lines.join('\n') };
  });
}

/** Top-level Discord sync summary message. */
function buildProjectSyncSummary(projects: DiscordSyncProject[]): string {
  const lines = [
    '**🤖 OpenChamber agent sync summary**',
    '',
    `• Projects: ${projects.length}`,
    '',
    `_Sent ${new Date().toLocaleString()}_`,
  ];
  return lines.join('\n');
}

function DiscordServerRow({
  conn,
  guild,
}: {
  conn: MessengerConnection;
  guild: { id: string; name: string };
}) {
  const { t } = useI18n();
  const setDiscordGuildPolicy = useMessengerStore((s) => s.setDiscordGuildPolicy);
  const resolveDiscordGuild = useMessengerStore((s) => s.resolveDiscordGuild);
  const sendTestMessage = useMessengerStore((s) => s.sendTestMessage);
  const syncDiscordGuildProjects = useMessengerStore((s) => s.syncDiscordGuildProjects);
  const projects = useProjectsStore((s) => s.projects);
  const [rowAction, setRowAction] = useState<null | 'test' | 'sync'>(null);

  const policy = conn.discordGuildPolicies?.[guild.id];
  const respond = policy?.enabled !== false;
  const replyMode: DiscordReplyMode = policy?.replyMode ?? 'inherit';
  const syncing = isDiscordGuildSyncing(conn, guild.id);
  const resolved = conn.discordGuildResolved?.[guild.id];
  const categories = resolved?.categories ?? [];
  const isLegacyPrimary = guild.id === conn.discordGuildId;
  const parentCategoryId =
    policy?.parentCategoryId ?? (isLegacyPrimary ? conn.discordParentCategoryId : undefined) ?? '';
  const createThreads =
    policy?.createThreads ?? (isLegacyPrimary ? conn.discordCreateThreads !== false : true);

  // A live server gateway can report "connected" while this browser holds no
  // token; the server falls back to the saved token, so gate the per-server
  // actions on configured state, not the local token alone.
  const configured = Boolean(conn.botToken || conn.discordServerConfigured);
  const busy = conn.lastSyncStatus === 'sending';

  // Fetch the server's channel/category topology so the category picker can
  // render once "Sync projects here" is on and we don't have it cached yet.
  useEffect(() => {
    if (syncing && !resolved && configured) {
      void resolveDiscordGuild(guild.id);
    }
  }, [syncing, resolved, configured, guild.id, resolveDiscordGuild]);

  return (
    <div className="space-y-2 rounded-md border border-border/40 px-2.5 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-foreground">
          {guild.name}
        </span>
        <label className="flex shrink-0 cursor-pointer items-center gap-2">
          <span className="text-[10px] text-muted-foreground">
            {t('settings.integrations.discord.servers.enabled.label')}
          </span>
          <Checkbox
            checked={respond}
            onChange={(checked) => setDiscordGuildPolicy(guild.id, { enabled: checked })}
            ariaLabel={t('settings.integrations.discord.servers.enabled.label')}
          />
        </label>
      </div>

      {/* Per-server actions: choose exactly which server a test / sync targets. */}
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="!font-normal"
          disabled={!configured || busy}
          onClick={() => {
            setRowAction('test');
            void sendTestMessage('discord', { guildId: guild.id }).finally(() =>
              setRowAction(null),
            );
          }}
        >
          {rowAction === 'test' ? (
            <RiLoader4Line className="size-3.5 animate-spin" />
          ) : (
            <RiSendPlaneLine className="size-3.5" />
          )}
          {t('settings.integrations.discord.servers.sendTest')}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="!font-normal"
          disabled={!configured || busy}
          onClick={() => {
            setRowAction('sync');
            void syncDiscordGuildProjects(
              buildProjectSyncPayloads(projects),
              buildProjectSyncSummary(projects),
              { guildIds: [guild.id] },
            ).finally(() => setRowAction(null));
          }}
        >
          {rowAction === 'sync' ? (
            <RiLoader4Line className="size-3.5 animate-spin" />
          ) : (
            <RiRefreshLine className="size-3.5" />
          )}
          {t('settings.integrations.discord.servers.syncNow')}
        </Button>
      </div>

      {respond && (
        <div className="flex flex-wrap items-center gap-1">
          {DISCORD_GUILD_REPLY_MODES.map((mode) => (
            <Button
              key={mode}
              type="button"
              variant="outline"
              size="xs"
              className={cn(
                '!font-normal',
                replyMode === mode
                  ? 'border-[var(--primary-base)] text-[var(--primary-base)] bg-[var(--primary-base)]/10'
                  : 'text-foreground',
              )}
              onClick={() => setDiscordGuildPolicy(guild.id, { replyMode: mode })}
            >
              {t(discordReplyModeLabelKey(mode))}
            </Button>
          ))}
        </div>
      )}

      <div className="space-y-2 border-t border-border/40 pt-2">
        <label className="flex cursor-pointer items-start gap-2">
          <Checkbox
            checked={syncing}
            onChange={(checked) => setDiscordGuildPolicy(guild.id, { syncProjects: checked })}
            ariaLabel={t('settings.integrations.discord.servers.syncProjects.label')}
          />
          <span className="min-w-0">
            <span className="block text-[11px] text-foreground">
              {t('settings.integrations.discord.servers.syncProjects.label')}
            </span>
            <span className="block text-[10px] text-muted-foreground leading-snug">
              {t('settings.integrations.discord.servers.syncProjects.hint')}
            </span>
          </span>
        </label>

        {syncing && (
          <div className="space-y-2 pl-6">
            <div className="flex flex-wrap items-center gap-2 text-[11px]">
              <label htmlFor={`sync-cat-${guild.id}`} className="text-muted-foreground">
                {t('settings.integrations.discord.servers.syncProjects.category')}
              </label>
              <select
                id={`sync-cat-${guild.id}`}
                value={parentCategoryId}
                onChange={(e) =>
                  setDiscordGuildPolicy(guild.id, {
                    parentCategoryId: e.target.value || undefined,
                  })
                }
                className="rounded border border-border bg-background px-2 py-0.5 text-[11px] text-foreground"
              >
                <option value="">
                  {t('settings.integrations.discord.servers.syncProjects.categoryRoot')}
                </option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => void resolveDiscordGuild(guild.id)}
                className="text-[10px] text-primary hover:underline"
              >
                {t('settings.integrations.discord.advanced.primarySyncGuild.rescan')}
              </button>
            </div>
            <label className="flex cursor-pointer items-center gap-2 text-[11px]">
              <Checkbox
                checked={createThreads}
                onChange={(checked) =>
                  setDiscordGuildPolicy(guild.id, { createThreads: checked })
                }
                ariaLabel={t('settings.integrations.discord.servers.syncProjects.threads')}
              />
              <span className="text-muted-foreground">
                {t('settings.integrations.discord.servers.syncProjects.threads')}
              </span>
            </label>
          </div>
        )}
      </div>
    </div>
  );
}

function DiscordServersAndInviteBlock({ conn }: { conn: MessengerConnection }) {
  const { t } = useI18n();
  const fetchDiscordInviteUrl = useMessengerStore((s) => s.fetchDiscordInviteUrl);
  const setDiscordDefaultReplyMode = useMessengerStore((s) => s.setDiscordDefaultReplyMode);
  const refreshDiscordGuilds = useMessengerStore((s) => s.refreshDiscordGuilds);
  const refreshing = useMessengerStore((s) => s.discordGuildsRefreshing);
  const guildsError = useMessengerStore((s) => s.discordGuildsError);

  const guildCount = conn.discordGuilds?.length ?? 0;
  const hasGuilds = guildCount > 0;
  const defaultReplyMode = conn.discordDefaultReplyMode ?? 'always';

  // Poll while empty so joining a server updates the list automatically.
  useDiscordGuildMembershipPoll(!hasGuilds && Boolean(conn.botToken));

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
            variant={hasGuilds ? 'outline' : 'default'}
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
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="!font-normal"
          disabled={refreshing || (!conn.botToken && !conn.discordServerConfigured)}
          onClick={() => void refreshDiscordGuilds()}
        >
          {refreshing ? (
            <Icon name="loader-4" className="size-3.5 animate-spin" />
          ) : (
            <Icon name="refresh" className="size-3.5" />
          )}
          {refreshing
            ? t('settings.integrations.discord.servers.refreshing')
            : t('settings.integrations.discord.servers.refresh')}
        </Button>
      </div>

      <div className="text-[11px] text-muted-foreground">
        {hasGuilds
          ? t('settings.integrations.discord.wizard.step2.botInServers', { count: guildCount })
          : t('settings.integrations.discord.wizard.step2.botNotInServers')}
      </div>

      {!hasGuilds && (
        <div className="rounded-md border border-border/50 bg-background/60 px-2.5 py-2 space-y-1">
          <p className="text-[11px] text-muted-foreground leading-snug">
            {t('settings.integrations.discord.servers.empty')}
          </p>
          {refreshing && (
            <p className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
              <Icon name="loader-4" className="size-3 animate-spin" />
              {t('settings.integrations.discord.servers.refreshing')}
            </p>
          )}
          {guildsError && (
            <p className="text-[11px] text-[var(--status-error)] leading-snug">{guildsError}</p>
          )}
        </div>
      )}

      {hasGuilds && guildsError && (
        <p className="text-[11px] text-[var(--status-error)] leading-snug">{guildsError}</p>
      )}

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
                  {t(discordReplyModeLabelKey(mode))}
                </Button>
              ))}
            </div>
          </div>

          <div className="space-y-2 border-t border-border/60 pt-2">
            {(conn.discordGuilds ?? []).map((g) => (
              <DiscordServerRow key={g.id} conn={conn} guild={g} />
            ))}
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

  const updateConnection = useMessengerStore((s) => s.updateConnection);
  const testConnection = useMessengerStore((s) => s.testConnection);
  const disconnectDiscord = useMessengerStore((s) => s.disconnectDiscord);
  const saveDiscordConfig = useMessengerStore((s) => s.saveDiscordConfig);
  const [disconnecting, setDisconnecting] = useState(false);

  const tokenSectionRef = useRef<HTMLDivElement>(null);
  const advancedSectionRef = useRef<HTMLDivElement>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const scrollToSection = (section: 'token' | 'guild' | 'channel' | 'test' | 'advanced') => {
    // The per-server sync/channel/test controls now live under Advanced and on
    // the server rows, so the wizard's legacy targets resolve to the advanced
    // panel.
    const resolved =
      section === 'guild' || section === 'channel' || section === 'test' ? 'advanced' : section;
    if (resolved === 'advanced') {
      setAdvancedOpen(true);
    }
    if (resolved === 'token') {
      setShowToken(true);
    }
    const ref = resolved === 'token' ? tokenSectionRef : advancedSectionRef;
    window.requestAnimationFrame(() => {
      ref.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  };

  const meta = MESSENGER_META[conn.type];
  const Icon = meta.icon;
  const displayStatus = deriveDiscordDisplayStatus(conn);

  const [showToken, setShowToken] = useState(false);
  const [tokenInput, setTokenInput] = useState('');
  const [disconnectConfirmOpen, setDisconnectConfirmOpen] = useState(false);

  const token = conn.botToken;

  const hasToken = Boolean(token);
  /** True when the bot is configured (local token OR server-side config). */
  const configured = hasToken || Boolean(conn.discordServerConfigured);
  // Persistent view: the wizard owns token entry during onboarding; once a
  // token exists the configured view is stable across reloads — the badge
  // carries the transient live status (connecting/connected/error).
  // Also considers server-configured so a bot that is live on the server but
  // whose token was lost from the local store still shows the configured view.
  const showWizard =
    deriveDiscordViewState({
      hasToken,
      serverConfigured: Boolean(conn.discordServerConfigured),
      wizardActive: onboardingStep !== null && onboardingType === 'discord',
    }) !== 'configured';

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
    // Re-verify so a bad replacement token flips the badge to error instead
    // of coasting on the previous token's connected status.
    setTimeout(() => void testConnection('discord'), 0);
    setTokenInput('');
    setShowToken(false);
  };

  const inputClass =
    'w-full rounded-md border border-border bg-background px-3 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring';

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
          {/* Disconnect lives top-right of the card for both onboarding and the
              configured view. */}
          {configured && (
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="!font-normal text-[var(--status-error)] hover:text-[var(--status-error)]"
              onClick={() => setDisconnectConfirmOpen(true)}
            >
              {t('settings.integrations.discord.disconnect.button')}
            </Button>
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

      {/* The wizard is the only token-entry UI. With a token saved, the
          configured view is stable regardless of transient live status. */}
      {showWizard ? (
        <DiscordOnboardingWizard conn={conn} onScrollToSection={scrollToSection} />
      ) : (
        <>
          {/* Configured: change token + verify. Disconnect sits top-right;
              Advanced settings sits at the bottom-left of the card. */}
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
            {displayStatus !== 'connected' && (
              <Button
                type="button"
                variant="outline"
                size="xs"
                className="!font-normal"
                onClick={() => testConnection(conn.type)}
                disabled={!configured || conn.status === 'connecting'}
              >
                {conn.status === 'connecting'
                  ? t('settings.integrations.discord.wizard.step1.verifying')
                  : t('settings.integrations.discord.wizard.step1.verify')}
              </Button>
            )}
          </div>

          {/* Servers & invite — visually separated from the token/verify row. */}
          <div className="border-t border-border/40 pt-4">
            <DiscordServersAndInviteBlock conn={conn} />
          </div>

          {/* Auto-managed gateway: the bot listens whenever a server is set to
              respond, so there is no manual start/stop here — just live status. */}
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-medium',
                conn.discordListenerConnected
                  ? 'bg-[var(--status-success)]/15 text-[var(--status-success)]'
                  : conn.discordListenerRunning
                    ? 'bg-[var(--status-warning)]/15 text-[var(--status-warning)]'
                    : 'bg-muted text-muted-foreground',
              )}
            >
              <span
                className={cn(
                  'size-1.5 rounded-full',
                  conn.discordListenerConnected
                    ? 'bg-[var(--status-success)]'
                    : conn.discordListenerRunning
                      ? 'bg-[var(--status-warning)]'
                      : 'bg-muted-foreground',
                )}
              />
              {conn.discordListenerConnected
                ? t('settings.integrations.discord.listener.status.live')
                : conn.discordListenerRunning
                  ? t('settings.integrations.discord.listener.status.connecting')
                  : t('settings.integrations.discord.listener.status.off')}
            </span>
            <span className="typography-meta text-muted-foreground">
              {t('settings.integrations.discord.listener.autoManaged')}
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

          {/* Advanced settings — bottom-left of the card. */}
          <div ref={advancedSectionRef} className="border-t border-border/60 pt-3">
            <Button
              type="button"
              variant={advancedOpen ? 'secondary' : 'outline'}
              size="xs"
              className="!font-normal"
              onClick={() => setAdvancedOpen((open) => !open)}
            >
              {t('settings.integrations.discord.actions.advancedSettings')}
            </Button>
            {advancedOpen && (
              <DiscordAdvancedSettings
                conn={conn}
                open={advancedOpen}
                onOpenChange={setAdvancedOpen}
                hideTrigger
              />
            )}
          </div>
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

/**
 * Square "Connect Discord" tile — the only surface shown while nothing is
 * connected (no bot token). Starts the onboarding wizard on click.
 */
function DiscordConnectCard({ onConnect }: { onConnect: () => void }) {
  const { t } = useI18n();
  const meta = MESSENGER_META.discord;
  const Icon = meta.icon;
  return (
    <button
      type="button"
      onClick={onConnect}
      data-settings-item="integrations.discord.connect"
      className="flex size-40 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border p-4 text-center text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
    >
      <Icon className={cn('size-9', meta.color)} />
      <span className="flex items-center gap-1 text-xs font-medium">
        <RiAddLine className="size-3.5" />
        {t('settings.integrations.discord.connect')}
      </span>
      <span className="text-[10px] font-normal leading-snug text-muted-foreground/80">
        {t('settings.integrations.discord.connectHint')}
      </span>
    </button>
  );
}

export const MessengerSection: React.FC = () => {
  const connections = useMessengerStore((s) => s.connections);
  const onboardingStep = useMessengerStore((s) => s.onboardingStep);
  const onboardingType = useMessengerStore((s) => s.onboardingType);
  const startOnboarding = useMessengerStore((s) => s.startOnboarding);
  const hasHydrated = useMessengerStore((s) => s.hasHydrated);

  // Failsafe: never leave Integrations blank if persist hydration stalls.
  useEffect(() => {
    if (hasHydrated) return;
    const timer = window.setTimeout(() => {
      if (!useMessengerStore.getState().hasHydrated) {
        useMessengerStore.setState({ hasHydrated: true });
      }
    }, 250);
    return () => window.clearTimeout(timer);
  }, [hasHydrated]);

  const discordConn = connections.find((c) => c.type === 'discord');
  // Single render rule for the whole section — keyed on the persisted token,
  // not on transient live status, so the surface never flaps between the
  // connect tile, a bare token form, and the configured view.
  // Also considers server-configured so a bot that is live on the server but
  // whose token was lost from the local store still shows the configured view.
  const hasToken = Boolean(discordConn?.botToken);
  const serverConfigured = Boolean(discordConn?.discordServerConfigured);
  const wizardActive = onboardingStep !== null && onboardingType === 'discord';
  const view = deriveDiscordViewState({ hasToken, serverConfigured, wizardActive });

  // When the connect card is showing we don't know yet whether the server has
  // a working bot configured — the localStorage hydration may have come up
  // empty (cleared cache, new device, corrupted data), the initial resync
  // from onRehydrateStorage may have been skipped (error guard, race), or the
  // first probe simply fired before the runtime was ready.  Probe now so the
  // view flips to "configured" within one server round-trip instead of
  // waiting for the next manual action (or never, if nothing else retries).
  useEffect(() => {
    if (!hasHydrated) return;
    if (hasToken || serverConfigured) return;
    void useMessengerStore.getState().resyncDiscordStatus();
  }, [hasHydrated, hasToken, serverConfigured]);

  return (
    <div className="space-y-4">
      {/* Suppress only the connect-card flash until rehydrate; never blank the page. */}
      {hasHydrated && view === 'connect-card' && (
        <DiscordConnectCard onConnect={() => startOnboarding('discord')} />
      )}
      {view !== 'connect-card' && discordConn && <ConnectionCard conn={discordConn} />}
    </div>
  );
};
