import React from 'react';
import { RiBarChartBoxLine, RiCloseLine, RiDatabase2Line, RiFileCopyLine, RiPulseLine, RiRefreshLine } from '@remixicon/react';

import { useSessionUIStore } from '@/sync/session-ui-store';
import { useViewportStore } from '@/sync/viewport-store';
import { useSessions, useDirectorySync } from '@/sync/sync-context';
import { MEMORY_LIMITS } from '@/stores/types/sessionTypes';
import { useGitHubPrStatusStore } from '@/stores/useGitHubPrStatusStore';
import { getBackgroundTrimLimit } from '@/stores/types/sessionTypes';
import { getStreamPerfSnapshot, getVsCodeStreamPerfSnapshot, resetStreamPerf, type StreamPerfSnapshot } from '@/stores/utils/streamDebug';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';

interface DebugPanelProps {
  onClose?: () => void;
}

type DebugTab = 'memory' | 'streaming';

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
  const topEntries = snapshot.entries.slice(0, 12);
  const totalSamples = snapshot.entries.reduce((sum, entry) => sum + entry.count, 0);

  return (
    <div className="space-y-2 border-t border-[var(--interactive-border)] pt-2 first:border-t-0 first:pt-0">
      <div className="flex items-center justify-between gap-2">
        <div className="typography-ui-label font-semibold text-[var(--surface-foreground)]">{title}</div>
        <div className="typography-meta text-[var(--surface-muted-foreground)]">
          {snapshot.startedAt ? formatDuration(snapshot.durationMs) : 'idle'}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <MetricCard label="Metrics" value={snapshot.entries.length} />
        <MetricCard label="Samples" value={totalSamples} />
        <MetricCard label="Last Update" value={snapshot.lastUpdatedAt ? 'live' : 'n/a'} />
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
                  <span>count {entry.count}</span>
                  <span>avg {entry.avg}</span>
                  <span>max {entry.max}</span>
                  <span>total {entry.total}</span>
                </div>
              </div>
            ))}
          </div>
        </ScrollableOverlay>
      )}
    </div>
  );
};

