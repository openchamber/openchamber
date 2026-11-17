import type { FilePart, Metadata, ToolInput, ToolPart as ToolPartType, ToolState as ToolStateUnion } from '@/lib/opencode/model';
import type { ToolPopupContent } from '../../types';

export type ToolJsonViewMode = 'summary' | 'formatted' | 'raw';

export type ToolStateWithMetadata = ToolStateUnion & { metadata?: Metadata; input?: ToolInput; output?: string; error?: string; time?: { start: number; end?: number }; attachments?: Array<FilePart> };

export interface ToolPartProps {
    part: ToolPartType;
    isExpanded: boolean;
    onToggle: (toolId: string) => void;
    isMobile: boolean;
    alwaysShowActions?: boolean;
    onShowPopup?: (content: ToolPopupContent) => void;
    animateTailText?: boolean;
    failureReason?: string;
}

export type ToolRowHeader = {
    label?: 'background' | 'stopped';
    durationUnknown?: boolean;
    stop?: { onStop: () => void; ariaLabel: string };
};
