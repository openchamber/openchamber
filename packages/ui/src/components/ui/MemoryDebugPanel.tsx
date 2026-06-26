import React from 'react';

import { useSessionUIStore } from '@/sync/session-ui-store';
import { useViewportStore } from '@/sync/viewport-store';
import { useSessions, useDirectorySync } from '@/sync/sync-context';
import { MEMORY_LIMITS } from '@/stores/types/sessionTypes';
import { useGitHubPrStatusStore } from '@/stores/useGitHubPrStatusStore';
import { getBackgroundTrimLimit } from '@/stores/types/sessionTypes';
import { getStreamPerfSnapshot, getVsCodeStreamPerfSnapshot, resetStreamPerf, type StreamPerfSnapshot } from '@/stores/utils/streamDebug';
import { getRequestsInFlightSnapshot, resetRequestsInFlight, type RequestsInFlightSnapshot } from '@/stores/utils/requestsInFlight';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { Icon } from "@/components/icon/Icon";
import { useI18n } from '@/lib/i18n';

interface DebugPanelProps {
  onClose?: () => void;
}

type DebugTab = 'memory' | 'streaming' | 'requests';

const formatDuration = (durationMs: number): string => {
  if (durationMs < 1000) {
    return `${Math.round(durationMs)}ms`;
  }

  const seconds = durationMs / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainderSeconds = Math.round(seconds % 60);
  return `${minutes}m ${remainderSeconds}s`;
};

// Fixed-width seconds format ("XX.XX s") for the percentile series so the
// legend/labels don't jitter as values change. Pair with `tabular-nums`.
const formatSeconds = (durationMs: number): string => `${(durationMs / 1000).toFixed(2)} s`;

const MetricCard: React.FC<{ label: string; value: React.ReactNode }> = ({ label, value }) => {
  return (
    <div
      className="rounded-md p-2"
      style={{ backgroundColor: 'color-mix(in srgb, var(--surface-muted) 55%, transparent)' }}
    >
      <div className="typography-meta text-[var(--surface-muted-foreground)]">{label}</div>
      <div className="typography-markdown font-semibold text-[var(--surface-foreground)]">{value}</div>
    </div>
  );
};

const PerfSection: React.FC<{ title: string; snapshot: StreamPerfSnapshot; emptyLabel: string }> = ({ title, snapshot, emptyLabel }) => {
  const { t } = useI18n();
  const topEntries = snapshot.entries.slice(0, 12);
  const totalSamples = snapshot.entries.reduce((sum, entry) => sum + entry.count, 0);

  return (
    <div className="space-y-2 border-t border-[var(--interactive-border)] pt-2 first:border-t-0 first:pt-0">
      <div className="flex items-center justify-between gap-2">
        <div className="typography-ui-label font-semibold text-[var(--surface-foreground)]">{title}</div>
        <div className="typography-meta text-[var(--surface-muted-foreground)]">
          {snapshot.startedAt ? formatDuration(snapshot.durationMs) : t('memoryDebugPanel.common.idle')}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <MetricCard label={t('memoryDebugPanel.metric.metrics')} value={snapshot.entries.length} />
        <MetricCard label={t('memoryDebugPanel.metric.samples')} value={totalSamples} />
        <MetricCard label={t('memoryDebugPanel.metric.lastUpdate')} value={snapshot.lastUpdatedAt ? t('memoryDebugPanel.common.live') : t('memoryDebugPanel.common.notAvailable')} />
      </div>

      {topEntries.length === 0 ? (
        <div
          className="rounded-md p-3 typography-meta text-[var(--surface-muted-foreground)]"
          style={{ backgroundColor: 'color-mix(in srgb, var(--surface-muted) 45%, transparent)' }}
        >
          {emptyLabel}
        </div>
      ) : (
        <ScrollableOverlay outerClassName="max-h-64" className="pr-1">
          <div className="space-y-1">
            {topEntries.map((entry) => (
              <div
                key={entry.metric}
                className="rounded-md border border-[var(--interactive-border)] p-2"
                style={{ backgroundColor: 'color-mix(in srgb, var(--surface-elevated) 88%, transparent)' }}
              >
                <div className="typography-meta font-medium text-[var(--surface-foreground)] break-all">{entry.metric}</div>
                <div className="mt-1 grid grid-cols-4 gap-2 typography-meta text-[var(--surface-muted-foreground)]">
                  <span>{t('memoryDebugPanel.metric.countValue', { value: entry.count })}</span>
                  <span>{t('memoryDebugPanel.metric.avgValue', { value: entry.avg })}</span>
                  <span>{t('memoryDebugPanel.metric.maxValue', { value: entry.max })}</span>
                  <span>{t('memoryDebugPanel.metric.totalValue', { value: entry.total })}</span>
                </div>
              </div>
            ))}
          </div>
        </ScrollableOverlay>
      )}
    </div>
  );
};

