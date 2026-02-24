import React from 'react';
import { useSessionStore } from '@/stores/useSessionStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import type { Session } from '@opencode-ai/sdk/v2';
import { cn } from '@/lib/utils';
import { getAgentColor } from '@/lib/agentColors';
import { RiLoader4Line } from '@remixicon/react';
import type { SessionContextUsage } from '@/stores/types/sessionTypes';
import { useDrawer } from '@/contexts/DrawerContext';
import { animate } from 'motion/react';

interface MobileSessionStatusBarProps {
  onSessionSwitch?: (sessionId: string) => void;
  cornerRadius?: number;
}

interface SessionWithStatus extends Session {
  _statusType?: 'busy' | 'retry' | 'idle';
  _hasRunningChildren?: boolean;
  _runningChildrenCount?: number;
  _childIndicators?: Array<{ session: Session; isRunning: boolean }>;
}

function useSessionGrouping(
  sessions: Session[],
  sessionStatus: Map<string, { type: string }> | undefined,
  sessionAttentionStates: Map<string, { needsAttention: boolean }> | undefined
) {
  const parentChildMap = React.useMemo(() => {
    const map = new Map<string, Session[]>();
    const allIds = new Set(sessions.map((s) => s.id));

    sessions.forEach((session) => {
      const parentID = (session as { parentID?: string }).parentID;
      if (parentID && allIds.has(parentID)) {
        map.set(parentID, [...(map.get(parentID) || []), session]);
      }
    });
    return map;
  }, [sessions]);

  const getStatusType = React.useCallback((sessionId: string): 'busy' | 'retry' | 'idle' => {
    const status = sessionStatus?.get(sessionId);
    if (status?.type === 'busy' || status?.type === 'retry') return status.type;
    return 'idle';
  }, [sessionStatus]);

  const hasRunningChildren = React.useCallback((sessionId: string): boolean => {
    const children = parentChildMap.get(sessionId) || [];
    return children.some((child) => getStatusType(child.id) !== 'idle');
  }, [parentChildMap, getStatusType]);

  const getRunningChildrenCount = React.useCallback((sessionId: string): number => {
    const children = parentChildMap.get(sessionId) || [];
    return children.filter((child) => getStatusType(child.id) !== 'idle').length;
  }, [parentChildMap, getStatusType]);

  const getChildIndicators = React.useCallback((sessionId: string): Array<{ session: Session; isRunning: boolean }> => {
    const children = parentChildMap.get(sessionId) || [];
    return children
      .filter((child) => getStatusType(child.id) !== 'idle')
      .map((child) => ({ session: child, isRunning: true }))
      .slice(0, 3);
  }, [parentChildMap, getStatusType]);

  const processedSessions = React.useMemo(() => {
    const topLevel = sessions.filter((session) => {
      const parentID = (session as { parentID?: string }).parentID;
      return !parentID || !new Set(sessions.map((s) => s.id)).has(parentID);
    });

    const running: SessionWithStatus[] = [];
    const viewed: SessionWithStatus[] = [];

    topLevel.forEach((session) => {
      const statusType = getStatusType(session.id);
      const hasRunning = hasRunningChildren(session.id);
      const attention = sessionAttentionStates?.get(session.id)?.needsAttention ?? false;

      const enriched: SessionWithStatus = {
        ...session,
        _statusType: statusType,
        _hasRunningChildren: hasRunning,
        _runningChildrenCount: getRunningChildrenCount(session.id),
        _childIndicators: getChildIndicators(session.id),
      };

      if (statusType !== 'idle' || hasRunning) {
        running.push(enriched);
      } else if (attention) {
        running.push(enriched);
      } else {
        viewed.push(enriched);
      }
    });

    const sortByUpdated = (a: Session, b: Session) => {
      const aTime = (a as unknown as { time?: { updated?: number } }).time?.updated ?? 0;
      const bTime = (b as unknown as { time?: { updated?: number } }).time?.updated ?? 0;
      return bTime - aTime;
    };

    running.sort(sortByUpdated);
    viewed.sort(sortByUpdated);

    return [...running, ...viewed];
  }, [sessions, getStatusType, hasRunningChildren, getRunningChildrenCount, getChildIndicators, sessionAttentionStates]);

  const totalRunning = processedSessions.reduce((sum, s) => {
    const selfRunning = s._statusType !== 'idle' ? 1 : 0;
    return sum + selfRunning + (s._runningChildrenCount ?? 0);
  }, 0);

  const totalUnread = processedSessions.filter((s) => sessionAttentionStates?.get(s.id)?.needsAttention ?? false).length;

  return { sessions: processedSessions, totalRunning, totalUnread, totalCount: processedSessions.length };
}

