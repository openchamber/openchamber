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
    /** Why a failed row failed, shown while it stays collapsed. Only `!command` rows pass one. */
    failureReason?: string;
}

/** Header extras of a row whose state comes from outside its own part: a label, and a stop action while it runs. */
export type ToolRowHeader = {
    label?: 'background' | 'stopped';
    /** The end of the call is not known yet, so the row shows no duration. */
    durationUnknown?: boolean;
    stop?: { onStop: () => void; ariaLabel: string };
};
