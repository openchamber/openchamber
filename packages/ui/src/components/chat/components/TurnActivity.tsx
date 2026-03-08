import React from 'react';

import ProgressiveGroup from '../message/parts/ProgressiveGroup';
import type { TurnActivityRecord } from '../lib/turns/types';
import type { ToolPopupContent } from '../message/types';
import type { StreamPhase } from '../message/types';
import type { ContentChangeReason } from '@/hooks/useChatScrollManager';

interface DiffStats {
    additions: number;
    deletions: number;
    files: number;
}

interface TurnActivityProps {
    parts: TurnActivityRecord[];
    isExpanded: boolean;
    onToggle: () => void;
    syntaxTheme: Record<string, React.CSSProperties>;
    isMobile: boolean;
    expandedTools: Set<string>;
    onToggleTool: (toolId: string) => void;
    onShowPopup: (content: ToolPopupContent) => void;
    onContentChange?: (reason?: ContentChangeReason) => void;
    streamPhase: StreamPhase;
    showHeader: boolean;
    animateRows?: boolean;
    diffStats?: DiffStats;
}

const TurnActivity: React.FC<TurnActivityProps> = (props) => {
    return <ProgressiveGroup {...props} />;
};

export default React.memo(TurnActivity);