function useSessionHelpers(
  agents: Array<{ name: string }>,
  sessionStatus: Map<string, { type: string }> | undefined,
  sessionAttentionStates: Map<string, { needsAttention: boolean }> | undefined
) {
  const getSessionAgentName = React.useCallback((session: Session): string => {
    const agent = (session as { agent?: string }).agent;
    if (agent) return agent;

    const sessionAgentSelection = useSessionStore.getState().getSessionAgentSelection(session.id);
    if (sessionAgentSelection) return sessionAgentSelection;

    return agents[0]?.name ?? 'agent';
  }, [agents]);

  const getSessionTitle = React.useCallback((session: Session): string => {
    const title = session.title;
    if (title && title.trim()) return title;
    return 'New session';
  }, []);

  const isRunning = React.useCallback((sessionId: string): boolean => {
    const status = sessionStatus?.get(sessionId);
    return status?.type === 'busy' || status?.type === 'retry';
  }, [sessionStatus]);

  // Use server-authoritative attention state instead of local activity state
  const needsAttention = React.useCallback((sessionId: string): boolean => {
    return sessionAttentionStates?.get(sessionId)?.needsAttention ?? false;
  }, [sessionAttentionStates]);

  return { getSessionAgentName, getSessionTitle, isRunning, needsAttention };
}

function StatusIndicator({ isRunning, needsAttention }: { isRunning: boolean; needsAttention: boolean }) {
  if (isRunning) {
    return <RiLoader4Line className="h-2.5 w-2.5 animate-spin text-[var(--status-info)]" />;
  }
  if (needsAttention) {
    return <div className="h-1.5 w-1.5 rounded-full bg-[var(--status-error)]" />;
  }
  return <div className="h-1.5 w-1.5 rounded-full border border-[var(--surface-mutedForeground)]" />;
}

function RunningIndicator({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <span className="flex items-center gap-0.5 text-xs text-[var(--status-info)]">
      <RiLoader4Line className="h-3 w-3 animate-spin" />
      {count}
    </span>
  );
}

function UnreadIndicator({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <span className="flex items-center gap-0.5 text-xs text-[var(--status-error)]">
      <div className="h-1.5 w-1.5 rounded-full bg-[var(--status-error)]" />
      {count}
    </span>
  );
}

function SessionItem({
  session,
  isCurrent,
  getSessionAgentName,
  getSessionTitle,
  onClick,
  onDoubleClick,
  needsAttention
}: {
  session: SessionWithStatus;
  isCurrent: boolean;
  getSessionAgentName: (s: Session) => string;
  getSessionTitle: (s: Session) => string;
  onClick: () => void;
  onDoubleClick?: () => void;
  needsAttention: (sessionId: string) => boolean;
}) {
  const agentName = getSessionAgentName(session);
  const agentColor = getAgentColor(agentName);
  const extraCount = (session._runningChildrenCount || 0) + (session._statusType !== 'idle' ? 1 : 0) - 1 - (session._childIndicators?.length || 0);

  return (
    <button
      type="button"
      onClick={onClick}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onDoubleClick?.();
      }}
      className={cn(
        "flex items-center gap-0.5 px-1.5 py-px text-left transition-colors",
        "hover:bg-[var(--interactive-hover)] active:bg-[var(--interactive-selection)]",
        isCurrent && "bg-[var(--interactive-selection)]/30"
      )}
    >
      <div className="flex-shrink-0 w-3 flex items-center justify-center">
        <StatusIndicator
          isRunning={session._statusType !== 'idle'}
          needsAttention={needsAttention(session.id)}
        />
      </div>

      <div
        className="flex-shrink-0 h-1.5 w-1.5 rounded-full"
        style={{ backgroundColor: `var(${agentColor.var})` }}
      />

      <span className={cn(
        "text-[13px] truncate leading-tight",
        isCurrent ? "text-[var(--interactive-selection-foreground)] font-medium" : "text-[var(--surface-foreground)]"
      )}>
        {getSessionTitle(session)}
      </span>

      {(session._childIndicators?.length || 0) > 0 && (
        <div className="flex items-center gap-0.5 text-[var(--surface-mutedForeground)]">
          <span className="text-[10px]">[</span>
          <div className="flex items-center gap-0.5">
            {session._childIndicators!.map(({ session: child }) => {
              const childColor = getAgentColor(getSessionAgentName(child));
              return (
                <div
                  key={child.id}
                  className="flex-shrink-0"
                  title={`Sub-session: ${getSessionTitle(child)}`}
                >
                  <RiLoader4Line
                    className="h-2.5 w-2.5 animate-spin"
                    style={{ color: `var(${childColor.var})` }}
                  />
                </div>
              );
            })}
            {extraCount > 0 && (
              <span className="text-[10px] text-[var(--surface-mutedForeground)]">
                +{extraCount}
              </span>
            )}
          </div>
          <span className="text-[10px]">]</span>
        </div>
      )}
    </button>
  );
}

