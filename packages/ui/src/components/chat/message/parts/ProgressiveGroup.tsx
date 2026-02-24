import React from 'react';
import { RiArrowDownSLine, RiArrowRightSLine, RiStackLine } from '@remixicon/react';
import { cn } from '@/lib/utils';
import type { TurnActivityPart } from '../../hooks/useTurnGrouping';
import type { ToolPart as ToolPartType } from '@opencode-ai/sdk/v2';
import type { ContentChangeReason } from '@/hooks/useChatScrollManager';
import type { ToolPopupContent } from '../types';
import ToolPart from './ToolPart';
import ReasoningPart from './ReasoningPart';
import JustificationBlock from './JustificationBlock';
import { FadeInOnReveal } from '../FadeInOnReveal';

const MAX_VISIBLE_COLLAPSED = 6;

interface DiffStats {
    additions: number;
    deletions: number;
    files: number;
}

interface ProgressiveGroupProps {
    parts: TurnActivityPart[];
    isExpanded: boolean;
    onToggle: () => void;
    syntaxTheme: Record<string, React.CSSProperties>;
    isMobile: boolean;
    expandedTools: Set<string>;
    onToggleTool: (toolId: string) => void;
    onShowPopup: (content: ToolPopupContent) => void;
    onContentChange?: (reason?: ContentChangeReason) => void;
    diffStats?: DiffStats;
}

const sortPartsByTime = (parts: TurnActivityPart[]): TurnActivityPart[] => {
    return [...parts].sort((a, b) => {
        const aTime = typeof a.endedAt === 'number' ? a.endedAt : undefined;
        const bTime = typeof b.endedAt === 'number' ? b.endedAt : undefined;

        if (aTime === undefined && bTime === undefined) return 0;
        if (aTime === undefined) return 1;
        if (bTime === undefined) return -1;

        return aTime - bTime;
    });
};

const getToolConnections = (
    parts: TurnActivityPart[]
): Record<string, { hasPrev: boolean; hasNext: boolean }> => {
    const connections: Record<string, { hasPrev: boolean; hasNext: boolean }> = {};
    const toolParts = parts.filter((p) => p.kind === 'tool');

    toolParts.forEach((activity, index) => {
        const partId = activity.id;
        connections[partId] = {
            hasPrev: index > 0,
            hasNext: index < toolParts.length - 1,
        };
    });

    return connections;
};

