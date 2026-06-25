import React, { useEffect, useMemo, useState } from 'react';
import {
  RiDiscordLine,
  RiCheckLine,
  RiCloseLine,
  RiLoader4Line,
  RiAddLine,
  RiSendPlaneLine,
  RiRefreshLine,
  RiInformationLine,
  RiAlertLine,
  RiCheckboxCircleFill,
  RiCheckboxBlankCircleLine,
  RiExternalLinkLine,
  RiEyeLine,
  RiEyeOffLine,
  RiPlayCircleLine,
  RiStopCircleLine,
  RiChatSmile3Line,
  RiStethoscopeLine,
} from '@remixicon/react';
import {
  useMessengerStore,
  type MessengerType,
  type MessengerConnection,
  type MessengerVerbosity,
  type MessengerDiagnosisCheck,
  type MessengerInboundMessage,
} from '@/stores/useMessengerStore';
import { useOttoEventsStore, type OttoUiRealtimeEvent } from '@/stores/useOttoEventsStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { Checkbox } from '@/components/ui/checkbox';
import { Collapsible, CollapsibleContent } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';

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
        → Bot → Reset Token. Enable the <em>Message Content</em> intent so Otto can read replies.
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

function ChecklistItem({
  done,
  label,
  hint,
}: {
  done: boolean;
  label: string;
  hint?: string;
}) {
  return (
    <li className="flex items-start gap-2">
      {done ? (
        <RiCheckboxCircleFill className="size-4 shrink-0 text-green-500" />
      ) : (
        <RiCheckboxBlankCircleLine className="size-4 shrink-0 text-muted-foreground" />
      )}
      <div className="text-xs">
        <span className={cn(done ? 'text-foreground' : 'text-muted-foreground')}>{label}</span>
        {hint ? <span className="text-muted-foreground"> — {hint}</span> : null}
      </div>
    </li>
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
  const running = Boolean(conn.discordListenerRunning);
  const connected = Boolean(conn.discordListenerConnected);
  const autoReply = conn.discordListenerAutoReply !== false;
  const subscribeToEvents = useOttoEventsStore((s) => s.subscribeToEvents);
  const ingestDiscordInbound = useMessengerStore((s) => s.ingestDiscordInbound);

  useEffect(() => {
    if (!running) return;
    const handler = (event: OttoUiRealtimeEvent) => {
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

  useEffect(() => {
    refreshStatus();
    loadRecent();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-save Discord config to server-side settings.json on mount so that
  // the server-side auto-start on reboot picks it up. This handles the case
  // where the user configured Discord (localStorage) but never triggered
  // saveDiscordConfig (e.g. first visit after a server restart).
  useEffect(() => {
    if (conn.botToken) {
      useMessengerStore.getState().saveDiscordConfig();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-start the Discord listener on mount if it's configured but not running.
  // Server auto-starts on boot (from saved config), but this handles first-time
  // setup so the user doesn't need to click "Start listening" manually.
  useEffect(() => {
    if (!running && conn.botToken && (conn.discordGuildId || conn.defaultChannelId)) {
      startListener();
    }
    // Only run once on mount — user can manually stop/start after that.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const historyTarget = conn.defaultChannelId;

  return (
    <div className="rounded-md border border-border/60 bg-muted/30 p-3 space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 text-xs font-medium text-foreground">
          <RiChatSmile3Line className="size-4 text-primary" />
          Listen for incoming messages
          <span
            className={cn(
              'rounded-full px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide',
              connected
                ? 'bg-green-500/20 text-green-600 dark:text-green-400'
                : running
                  ? 'bg-yellow-500/20 text-yellow-600 dark:text-yellow-400'
                  : 'bg-muted text-muted-foreground',
            )}
          >
            {connected ? 'live' : running ? 'connecting…' : 'off'}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {!running ? (
            <button
              type="button"
              onClick={() => startListener()}
              className="inline-flex items-center gap-1 rounded bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground hover:bg-primary/90"
            >
              <RiPlayCircleLine className="size-3.5" />
              Start listening
            </button>
          ) : (
            <button
              type="button"
              onClick={() => stopListener()}
              className="inline-flex items-center gap-1 rounded border border-destructive/40 px-2.5 py-1 text-[11px] font-medium text-destructive hover:bg-destructive/10"
            >
              <RiStopCircleLine className="size-3.5" />
              Stop
            </button>
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
          Start the listener so Otto can answer messages sent to the bot.
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
  const enabled = conn.bridgeEnabled !== false;
  const bridgeVerbosity = useMessengerStore((s) => s.bridgeVerbosity);
  const setBridgeVerbosity = useMessengerStore((s) => s.setBridgeVerbosity);
  useEffect(() => {
    refreshBridgeStatus(type);
    const id = setInterval(() => refreshBridgeStatus(type), 8000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type]);

  const bindings = bridgeStatus.bindings.filter((b) => b.type === type);
  const active = bridgeStatus.active.filter((a) => a.type === type);
  const currentVerbosity: MessengerVerbosity = bridgeVerbosity[type] ?? 'normal';

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

function DiscordAdvancedSettings({ conn }: { conn: MessengerConnection }) {
  const [open, setOpen] = useState(false);

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
  const projects = useProjectsStore((s) => s.projects);
  const projectMappings = useMessengerStore((s) => s.projectMappings);
  const setProjectMapping = useMessengerStore((s) => s.setProjectMapping);

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
      open={open}
      onOpenChange={setOpen}
      className="border-t border-border/60 pt-3"
    >
      <label className="flex cursor-pointer select-none items-center gap-2">
        <Checkbox checked={open} onChange={setOpen} ariaLabel="Show advanced settings" />
        <span className="text-xs font-medium text-foreground">Advanced settings</span>
        <span className="text-[10px] font-normal text-muted-foreground">
          single channel ID, listener, OpenCode bridge &amp; diagnostics
        </span>
      </label>
      <CollapsibleContent className="space-y-4 pt-3">
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

        {/* OpenCode bridge — when on, the listeners route inbound messages
            through OpenCode and stream the response back. This is what turns
            the messenger into a real OpenChamber chat surface, instead of the
            legacy "Otto received: ..." ping echo. */}
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

function ConnectionCard({ conn }: { conn: MessengerConnection }) {
  const updateConnection = useMessengerStore((s) => s.updateConnection);
  const testConnection = useMessengerStore((s) => s.testConnection);
  const removeConnection = useMessengerStore((s) => s.removeConnection);
  const resolveDiscordGuild = useMessengerStore((s) => s.resolveDiscordGuild);
  const syncDiscordGuildProjects = useMessengerStore((s) => s.syncDiscordGuildProjects);
  const fetchDiscordInviteUrl = useMessengerStore((s) => s.fetchDiscordInviteUrl);
  const sendTestMessage = useMessengerStore((s) => s.sendTestMessage);
  const sendSyncSummary = useMessengerStore((s) => s.sendSyncSummary);
  const saveDiscordConfig = useMessengerStore((s) => s.saveDiscordConfig);
  const projects = useProjectsStore((s) => s.projects);

  const meta = MESSENGER_META[conn.type];
  const Icon = meta.icon;

  const [showToken, setShowToken] = useState(false);
  const [tokenInput, setTokenInput] = useState('');
  const [showTokenPlain, setShowTokenPlain] = useState(false);
  const [guildInput, setGuildInput] = useState('');

  const token = conn.botToken;
  const target = conn.defaultChannelId;

  const hasToken = Boolean(token);
  const hasTarget = Boolean(target);
  const isConnected = conn.status === 'connected';
  const setupComplete = hasToken && hasTarget && isConnected;

  // Auto-save Discord config to server-side settings.json on mount so that
  // the server-side auto-start on reboot picks it up. Runs when the
  // ConnectionCard first renders (user visits Messenger settings page).
  //
  // Also re-verify the saved token so the working status reflects reality on
  // open. The persisted store resets `status` to 'disconnected' on every reload
  // (the token is the only durable signal), which otherwise made the page show
  // the integration as "not working" until the user manually clicked Verify.
  useEffect(() => {
    if (!conn.botToken) return;
    saveDiscordConfig();
    if (conn.status !== 'connected' && conn.status !== 'connecting') {
      testConnection('discord');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      const lines = [`🤖 Otto sync — ${label}`, '', `Last synced ${now}`];
      return { id: p.id, path: p.path, label, body: lines.join('\n') };
    });
  };

  const buildSummary = (): string => {
    const lines = [
      '**🤖 Otto sync summary**',
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
          <StatusBadge status={conn.status} />
          {conn.discordBotUsername && (
            <span className="text-[10px] text-muted-foreground">
              {conn.discordBotUsername}
              {conn.discordBotDiscriminator && conn.discordBotDiscriminator !== '0'
                ? `#${conn.discordBotDiscriminator}`
                : ''}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => testConnection(conn.type)}
            disabled={!token || conn.status === 'connecting'}
            className="rounded px-2 py-1 text-[10px] font-medium text-primary bg-primary/10 hover:bg-primary/20 disabled:opacity-50"
            title="Verify the bot token by calling the messenger API"
          >
            {conn.status === 'connecting' ? 'Testing…' : 'Verify token'}
          </button>
          <button
            type="button"
            onClick={() => removeConnection(conn.type)}
            className="text-muted-foreground hover:text-destructive"
            title={`Disconnect ${meta.name}`}
          >
            <RiCloseLine className="size-4" />
          </button>
        </div>
      </div>

      {/* Connection error */}
      {conn.error && (
        <div className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive flex items-start gap-2">
          <RiAlertLine className="size-3.5 shrink-0 mt-0.5" />
          <span>{conn.error}</span>
        </div>
      )}

      {/* Setup checklist */}
      <div className="rounded-md border border-border/60 bg-muted/30 p-3 space-y-2">
        <div className="flex items-center justify-between">
          <div className="text-xs font-medium text-foreground flex items-center gap-1.5">
            <RiInformationLine className="size-3.5 text-primary" />
            Setup
          </div>
          {setupComplete && (
            <span className="text-[10px] font-medium text-green-600 dark:text-green-400">
              All set ✓
            </span>
          )}
        </div>
        <ul className="space-y-1">
          <ChecklistItem
            done={hasToken}
            label="1. Add bot token"
            hint={hasToken ? undefined : 'paste the token below'}
          />
          <ChecklistItem
            done={isConnected}
            label="2. Verify token"
            hint={
              !hasToken
                ? undefined
                : isConnected
                  ? `connected as ${conn.discordBotUsername ?? 'bot'} — ${conn.discordGuilds?.length ?? 0} server${(conn.discordGuilds?.length ?? 0) === 1 ? '' : 's'}`
                  : 'click "Verify token" above'
            }
          />
          <ChecklistItem
            done={hasTarget || Boolean(conn.discordGuildId)}
            label="3. Add Server ID (or single channel ID)"
            hint={
              hasTarget
                ? conn.discordChannelName
                  ? `#${conn.discordChannelName}${conn.guildName ? ` (${conn.guildName})` : ''}`
                  : conn.defaultChannelId
                : conn.discordGuildId
                  ? `${conn.guildName ?? conn.discordGuildId} · ${conn.discordGuildChannels?.length ?? 0} channel${(conn.discordGuildChannels?.length ?? 0) === 1 ? '' : 's'}`
                  : 'see the field below'
            }
          />
          <ChecklistItem
            done={Boolean(conn.lastSyncAt)}
            label="4. Send a test message"
            hint={
              conn.lastSyncAt
                ? `last activity ${formatRelative(conn.lastSyncAt)}`
                : 'use the "Send test message" button'
            }
          />
        </ul>

        {setupComplete && (
          <div className="mt-1.5 text-[11px] text-green-700 dark:text-green-400 leading-snug">
            Otto will post updates to{' '}
            {conn.discordChannelName
              ? `#${conn.discordChannelName}${conn.guildName ? ` in ${conn.guildName}` : ''}`
              : 'your channel'}{' '}
            based on the sync mode below.
          </div>
        )}
      </div>

      {/* Step 1: Token */}
      {!token ? (
        <div className="space-y-2">
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
            <button
              type="button"
              onClick={handleSaveToken}
              disabled={!tokenInput.trim()}
              className="shrink-0 rounded bg-primary px-3 py-1.5 text-xs text-primary-foreground disabled:opacity-50"
            >
              Save
            </button>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2 text-xs">
          <RiCheckLine className="size-3 text-green-500" />
          <span className="text-muted-foreground">Token configured</span>
          <button
            type="button"
            onClick={() => setShowToken(!showToken)}
            className="text-primary text-[10px]"
          >
            {showToken ? 'Cancel' : 'Change'}
          </button>
          {showToken && (
            <div className="flex gap-2 flex-1">
              <input
                type="password"
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                placeholder="New token"
                className={inputClass}
              />
              <button
                type="button"
                onClick={handleSaveToken}
                disabled={!tokenInput.trim()}
                className="rounded bg-primary px-2 py-1 text-[10px] text-primary-foreground disabled:opacity-50"
              >
                Update
              </button>
            </div>
          )}
        </div>
      )}

      {/* Invite bot to server hint */}
      {token && isConnected && (
        <div className="rounded-md border border-border/60 bg-muted/30 p-3 text-xs space-y-1.5">
          <div className="font-medium text-foreground flex items-center gap-1.5">
            <RiInformationLine className="size-3.5 text-primary" />
            Invite your bot to a server
          </div>
          {conn.discordGuilds && conn.discordGuilds.length > 0 ? (
            <>
              <div className="text-muted-foreground leading-snug">
                Bot is already in {conn.discordGuilds.length} server
                {conn.discordGuilds.length === 1 ? '' : 's'}:
              </div>
              <ul className="flex flex-wrap gap-1">
                {conn.discordGuilds.slice(0, 8).map((g) => (
                  <li
                    key={g.id}
                    className="rounded-full bg-background border border-border px-2 py-0.5 text-[10px] text-foreground"
                    title={`Guild ID: ${g.id}`}
                  >
                    {g.name}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <div className="text-muted-foreground leading-snug">
              Your bot isn't in any server yet. Add it to your server so it can see channels:
            </div>
          )}
          {conn.discordInviteUrl ? (
            <a
              href={conn.discordInviteUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-primary text-[11px] hover:underline"
            >
              {conn.discordGuilds && conn.discordGuilds.length > 0
                ? 'Add to another server'
                : 'Open invite link'}{' '}
              <RiExternalLinkLine className="size-3" />
            </a>
          ) : (
            <button
              type="button"
              onClick={() => fetchDiscordInviteUrl()}
              className="text-primary text-[11px] hover:underline"
            >
              Generate invite link →
            </button>
          )}
          <div className="text-[10px] text-muted-foreground leading-snug">
            Required permissions: View Channel, Send Messages, Embed Links, Read Message History,
            and (for server-wide sync) Manage Channels + Manage Threads.
          </div>
        </div>
      )}

      {/* Discord-only: server (guild) ID for server-wide sync.
          Rendered as soon as the token is saved so users see the option
          before verify succeeds (resolve-guild itself surfaces bad-token errors). */}
      {token && (
        <div className="rounded-md border border-primary/20 bg-primary/5 p-3 text-xs space-y-2">
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
                project across the whole server.
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
                    // Persist to server-side settings.json so auto-start works on reboot
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
                          // Persist to server-side settings.json so auto-start works on reboot
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
                    // Persist to server-side settings.json so auto-start works on reboot
                    setTimeout(() => saveDiscordConfig(), 0);
                  }}
                  className="text-primary text-[10px] hover:underline"
                >
                  Change
                </button>
              </div>

              {/* Category picker */}
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
                      // Persist to server-side settings.json so auto-start works on reboot
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
      )}

      {/* Step 3: Action buttons - the visible "what next" call to action.
          For Discord, server-id alone also unlocks the CTA (Sync now works with just guildId). */}
      {hasToken && (hasTarget || conn.discordGuildId) && (
        <div className="space-y-2 rounded-md border border-primary/20 bg-primary/5 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => sendTestMessage(conn.type)}
              disabled={conn.lastSyncStatus === 'sending'}
              className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {conn.lastSyncStatus === 'sending' ? (
                <RiLoader4Line className="size-3.5 animate-spin" />
              ) : (
                <RiSendPlaneLine className="size-3.5" />
              )}
              Send test message
            </button>
            <button
              type="button"
              onClick={() => {
                if (conn.discordGuildId) {
                  // Server-wide sync: per-project channel + thread.
                  syncDiscordGuildProjects(buildProjectPayloads(), buildSummary());
                } else {
                  sendSyncSummary(conn.type, buildSummary());
                }
              }}
              disabled={conn.lastSyncStatus === 'sending'}
              className="inline-flex items-center gap-1.5 rounded-md border border-primary/40 px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/10 disabled:opacity-50"
            >
              {conn.lastSyncStatus === 'sending' ? (
                <RiLoader4Line className="size-3.5 animate-spin" />
              ) : (
                <RiRefreshLine className="size-3.5" />
              )}
              Sync now
            </button>
            <div className="ml-auto text-[10px] text-muted-foreground">
              Last activity: {formatRelative(conn.lastSyncAt)}
            </div>
          </div>
          {conn.lastSyncMessage && (
            <div
              className={cn(
                'text-[11px] leading-snug',
                conn.lastSyncStatus === 'error' && 'text-destructive',
                conn.lastSyncStatus === 'ok' && 'text-green-600 dark:text-green-400',
                conn.lastSyncStatus === 'sending' && 'text-muted-foreground',
              )}
            >
              {conn.lastSyncMessage}
            </div>
          )}
        </div>
      )}

      {/* Advanced — listener, OpenCode bridge, diagnostics, sync results and
          project mappings. Hidden by default behind a checkbox to keep the
          main setup flow simple; the listener/bridge still auto-start in the
          background regardless of whether this section is expanded. */}
      {hasToken && <DiscordAdvancedSettings conn={conn} />}
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