function TokenUsageIndicator({ contextUsage }: { contextUsage: SessionContextUsage | null }) {
  if (!contextUsage || contextUsage.totalTokens === 0) return null;

  const percentage = Math.min(contextUsage.percentage, 999);
  const colorClass =
    percentage >= 90 ? 'text-[var(--status-error)]' :
    percentage >= 75 ? 'text-[var(--status-warning)]' : 'text-[var(--status-success)]';

  return (
    <span className={cn("text-[11px] tabular-nums font-medium", colorClass)}>
      {percentage.toFixed(1)}%
    </span>
  );
}

function SessionStatusHeader({
  currentSessionTitle,
  onToggle
}: {
  currentSessionTitle: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="w-full flex items-center px-2 py-0 text-left transition-colors hover:bg-[var(--interactive-hover)]"
    >
      <span className="text-xs text-[var(--surface-foreground)] truncate leading-tight">
        {currentSessionTitle}
      </span>
    </button>
  );
}

// Hook for drawer swipe gestures on MobileSessionStatusBar
function useDrawerSwipe() {
  const drawer = useDrawer();
  const touchStartXRef = React.useRef(0);
  const touchStartYRef = React.useRef(0);
  const isHorizontalSwipeRef = React.useRef<boolean | null>(null);
  const isDraggingDrawerRef = React.useRef<'left' | 'right' | null>(null);

  const handleTouchStart = React.useCallback((e: React.TouchEvent) => {
    touchStartXRef.current = e.touches[0].clientX;
    touchStartYRef.current = e.touches[0].clientY;
    isHorizontalSwipeRef.current = null;
    isDraggingDrawerRef.current = null;
  }, []);

  const handleTouchMove = React.useCallback((e: React.TouchEvent) => {
    const currentX = e.touches[0].clientX;
    const currentY = e.touches[0].clientY;
    const deltaX = currentX - touchStartXRef.current;
    const deltaY = currentY - touchStartYRef.current;

    // Determine if this is a horizontal swipe
    if (isHorizontalSwipeRef.current === null) {
      if (Math.abs(deltaX) > 5 || Math.abs(deltaY) > 5) {
        isHorizontalSwipeRef.current = Math.abs(deltaX) > Math.abs(deltaY);
      }
    }

    if (isHorizontalSwipeRef.current === true) {
      e.preventDefault();

      const leftDrawerWidthPx = drawer.leftDrawerWidth.current || window.innerWidth * 0.85;
      const rightDrawerWidthPx = drawer.rightDrawerWidth.current || window.innerWidth * 0.85;

      // Determine which drawer to drag
      if (isDraggingDrawerRef.current === null) {
        if (drawer.leftDrawerOpen && deltaX > 10) {
          isDraggingDrawerRef.current = 'left';
        } else if (drawer.rightDrawerOpen && deltaX < -10) {
          isDraggingDrawerRef.current = 'right';
        } else if (!drawer.leftDrawerOpen && !drawer.rightDrawerOpen) {
          if (deltaX > 30) {
            isDraggingDrawerRef.current = 'left';
          } else if (deltaX < -30) {
            isDraggingDrawerRef.current = 'right';
          }
        }
      }

      // Real-time drawer position update (follow finger)
      if (isDraggingDrawerRef.current === 'left') {
        if (drawer.leftDrawerOpen) {
          // Closing: x goes from 0 to -width
          const progress = Math.max(0, Math.min(1, deltaX / leftDrawerWidthPx));
          drawer.leftDrawerX.set(-leftDrawerWidthPx * (1 - progress));
        } else {
          // Opening: x goes from -width to 0
          const progress = Math.max(0, Math.min(1, deltaX / leftDrawerWidthPx));
          drawer.leftDrawerX.set(-leftDrawerWidthPx + (leftDrawerWidthPx * progress));
        }
      }

      if (isDraggingDrawerRef.current === 'right') {
        if (drawer.rightDrawerOpen) {
          // Closing: x goes from 0 to width
          const progress = Math.max(0, Math.min(1, -deltaX / rightDrawerWidthPx));
          drawer.rightDrawerX.set(rightDrawerWidthPx * (1 - progress));
        } else {
          // Opening: x goes from width to 0
          const progress = Math.max(0, Math.min(1, -deltaX / rightDrawerWidthPx));
          drawer.rightDrawerX.set(rightDrawerWidthPx - (rightDrawerWidthPx * progress));
        }
      }
    }
  }, [drawer]);

  const handleTouchEnd = React.useCallback((e: React.TouchEvent) => {
    if (isHorizontalSwipeRef.current !== true) return;

    const endX = e.changedTouches[0].clientX;
    const deltaX = endX - touchStartXRef.current;
    const velocityThreshold = 500;
    const progressThreshold = 0.3;

    const leftDrawerWidthPx = drawer.leftDrawerWidth.current || window.innerWidth * 0.85;
    const rightDrawerWidthPx = drawer.rightDrawerWidth.current || window.innerWidth * 0.85;

    // Handle left drawer
    if (isDraggingDrawerRef.current === 'left') {
      const isOpen = drawer.leftDrawerOpen;
      const currentX = drawer.leftDrawerX.get();
      const progress = isOpen
        ? 1 - Math.abs(currentX) / leftDrawerWidthPx  // How much we've closed
        : 1 + currentX / leftDrawerWidthPx;           // How much we've opened

      const shouldComplete = progress > progressThreshold || Math.abs(deltaX * 10) > velocityThreshold;

      if (shouldComplete) {
        // Complete the action
        const targetX = isOpen ? -leftDrawerWidthPx : 0;
        animate(drawer.leftDrawerX, targetX, {
          type: "spring",
          stiffness: 400,
          damping: 35,
          mass: 0.8
        });
        drawer.setMobileLeftDrawerOpen(!isOpen);
      } else {
        // Snap back
        const targetX = isOpen ? 0 : -leftDrawerWidthPx;
        animate(drawer.leftDrawerX, targetX, {
          type: "spring",
          stiffness: 400,
          damping: 35,
          mass: 0.8
        });
      }

      isDraggingDrawerRef.current = null;
      return;
    }

    // Handle right drawer
    if (isDraggingDrawerRef.current === 'right') {
      const isOpen = drawer.rightDrawerOpen;
      const currentX = drawer.rightDrawerX.get();
      const progress = isOpen
        ? 1 - Math.abs(currentX) / rightDrawerWidthPx
        : 1 - currentX / rightDrawerWidthPx;

      const shouldComplete = progress > progressThreshold || Math.abs(deltaX * 10) > velocityThreshold;

      if (shouldComplete) {
        const targetX = isOpen ? rightDrawerWidthPx : 0;
        animate(drawer.rightDrawerX, targetX, {
          type: "spring",
          stiffness: 400,
          damping: 35,
          mass: 0.8
        });
        drawer.setRightSidebarOpen(!isOpen);
      } else {
        const targetX = isOpen ? 0 : rightDrawerWidthPx;
        animate(drawer.rightDrawerX, targetX, {
          type: "spring",
          stiffness: 400,
          damping: 35,
          mass: 0.8
        });
      }

      isDraggingDrawerRef.current = null;
      return;
    }

    isHorizontalSwipeRef.current = null;
  }, [drawer]);

  return {
    handleTouchStart,
    handleTouchMove,
    handleTouchEnd,
  };
}