type LineSeries = { samples: number[]; color: string; filled?: boolean };

const LineChart: React.FC<{
  series: LineSeries[];
  peak: number;
  windowSeconds: number;
  ariaLabel: string;
  maxLabel: string;
}> = ({ series, peak, windowSeconds, ariaLabel, maxLabel }) => {
  const width = windowSeconds;
  const height = 56;
  const padTop = 4;
  const n = series.reduce((max, s) => Math.max(max, s.samples.length), 0);
  const scale = peak > 0 ? (height - padTop) / peak : 0;
  const xFor = (i: number): number => width - n + i;
  const yFor = (v: number): number => height - v * scale;
  const baseline = height;

  return (
    <div className="relative w-full">
      <span className="pointer-events-none absolute left-0 top-0 typography-meta text-[var(--surface-muted-foreground)]">{maxLabel}</span>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className="h-14 w-full"
        role="img"
        aria-label={ariaLabel}
      >
        <line
          x1={0}
          y1={baseline}
          x2={width}
          y2={baseline}
          stroke="var(--interactive-border)"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
        {series.map((s, si) => {
          const sn = s.samples.length;
          if (sn === 0) return null;
          const points = s.samples.map((v, i) => `${xFor(i)},${yFor(v).toFixed(2)}`);
          const linePath = `M ${points.join(' L ')}`;
          return (
            <React.Fragment key={si}>
              {s.filled ? (
                <path
                  d={`M ${xFor(0)},${baseline} L ${points.join(' L ')} L ${xFor(sn - 1)},${baseline} Z`}
                  fill={`color-mix(in srgb, ${s.color} 18%, transparent)`}
                  stroke="none"
                />
              ) : null}
              <path
                d={linePath}
                fill="none"
                stroke={s.color}
                strokeWidth={1.5}
                strokeLinejoin="round"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
            </React.Fragment>
          );
        })}
      </svg>
    </div>
  );
};

