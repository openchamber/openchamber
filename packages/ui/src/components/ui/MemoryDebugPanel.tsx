import React from 'react';
import { useSessionStore, MEMORY_LIMITS } from '@/stores/useSessionStore';
import { useGitHubPrStatusStore } from '@/stores/useGitHubPrStatusStore';
import { getMessageLimit, getBackgroundTrimLimit } from '@/stores/types/sessionTypes';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { RiCloseLine, RiDatabase2Line, RiPulseLine } from '@remixicon/react';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';

interface MemoryDebugPanelProps {
  onClose?: () => void;
}

export const MemoryDebugPanel: React.FC<MemoryDebugPanelProps> = ({ onClose }) => {
  const {
    sessions,
    messages,
    sessionMemoryState,
    currentSessionId,
  } = useSessionStore();
  const totalGitHubRequests = useGitHubPrStatusStore((state) => state.totalRequestCount);

  const totalMessages = React.useMemo(() => {
    let total = 0;
    messages.forEach((sessionMessages) => {
      total += sessionMessages.length;
    });
    return total;
  }, [messages]);

  const sessionStats = React.useMemo(() => {
    return sessions.map(session => {
      const messageCount = messages.get(session.id)?.length || 0;
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
  }, [sessions, messages, sessionMemoryState, currentSessionId]);

  const cachedSessionCount = messages.size;

  return (
    <Card className="fixed bottom-4 right-4 w-96 p-4 shadow-none z-50 bg-background/95 backdrop-blur bottom-safe-area">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <RiDatabase2Line className="h-4 w-4" />
          <h3 className="font-semibold typography-ui-label">Memory Debug Panel</h3>
        </div>
        {onClose && (
          <Button
            size="icon"
            variant="ghost"
            className="h-6 w-6"
            onClick={onClose}
          >
            <RiCloseLine className="h-4 w-4" />
          </Button>
        )}
      </div>

      <div className="space-y-3">
        {}
        <div className="grid grid-cols-2 gap-2 typography-meta">
          <div className="bg-muted/50 rounded p-2">
            <div className="text-muted-foreground">Total Messages</div>
            <div className="typography-markdown font-semibold">{totalMessages}</div>
          </div>
          <div className="bg-muted/50 rounded p-2">
            <div className="text-muted-foreground">Cached Sessions</div>
            <div className="typography-markdown font-semibold">{cachedSessionCount} / {MEMORY_LIMITS.MAX_SESSIONS}</div>
          </div>
        </div>

        {null}

        {}
        <div className="typography-meta space-y-1 border-t pt-2">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Viewport Window:</span>
            <span>{getBackgroundTrimLimit()} messages</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Zombie Timeout:</span>
            <span>{MEMORY_LIMITS.ZOMBIE_TIMEOUT / 1000 / 60} minutes</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">GitHub Total Requests:</span>
            <span>{totalGitHubRequests}</span>
          </div>
        </div>

        {}
        <div className="border-t pt-2">
          <div className="typography-meta font-semibold mb-1">Sessions in Memory:</div>
          <ScrollableOverlay outerClassName="max-h-48" className="space-y-1 pr-1">
            {sessionStats.map(stat => (
              <div
                key={stat.id}
                className={`typography-meta p-1.5 rounded flex items-center justify-between ${
                  stat.isCurrent ? 'bg-primary/10' : 'bg-muted/30'
                }`}
              >
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  <span className="truncate">{stat.title}</span>
                  {stat.isStreaming && (
                    <RiPulseLine className="h-3 w-3 text-primary animate-pulse" />
                  )}
                  {stat.isZombie && (
                    <span className="text-status-warning">!</span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <span className={`font-mono ${
                    stat.messageCount > getMessageLimit() ? 'text-status-warning' : ''
                  }`}>
                    {stat.messageCount} msgs
                  </span>
                  {stat.backgroundCount > 0 && (
                    <span className="text-primary">+{stat.backgroundCount}</span>
                  )}
                </div>
              </div>
            ))}
          </ScrollableOverlay>
        </div>

        <div className="flex gap-2 pt-2 border-t">
          <Tooltip delayDuration={1000}>
            <TooltipTrigger asChild>
              <Button
                size="sm"
                variant="outline"
                className="typography-meta"
                onClick={() => {
                  console.log('[MemoryDebug] Session store state:', {
                    sessions: sessions.map(s => ({ id: s.id, title: s.title })),
                    currentSessionId,
                    cachedSessions: Array.from(messages.keys()),
                    memoryStates: Object.fromEntries(sessionMemoryState),
                  });
                }}
              >
                Log State
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">
              Log current memory state to browser console
            </TooltipContent>
          </Tooltip>
        </div>
      </div>
    </Card>
  );
};