function CollapsedView({
  runningCount,
  unreadCount,
  currentSessionTitle,
  onToggle,
  onNewSession,
  cornerRadius,
  contextUsage,
}: {
  runningCount: number;
  unreadCount: number;
  currentSessionTitle: string;
  onToggle: () => void;
  onNewSession: () => void;
  cornerRadius?: number;
  contextUsage: SessionContextUsage | null;
}) {
  const { handleTouchStart, handleTouchMove, handleTouchEnd } = useDrawerSwipe();

  return (
    <div
      className="w-full flex items-center justify-between px-2 border-b border-[var(--interactive-border)] bg-[var(--surface-muted)] order-first text-left overflow-hidden"
      style={{
        borderTopLeftRadius: cornerRadius,
        borderTopRightRadius: cornerRadius,
      }}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      <div className="flex-1 min-w-0 mr-1">
        <SessionStatusHeader
          currentSessionTitle={currentSessionTitle}
          onToggle={onToggle}
        />
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        <RunningIndicator count={runningCount} />
        <UnreadIndicator count={unreadCount} />
        <TokenUsageIndicator contextUsage={contextUsage} />
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onNewSession();
          }}
          className="flex items-center gap-0.5 px-1.5 py-1 text-[11px] leading-tight !min-h-0 rounded border border-border/50 text-[var(--surface-foreground)] hover:bg-[var(--interactive-hover)] self-center"
        >
          New
        </button>
      </div>
    </div>
  );
}