export const DebugPanel: React.FC<DebugPanelProps> = ({ onClose }) => {
  const { t } = useI18n();
  const [activeTab, setActiveTab] = React.useState<DebugTab>('memory');
  const [copyState, setCopyState] = React.useState<'idle' | 'copied' | 'error'>('idle');
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const sessionMemoryState = useViewportStore((state) => state.sessionMemoryState);
  const sessions = useSessions();
  const messageRecord = useDirectorySync((state) => state.message);
  const totalGitHubRequests = useGitHubPrStatusStore((state) => state.totalRequestCount);
  const [streamSnapshot, setStreamSnapshot] = React.useState<StreamPerfSnapshot>(() => getStreamPerfSnapshot());
  const [vscodeStreamSnapshot, setVsCodeStreamSnapshot] = React.useState<StreamPerfSnapshot>(() => getVsCodeStreamPerfSnapshot());
  const [requestsSnapshot, setRequestsSnapshot] = React.useState<RequestsInFlightSnapshot>(() => getRequestsInFlightSnapshot());
  const ageLines = [
    { label: 'p50', current: requestsSnapshot.ageP50, samples: requestsSnapshot.p50Samples, color: 'var(--status-success)' },
    { label: 'p90', current: requestsSnapshot.ageP90, samples: requestsSnapshot.p90Samples, color: 'var(--status-info)' },
    { label: 'p99', current: requestsSnapshot.ageP99, samples: requestsSnapshot.p99Samples, color: 'var(--status-warning)' },
    { label: 'max', current: requestsSnapshot.ageMax, samples: requestsSnapshot.maxSamples, color: 'var(--status-error)' },
  ];
  const countMax = requestsSnapshot.samples.reduce((m, v) => Math.max(m, v), 0);
  const percentileMax = ageLines.reduce((m, l) => l.samples.reduce((mm, v) => Math.max(mm, v), m), 0);
  const streamMetricCounts = React.useMemo(() => {
    const counts = new Map<string, number>();
    streamSnapshot.entries.forEach((entry) => {
      counts.set(entry.metric, entry.count);
    });
    return {
      messageListRender: counts.get('ui.message_list.render') ?? 0,
      messageListRenderStreaming: counts.get('ui.message_list.render.streaming') ?? 0,
      chatMessageRender: counts.get('ui.chat_message.render') ?? 0,
      chatMessageRenderStreaming: counts.get('ui.chat_message.render.streaming') ?? 0,
      chatMessageRenderStaticDuringStream: counts.get('ui.chat_message.render.static_during_stream') ?? 0,
      chatMessageRenderStaticOutsideActiveTurnDuringStream:
        counts.get('ui.chat_message.render.static_outside_active_turn_during_stream') ?? 0,
    };
  }, [streamSnapshot.entries]);

  React.useEffect(() => {
    const refresh = () => {
      setStreamSnapshot(getStreamPerfSnapshot());
      setVsCodeStreamSnapshot(getVsCodeStreamPerfSnapshot());
      setRequestsSnapshot(getRequestsInFlightSnapshot());
    };

    refresh();
    const intervalId = window.setInterval(refresh, 500);
    return () => window.clearInterval(intervalId);
  }, []);

  React.useEffect(() => {
    if (copyState === 'idle') {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setCopyState('idle');
    }, 1500);

    return () => window.clearTimeout(timeoutId);
  }, [copyState]);

  const messageRoleCounts = React.useMemo(() => {
    let assistant = 0;
    let total = 0;
    let user = 0;
    for (const sessionId of Object.keys(messageRecord)) {
      const messages = messageRecord[sessionId] ?? [];
      total += messages.length;
      for (const message of messages) {
        if (message.role === 'user') {
          user += 1;
        } else if (message.role === 'assistant') {
          assistant += 1;
        }
      }
    }
    return { assistant, total, user };
  }, [messageRecord]);

  const sessionStats = React.useMemo(() => {
    return sessions.map(session => {
      const messages = messageRecord[session.id] ?? [];
      let assistantMessageCount = 0;
      let userMessageCount = 0;
      for (const message of messages) {
        if (message.role === 'user') {
          userMessageCount += 1;
        } else if (message.role === 'assistant') {
          assistantMessageCount += 1;
        }
      }
      const memoryState = sessionMemoryState.get(session.id);
      return {
        id: session.id,
        title: session.title || t('memoryDebugPanel.common.untitled'),
        assistantMessageCount,
        messageCount: messages.length,
        userMessageCount,
        isStreaming: memoryState?.isStreaming || false,
        isZombie: memoryState?.isZombie || false,
        backgroundCount: memoryState?.backgroundMessageCount || 0,
        lastAccessed: memoryState?.lastAccessedAt || 0,
        isCurrent: session.id === currentSessionId
      };
    }).sort((a, b) => b.lastAccessed - a.lastAccessed);
  }, [sessions, messageRecord, sessionMemoryState, currentSessionId, t]);

  const cachedSessionCount = Object.keys(messageRecord).length;

  const handleCopyStreamingDebug = React.useCallback(async () => {
    try {
      const payload = {
        generatedAt: new Date().toISOString(),
        ui: getStreamPerfSnapshot(),
        vscode: getVsCodeStreamPerfSnapshot(),
      };
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
      setCopyState('copied');
    } catch {
      setCopyState('error');
    }
  }, []);

  return (
    <Card
      className="fixed bottom-4 right-4 z-50 w-[28rem] p-4 shadow-none bottom-safe-area"
      style={{ backgroundColor: 'color-mix(in srgb, var(--surface-background) 94%, transparent)' }}
    >
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Icon
            name={activeTab === 'memory' ? 'database-2' : activeTab === 'streaming' ? 'bar-chart-box' : 'pulse'}
            className="h-4 w-4 text-[var(--surface-foreground)]"
          />
          <h3 className="typography-ui-label font-semibold text-[var(--surface-foreground)]">{t('memoryDebugPanel.title')}</h3>
        </div>
        <div className="flex items-center gap-1">
          {activeTab === 'streaming' ? (
            <>
              <Button size="xs" variant="ghost" onClick={handleCopyStreamingDebug}>
                <Icon name="file-copy" className="h-3.5 w-3.5" />
              </Button>
              <Button
                size="xs"
                variant="ghost"
                onClick={() => {
                  resetStreamPerf();
                  setStreamSnapshot(getStreamPerfSnapshot());
                  setVsCodeStreamSnapshot(getVsCodeStreamPerfSnapshot());
                }}
              >
                <Icon name="refresh" className="h-3.5 w-3.5" />
              </Button>
            </>
          ) : null}
          {activeTab === 'requests' ? (
            <Button
              size="xs"
              variant="ghost"
              onClick={() => {
                resetRequestsInFlight();
                setRequestsSnapshot(getRequestsInFlightSnapshot());
              }}
            >
              <Icon name="refresh" className="h-3.5 w-3.5" />
            </Button>
          ) : null}
          {onClose ? (
            <Button size="icon" variant="ghost" className="h-6 w-6" onClick={onClose}>
              <Icon name="close" className="h-4 w-4" />
            </Button>
          ) : null}
        </div>
      </div>

      <div
        className="mb-3 flex gap-1 rounded-md p-1"
        style={{ backgroundColor: 'color-mix(in srgb, var(--surface-muted) 55%, transparent)' }}
      >
        <Button
          size="sm"
          variant={activeTab === 'memory' ? 'secondary' : 'ghost'}
          className="flex-1"
          onClick={() => setActiveTab('memory')}
        >
          {t('memoryDebugPanel.tabs.memory')}
        </Button>
        <Button
          size="sm"
          variant={activeTab === 'streaming' ? 'secondary' : 'ghost'}
          className="flex-1"
          onClick={() => setActiveTab('streaming')}
        >
          {t('memoryDebugPanel.tabs.streaming')}
        </Button>
        <Button
          size="sm"
          variant={activeTab === 'requests' ? 'secondary' : 'ghost'}
          className="flex-1"
          onClick={() => setActiveTab('requests')}
        >
          {t('memoryDebugPanel.tabs.requests')}
        </Button>
      </div>

      {activeTab === 'memory' ? (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2 typography-meta">
            <MetricCard label={t('memoryDebugPanel.metric.totalMessages')} value={messageRoleCounts.total} />
            <MetricCard label={t('memoryDebugPanel.metric.cachedSessions')} value={`${cachedSessionCount} / ${MEMORY_LIMITS.MAX_SESSIONS}`} />
            <MetricCard label={t('memoryDebugPanel.metric.userMessages')} value={messageRoleCounts.user} />
            <MetricCard label={t('memoryDebugPanel.metric.assistantMessages')} value={messageRoleCounts.assistant} />
          </div>

          <div className="typography-meta space-y-1 border-t border-[var(--interactive-border)] pt-2">
            <div className="flex justify-between gap-2">
              <span className="text-[var(--surface-muted-foreground)]">{t('memoryDebugPanel.metric.viewportWindow')}</span>
              <span className="text-[var(--surface-foreground)]">{t('memoryDebugPanel.metric.messagesValue', { count: getBackgroundTrimLimit() })}</span>
            </div>
            <div className="flex justify-between gap-2">
              <span className="text-[var(--surface-muted-foreground)]">{t('memoryDebugPanel.metric.zombieTimeout')}</span>
              <span className="text-[var(--surface-foreground)]">{t('memoryDebugPanel.metric.minutesValue', { count: MEMORY_LIMITS.ZOMBIE_TIMEOUT / 1000 / 60 })}</span>
            </div>
            <div className="flex justify-between gap-2">
              <span className="text-[var(--surface-muted-foreground)]">{t('memoryDebugPanel.metric.githubTotalRequests')}</span>
              <span className="text-[var(--surface-foreground)]">{totalGitHubRequests}</span>
            </div>
          </div>

          <div className="border-t border-[var(--interactive-border)] pt-2">
            <div className="mb-1 typography-meta font-semibold text-[var(--surface-foreground)]">{t('memoryDebugPanel.section.sessionsInMemory')}</div>
            <ScrollableOverlay outerClassName="max-h-48" className="space-y-1 pr-1">
              {sessionStats.map(stat => (
                <div
                  key={stat.id}
                  className="typography-meta flex items-center justify-between rounded p-1.5"
                  style={{
                    backgroundColor: stat.isCurrent
                      ? 'color-mix(in srgb, var(--interactive-selection) 22%, transparent)'
                      : 'color-mix(in srgb, var(--surface-muted) 35%, transparent)',
                  }}
                >
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    <span className="truncate text-[var(--surface-foreground)]">{stat.title}</span>
                    {stat.isStreaming ? <Icon name="pulse" className="h-3 w-3 animate-pulse text-[var(--status-info)]" /> : null}
                    {stat.isZombie ? <span className="text-[var(--status-warning)]">!</span> : null}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[var(--surface-muted-foreground)]">
                      {t('memoryDebugPanel.metric.roleMsgsValue', {
                        assistant: stat.assistantMessageCount,
                        user: stat.userMessageCount,
                      })}
                    </span>
                    <span className="font-mono text-[var(--surface-foreground)]">
                      {t('memoryDebugPanel.metric.msgsValue', { count: stat.messageCount })}
                    </span>
                    {stat.backgroundCount > 0 ? (
                      <span className="text-[var(--status-info)]">+{stat.backgroundCount}</span>
                    ) : null}
                  </div>
                </div>
              ))}
            </ScrollableOverlay>
          </div>

          <div className="flex gap-2 border-t border-[var(--interactive-border)] pt-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="sm"
                  variant="outline"
                  className="typography-meta"
                  onClick={() => {
                    console.log('[DebugPanel] Session store state:', {
                      sessions: sessions.map(s => ({ id: s.id, title: s.title })),
                      currentSessionId,
                      cachedSessions: Object.keys(messageRecord),
                      messageRoleCounts,
                      sessionMessageRoleCounts: sessionStats.map(stat => ({
                        id: stat.id,
                        title: stat.title,
                        total: stat.messageCount,
                        user: stat.userMessageCount,
                        assistant: stat.assistantMessageCount,
                      })),
                      memoryStates: Object.fromEntries(sessionMemoryState),
                    });
                  }}
                >
                  {t('memoryDebugPanel.actions.logState')}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">{t('memoryDebugPanel.tooltip.logCurrentState')}</TooltipContent>
            </Tooltip>
          </div>
        </div>
      ) : activeTab === 'streaming' ? (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2 rounded-md border border-[var(--interactive-border)] px-3 py-2 typography-meta text-[var(--surface-muted-foreground)]">
            <span>
              {copyState === 'copied'
                ? t('memoryDebugPanel.streaming.copy.copied')
                : copyState === 'error'
                  ? t('memoryDebugPanel.streaming.copy.failed')
                  : t('memoryDebugPanel.streaming.copy.hint')}
            </span>
            <Button size="xs" variant="outline" onClick={handleCopyStreamingDebug}>
              {t('memoryDebugPanel.actions.copyJson')}
            </Button>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <MetricCard label={t('memoryDebugPanel.metric.uiMetrics')} value={streamSnapshot.entries.length} />
            <MetricCard label={t('memoryDebugPanel.metric.vscodeMetrics')} value={vscodeStreamSnapshot.entries.length} />
            <MetricCard label={t('memoryDebugPanel.metric.messageListRenders')} value={streamMetricCounts.messageListRender} />
            <MetricCard label={t('memoryDebugPanel.metric.messageListStreamRenders')} value={streamMetricCounts.messageListRenderStreaming} />
            <MetricCard label={t('memoryDebugPanel.metric.chatMessageRenders')} value={streamMetricCounts.chatMessageRender} />
            <MetricCard label={t('memoryDebugPanel.metric.chatMessageStreamRenders')} value={streamMetricCounts.chatMessageRenderStreaming} />
            <MetricCard label={t('memoryDebugPanel.metric.chatMessageStaticDuringStream')} value={streamMetricCounts.chatMessageRenderStaticDuringStream} />
            <MetricCard
              label={t('memoryDebugPanel.metric.chatMessageStaticOutsideActiveTurn')}
              value={streamMetricCounts.chatMessageRenderStaticOutsideActiveTurnDuringStream}
            />
          </div>

          <PerfSection
            title={t('memoryDebugPanel.section.uiStreamingMetrics')}
            snapshot={streamSnapshot}
            emptyLabel={t('memoryDebugPanel.section.noUiSamples')}
          />

          {vscodeStreamSnapshot.entries.length > 0 ? (
            <PerfSection
              title={t('memoryDebugPanel.section.vscodeBridgeMetrics')}
              snapshot={vscodeStreamSnapshot}
              emptyLabel={t('memoryDebugPanel.section.noVscodeSamples')}
            />
          ) : null}
        </div>
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2 typography-meta">
            <MetricCard label={t('memoryDebugPanel.requests.totalRequests')} value={`${requestsSnapshot.totalSettled} / ${requestsSnapshot.totalStarted}`} />
            <MetricCard
              label={t('memoryDebugPanel.requests.tracking')}
              value={requestsSnapshot.startedAt ? formatDuration(requestsSnapshot.durationMs) : t('memoryDebugPanel.common.idle')}
            />
          </div>

          {requestsSnapshot.samples.length === 0 ? (
            <div
              className="rounded-md p-3 typography-meta text-[var(--surface-muted-foreground)]"
              style={{ backgroundColor: 'color-mix(in srgb, var(--surface-muted) 45%, transparent)' }}
            >
              {t('memoryDebugPanel.requests.noSamples')}
            </div>
          ) : (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between typography-meta">
                <span className="text-[var(--surface-muted-foreground)]">{t('memoryDebugPanel.requests.inFlight')}</span>
                <span>
                  <span className="font-medium text-[var(--surface-foreground)]">{requestsSnapshot.inFlight}</span>
                  <span className="text-[var(--surface-muted-foreground)]"> · {t('memoryDebugPanel.requests.peak')} </span>
                  <span className="font-medium text-[var(--surface-foreground)]">{requestsSnapshot.peak}</span>
                </span>
              </div>
              <LineChart
                series={[{ samples: requestsSnapshot.samples, color: 'var(--status-info)', filled: true }]}
                peak={countMax}
                windowSeconds={requestsSnapshot.windowSeconds}
                ariaLabel={t('memoryDebugPanel.requests.chartLabel', { peak: requestsSnapshot.peak })}
                maxLabel={`${countMax}`}
              />

              <div className="flex items-center justify-between typography-meta">
                <span className="text-[var(--surface-muted-foreground)]">{t('memoryDebugPanel.requests.duration')}</span>
                <span className="font-medium tabular-nums text-[var(--surface-foreground)]">{formatSeconds(requestsSnapshot.peakAgeMs)}</span>
              </div>
              <LineChart
                series={ageLines.map((line) => ({ samples: line.samples, color: line.color }))}
                peak={percentileMax}
                windowSeconds={requestsSnapshot.windowSeconds}
                ariaLabel={t('memoryDebugPanel.requests.percentileChartLabel')}
                maxLabel={formatSeconds(percentileMax)}
              />

              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 typography-meta">
                {ageLines.map((line) => (
                  <span key={line.label} className="flex items-center gap-1">
                    <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: line.color }} />
                    <span className="text-[var(--surface-muted-foreground)]">{line.label}</span>
                    <span className="font-medium tabular-nums text-[var(--surface-foreground)]">{formatSeconds(line.current)}</span>
                  </span>
                ))}
              </div>

              <div className="flex items-center justify-between typography-meta text-[var(--surface-muted-foreground)]">
                <span>{t('memoryDebugPanel.requests.windowHint', { seconds: requestsSnapshot.windowSeconds })}</span>
                <span>{t('memoryDebugPanel.requests.now')}</span>
              </div>
            </div>
          )}
        </div>
      )}
    </Card>
  );
};

export const MemoryDebugPanel = DebugPanel;