export const DebugPanel: React.FC<DebugPanelProps> = ({ onClose }) => {
  const [activeTab, setActiveTab] = React.useState<DebugTab>('memory');
  const [copyState, setCopyState] = React.useState<'idle' | 'copied' | 'error'>('idle');
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const sessionMemoryState = useViewportStore((state) => state.sessionMemoryState);
  const sessions = useSessions();
  const messageRecord = useDirectorySync((state) => state.message);
  const totalGitHubRequests = useGitHubPrStatusStore((state) => state.totalRequestCount);
  const [streamSnapshot, setStreamSnapshot] = React.useState<StreamPerfSnapshot>(() => getStreamPerfSnapshot());
  const [vscodeStreamSnapshot, setVsCodeStreamSnapshot] = React.useState<StreamPerfSnapshot>(() => getVsCodeStreamPerfSnapshot());
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

  const totalMessages = React.useMemo(() => {
    let total = 0;
    for (const sessionId of Object.keys(messageRecord)) {
      total += messageRecord[sessionId]?.length ?? 0;
    }
    return total;
  }, [messageRecord]);

  const sessionStats = React.useMemo(() => {
    return sessions.map(session => {
      const messageCount = messageRecord[session.id]?.length || 0;
      const memoryState = sessionMemoryState.get(session.id);
      return {
        id: session.id,
        title: session.title || 'Untitled',
        messageCount,
        isStreaming: memoryState?.isStreaming || false,
        isZombie: memoryState?.isZombie || false,
        backgroundCount: memoryState?.backgroundMessageCount || 0,
        lastAccessed: memoryState?.lastAccessedAt || 0,
        isCurrent: session.id === currentSessionId
      };
    }).sort((a, b) => b.lastAccessed - a.lastAccessed);
  }, [sessions, messageRecord, sessionMemoryState, currentSessionId]);

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
          {activeTab === 'memory' ? (
            <RiDatabase2Line className="h-4 w-4 text-[var(--surface-foreground)]" />
          ) : (
            <RiBarChartBoxLine className="h-4 w-4 text-[var(--surface-foreground)]" />
          )}
          <h3 className="typography-ui-label font-semibold text-[var(--surface-foreground)]">Debug Panel</h3>
        </div>
        <div className="flex items-center gap-1">
          {activeTab === 'streaming' ? (
            <>
              <Button size="xs" variant="ghost" onClick={handleCopyStreamingDebug}>
                <RiFileCopyLine className="h-3.5 w-3.5" />
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
                <RiRefreshLine className="h-3.5 w-3.5" />
              </Button>
            </>
          ) : null}
          {onClose ? (
            <Button size="icon" variant="ghost" className="h-6 w-6" onClick={onClose}>
              <RiCloseLine className="h-4 w-4" />
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
          Memory
        </Button>
        <Button
          size="sm"
          variant={activeTab === 'streaming' ? 'secondary' : 'ghost'}
          className="flex-1"
          onClick={() => setActiveTab('streaming')}
        >
          Streaming
        </Button>
      </div>

      {activeTab === 'memory' ? (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2 typography-meta">
            <MetricCard label="Total Messages" value={totalMessages} />
            <MetricCard label="Cached Sessions" value={`${cachedSessionCount} / ${MEMORY_LIMITS.MAX_SESSIONS}`} />
          </div>

          <div className="typography-meta space-y-1 border-t border-[var(--interactive-border)] pt-2">
            <div className="flex justify-between gap-2">
              <span className="text-[var(--surface-muted-foreground)]">Viewport Window</span>
              <span className="text-[var(--surface-foreground)]">{getBackgroundTrimLimit()} messages</span>
            </div>
            <div className="flex justify-between gap-2">
              <span className="text-[var(--surface-muted-foreground)]">Zombie Timeout</span>
              <span className="text-[var(--surface-foreground)]">{MEMORY_LIMITS.ZOMBIE_TIMEOUT / 1000 / 60} minutes</span>
            </div>
            <div className="flex justify-between gap-2">
              <span className="text-[var(--surface-muted-foreground)]">GitHub Total Requests</span>
              <span className="text-[var(--surface-foreground)]">{totalGitHubRequests}</span>
            </div>
          </div>

          <div className="border-t border-[var(--interactive-border)] pt-2">
            <div className="mb-1 typography-meta font-semibold text-[var(--surface-foreground)]">Sessions in Memory</div>
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
                    {stat.isStreaming ? <RiPulseLine className="h-3 w-3 animate-pulse text-[var(--status-info)]" /> : null}
                    {stat.isZombie ? <span className="text-[var(--status-warning)]">!</span> : null}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[var(--surface-foreground)]">
                      {stat.messageCount} msgs
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
            <Tooltip delayDuration={1000}>
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
                      memoryStates: Object.fromEntries(sessionMemoryState),
                    });
                  }}
                >
                  Log State
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">Log current memory state to browser console</TooltipContent>
            </Tooltip>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2 rounded-md border border-[var(--interactive-border)] px-3 py-2 typography-meta text-[var(--surface-muted-foreground)]">
            <span>
              {copyState === 'copied'
                ? 'Streaming debug JSON copied'
                : copyState === 'error'
                  ? 'Failed to copy JSON'
                  : 'Copy exports both UI and VS Code streaming metrics as JSON'}
            </span>
            <Button size="xs" variant="outline" onClick={handleCopyStreamingDebug}>
              Copy JSON
            </Button>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <MetricCard label="UI Metrics" value={streamSnapshot.entries.length} />
            <MetricCard label="VS Code Metrics" value={vscodeStreamSnapshot.entries.length} />
            <MetricCard label="MsgList Renders" value={streamMetricCounts.messageListRender} />
            <MetricCard label="MsgList Stream Renders" value={streamMetricCounts.messageListRenderStreaming} />
            <MetricCard label="ChatMessage Renders" value={streamMetricCounts.chatMessageRender} />
            <MetricCard label="ChatMessage Stream Renders" value={streamMetricCounts.chatMessageRenderStreaming} />
            <MetricCard label="ChatMessage Static During Stream" value={streamMetricCounts.chatMessageRenderStaticDuringStream} />
            <MetricCard
              label="ChatMessage Static Outside Active Turn"
              value={streamMetricCounts.chatMessageRenderStaticOutsideActiveTurnDuringStream}
            />
          </div>

          <PerfSection
            title="UI Streaming Metrics"
            snapshot={streamSnapshot}
            emptyLabel="No UI streaming samples yet. Start a stream and keep this panel open."
          />

          {vscodeStreamSnapshot.entries.length > 0 ? (
            <PerfSection
              title="VS Code Bridge Metrics"
              snapshot={vscodeStreamSnapshot}
              emptyLabel="No VS Code bridge samples yet."
            />
          ) : null}
        </div>
      )}
    </Card>
  );
};

export const MemoryDebugPanel = DebugPanel;