function ExpandedView({
  sessions,
  currentSessionId,
  runningCount,
  unreadCount,
  currentSessionTitle,
  isExpanded,
  onToggleCollapse,
  onToggleExpand,
  onNewSession,
  onSessionClick,
  onSessionDoubleClick,
  getSessionAgentName,
  getSessionTitle,
  needsAttention,
  cornerRadius,
  contextUsage,
}: {
  sessions: SessionWithStatus[];
  currentSessionId: string;
  runningCount: number;
  unreadCount: number;
  currentSessionTitle: string;
  isExpanded: boolean;
  onToggleCollapse: () => void;
  onToggleExpand: () => void;
  onNewSession: () => void;
  onSessionClick: (id: string) => void;
  onSessionDoubleClick?: () => void;
  getSessionAgentName: (s: Session) => string;
  getSessionTitle: (s: Session) => string;
  needsAttention: (sessionId: string) => boolean;
  cornerRadius?: number;
  contextUsage: SessionContextUsage | null;
}) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [collapsedHeight, setCollapsedHeight] = React.useState<number | null>(null);
  const [hasMeasured, setHasMeasured] = React.useState(false);
  const { handleTouchStart, handleTouchMove, handleTouchEnd } = useDrawerSwipe();

  React.useEffect(() => {
    if (containerRef.current && !hasMeasured && !isExpanded) {
      setCollapsedHeight(containerRef.current.offsetHeight);
      setHasMeasured(true);
    }
  }, [hasMeasured, isExpanded]);

  const previewHeight = collapsedHeight ?? undefined;
  const displaySessions = hasMeasured || isExpanded ? sessions : sessions.slice(0, 3);

  return (
    <div
      className="w-full border-b border-[var(--interactive-border)] bg-[var(--surface-muted)] order-first overflow-hidden"
      style={{
        borderTopLeftRadius: cornerRadius,
        borderTopRightRadius: cornerRadius,
      }}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      <div className="flex items-center justify-between px-2 py-0">
        <div className="flex-1 min-w-0 mr-1">
          <SessionStatusHeader
            currentSessionTitle={currentSessionTitle}
            onToggle={onToggleCollapse}
          />
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <RunningIndicator count={runningCount} />
          <UnreadIndicator count={unreadCount} />
          <TokenUsageIndicator contextUsage={contextUsage} />
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onNewSession();
              }}
              className="flex items-center gap-0.5 px-1.5 py-1 text-[11px] leading-tight !min-h-0 rounded border border-border/50 text-[var(--surface-foreground)] hover:bg-[var(--interactive-hover)] self-start"
            >
              New
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onToggleExpand();
              }}
              className="text-[11px] leading-tight px-1.5 py-1 !min-h-0 rounded border border-border/50 text-[var(--surface-mutedForeground)] hover:text-[var(--surface-foreground)] hover:bg-[var(--interactive-hover)] self-start"
            >
              {isExpanded ? 'Less' : 'More'}
            </button>
          </div>
        </div>
      </div>

      <div
        ref={containerRef}
        className="flex flex-col overflow-y-auto"
        style={{ maxHeight: isExpanded ? '60vh' : previewHeight }}
      >
        {displaySessions.map((session) => (
          <SessionItem
            key={session.id}
            session={session}
            isCurrent={session.id === currentSessionId}
            getSessionAgentName={getSessionAgentName}
            getSessionTitle={getSessionTitle}
            onClick={() => onSessionClick(session.id)}
            onDoubleClick={onSessionDoubleClick}
            needsAttention={needsAttention}
          />
        ))}
      </div>
    </div>
  );
}