const ProgressiveGroup: React.FC<ProgressiveGroupProps> = ({
    parts,
    isExpanded,
    onToggle,
    syntaxTheme,
    isMobile,
    expandedTools,
    onToggleTool,
    onShowPopup,
    onContentChange,
    diffStats,
}) => {
    const previousExpandedRef = React.useRef<boolean | undefined>(isExpanded);
    // Track if we just expanded from collapsed state
    const [justExpandedFromCollapsed, setJustExpandedFromCollapsed] = React.useState(false);

    const [expansionKey, setExpansionKey] = React.useState(0);

    // Track which parts have already been shown in collapsed view (for fade-in animation)
    const shownInCollapsedRef = React.useRef<Set<string>>(new Set());

    React.useEffect(() => {
        if (previousExpandedRef.current === isExpanded) return;
        const wasCollapsed = previousExpandedRef.current === false;
        previousExpandedRef.current = isExpanded;
        onContentChange?.('structural');

        if (isExpanded && wasCollapsed) {
            setExpansionKey((k) => k + 1);
            setJustExpandedFromCollapsed(true);
            // Clear collapsed tracking when expanding (will restart when collapsed again)
            shownInCollapsedRef.current.clear();
            // Reset after a short delay (after animations would have started)
            const timer = setTimeout(() => setJustExpandedFromCollapsed(false), 50);
            return () => clearTimeout(timer);
        } else {
            setJustExpandedFromCollapsed(false);
        }
    }, [isExpanded, onContentChange]);

    const displayParts = React.useMemo(() => {
        return sortPartsByTime(parts);
    }, [parts]);

    const toolConnections = getToolConnections(displayParts);

    // For collapsed state: show last N items
    const visibleCollapsedParts = React.useMemo(() => {
        return displayParts.slice(-MAX_VISIBLE_COLLAPSED);
    }, [displayParts]);

    // Set of part IDs that were visible in collapsed state
    const visibleInCollapsedIds = React.useMemo(() => {
        const ids = new Set<string>();
        visibleCollapsedParts.forEach((p) => {
            ids.add(p.id);
        });
        return ids;
    }, [visibleCollapsedParts]);

    // Connections for collapsed view (based on visible parts only)
    const collapsedToolConnections = React.useMemo(() => {
        return getToolConnections(visibleCollapsedParts);
    }, [visibleCollapsedParts]);

    const hiddenCount = Math.max(0, displayParts.length - MAX_VISIBLE_COLLAPSED);

    if (displayParts.length === 0) {
        return null;
    }

    const partsToRender = isExpanded ? displayParts : visibleCollapsedParts;
    const connectionsToUse = isExpanded ? toolConnections : collapsedToolConnections;

    // If there are no hidden items, header is not interactive
    const isHeaderInteractive = hiddenCount > 0;

    return (
        <FadeInOnReveal>
            <div className="my-1">
                <div
                    className={cn(
                        'group/tool flex items-center gap-2 pr-2 pl-px pt-0 pb-1.5 rounded-xl',
                        isHeaderInteractive && 'cursor-pointer'
                    )}
                    onClick={isHeaderInteractive ? onToggle : undefined}
                >
                    <div className="flex items-center gap-2 flex-shrink-0">
                        <div className="relative h-3.5 w-3.5 flex-shrink-0">
                            {isHeaderInteractive ? (
                                <>
                                    <div
                                        className={cn(
                                            'absolute inset-0 transition-opacity',
                                            isExpanded && 'opacity-0',
                                            !isExpanded && !isMobile && 'group-hover/tool:opacity-0'
                                        )}
                                        style={{ color: 'var(--tools-icon)' }}
                                    >
                                        <RiStackLine className="h-3.5 w-3.5" />
                                    </div>
                                    <div
                                        className={cn(
                                            'absolute inset-0 transition-opacity flex items-center justify-center',
                                            isExpanded && 'opacity-100',
                                            !isExpanded && isMobile && 'opacity-0',
                                            !isExpanded && !isMobile && 'opacity-0 group-hover/tool:opacity-100'
                                        )}
                                    >
                                        {isExpanded ? (
                                            <RiArrowDownSLine className="h-3.5 w-3.5" />
                                        ) : (
                                            <RiArrowRightSLine className="h-3.5 w-3.5" />
                                        )}
                                    </div>
                                </>
                            ) : (
                                <RiStackLine className="h-3.5 w-3.5" style={{ color: 'var(--tools-icon)' }} />
                            )}
                        </div>
                        <span className="typography-meta font-medium" style={{ color: 'var(--tools-title)' }}>Activity</span>
                    </div>

                    {diffStats && (diffStats.additions > 0 || diffStats.deletions > 0) && (
                        <div className="flex-1 min-w-0 typography-meta text-muted-foreground/70 flex items-center gap-2">
                            <span className="flex-shrink-0 leading-none">
                                <span className="text-[color:var(--status-success)]">
                                    +{Math.max(0, diffStats.additions)}
                                </span>
                                <span className="text-muted-foreground/50">/</span>
                                <span className="text-destructive">
                                    -{Math.max(0, diffStats.deletions)}
                                </span>
                            </span>
                        </div>
                    )}
                </div>

                <div
                    className={cn(
                        'relative pr-2 pb-1 pt-1 pl-[1.4375rem]'
                    )}
                >
                    <div 
                        className="absolute left-[0.4375rem] w-px top-[-0.25rem] bottom-0"
                        style={{ backgroundColor: 'var(--tools-border)', borderWidth: '0', width: '1px' }}
                    ></div>
                    {!isExpanded && hiddenCount > 0 && (
                        <div
                            className="typography-micro text-muted-foreground/70 mb-1 cursor-pointer hover:text-muted-foreground"
                            onClick={onToggle}
                        >
                            +{hiddenCount} more...
                        </div>
                    )}

                    {partsToRender.map((activity) => {
                        const partId = activity.id;
                        const connection = connectionsToUse[partId];

                        const animationKey = `${partId}-exp${expansionKey}`;

                        // Determine if animation should be skipped:
                        // 1. When expanding from collapsed: skip for items that were already visible
                        // 2. When collapsed: skip for items already shown before (track in ref)
                        const wasVisibleInCollapsed = visibleInCollapsedIds.has(activity.id);
                        
                        let skipAnimation = false;
                        if (justExpandedFromCollapsed && wasVisibleInCollapsed) {
                            // Expanding: don't animate items that were already visible in collapsed state
                            skipAnimation = true;
                        } else if (!isExpanded) {
                            // Collapsed: animate only items that haven't been shown yet
                            if (shownInCollapsedRef.current.has(activity.id)) {
                                skipAnimation = true;
                            } else {
                                // Mark as shown for future renders
                                shownInCollapsedRef.current.add(activity.id);
                            }
                        }

                        switch (activity.kind) {
                            case 'tool':
                                return (
                                    <FadeInOnReveal key={animationKey} skipAnimation={skipAnimation}>
                                        <ToolPart
                                            part={activity.part as ToolPartType}
                                            isExpanded={expandedTools.has(partId)}
                                            onToggle={() => onToggleTool(partId)}
                                            syntaxTheme={syntaxTheme}
                                            isMobile={isMobile}
                                            onContentChange={onContentChange}
                                            onShowPopup={onShowPopup}
                                            hasPrevTool={connection?.hasPrev ?? false}
                                            hasNextTool={connection?.hasNext ?? false}
                                        />
                                    </FadeInOnReveal>
                                );

                            case 'reasoning':
                                return (
                                    <FadeInOnReveal key={animationKey} skipAnimation={skipAnimation}>
                                        <ReasoningPart
                                            part={activity.part}
                                            messageId={activity.messageId}
                                            onContentChange={onContentChange}
                                        />
                                    </FadeInOnReveal>
                                );

                            case 'justification':
                                return (
                                    <FadeInOnReveal key={animationKey} skipAnimation={skipAnimation}>
                                        <JustificationBlock
                                            part={activity.part}
                                            messageId={activity.messageId}
                                            onContentChange={onContentChange}
                                        />
                                    </FadeInOnReveal>
                                );

                            default:
                                return null;
                        }
                    })}
                </div>
            </div>
        </FadeInOnReveal>
    );
};

export default React.memo(ProgressiveGroup);