export const MobileSessionStatusBar: React.FC<MobileSessionStatusBarProps> = ({
  onSessionSwitch,
  cornerRadius,
}) => {
  const sessions = useSessionStore((state) => state.sessions);
  const currentSessionId = useSessionStore((state) => state.currentSessionId);
  const sessionStatus = useSessionStore((state) => state.sessionStatus);
  const sessionAttentionStates = useSessionStore((state) => state.sessionAttentionStates);
  const setCurrentSession = useSessionStore((state) => state.setCurrentSession);
  const createSession = useSessionStore((state) => state.createSession);
  const getContextUsage = useSessionStore((state) => state.getContextUsage);
  const agents = useConfigStore((state) => state.agents);
  const { getCurrentModel } = useConfigStore();
  const { isMobile, isMobileSessionStatusBarCollapsed, setIsMobileSessionStatusBarCollapsed } = useUIStore();
  const setActiveMainTab = useUIStore((state) => state.setActiveMainTab);
  const [isExpanded, setIsExpanded] = React.useState(false);

  const { sessions: sortedSessions, totalRunning, totalUnread, totalCount } = useSessionGrouping(sessions, sessionStatus, sessionAttentionStates);
  const { getSessionAgentName, getSessionTitle, needsAttention } = useSessionHelpers(agents, sessionStatus, sessionAttentionStates);

  const currentSession = sessions.find((s) => s.id === currentSessionId);
  const currentSessionTitle = currentSession 
    ? getSessionTitle(currentSession) 
    : '← Swipe to open sidebars →';

  // Calculate token usage for current session
  const currentModel = getCurrentModel();
  const limit = currentModel && typeof currentModel.limit === 'object' && currentModel.limit !== null
    ? (currentModel.limit as Record<string, unknown>)
    : null;
  const contextLimit = (limit && typeof limit.context === 'number' ? limit.context : 0);
  const outputLimit = (limit && typeof limit.output === 'number' ? limit.output : 0);
  const contextUsage = getContextUsage(contextLimit, outputLimit);

  if (!isMobile || totalCount === 0) {
    return null;
  }

  const handleSessionClick = (sessionId: string) => {
    setCurrentSession(sessionId);
    onSessionSwitch?.(sessionId);
    setIsExpanded(false);
  };

  const handleSessionDoubleClick = () => {
    // On double-tap, switch to the Chat tab
    setActiveMainTab('chat');
  };

  const handleCreateSession = async () => {
    const newSession = await createSession();
    if (newSession) {
      setCurrentSession(newSession.id);
      onSessionSwitch?.(newSession.id);
    }
  };

  if (isMobileSessionStatusBarCollapsed) {
    return (
      <CollapsedView
        runningCount={totalRunning}
        unreadCount={totalUnread}
        currentSessionTitle={currentSessionTitle}
        onToggle={() => setIsMobileSessionStatusBarCollapsed(false)}
        onNewSession={handleCreateSession}
        cornerRadius={cornerRadius}
        contextUsage={contextUsage}
      />
    );
  }

  return (
    <ExpandedView
      sessions={sortedSessions}
      currentSessionId={currentSessionId ?? ''}
      runningCount={totalRunning}
      unreadCount={totalUnread}
      currentSessionTitle={currentSessionTitle}
      isExpanded={isExpanded}
      onToggleCollapse={() => {
        setIsMobileSessionStatusBarCollapsed(true);
        setIsExpanded(false);
      }}
      onToggleExpand={() => setIsExpanded(!isExpanded)}
      onNewSession={handleCreateSession}
      onSessionClick={handleSessionClick}
      onSessionDoubleClick={handleSessionDoubleClick}
      getSessionAgentName={getSessionAgentName}
      getSessionTitle={getSessionTitle}
      needsAttention={needsAttention}
      cornerRadius={cornerRadius}
      contextUsage={contextUsage}
    />
  );
};
