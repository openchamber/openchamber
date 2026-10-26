import { createContext } from 'react';

import type { ToolPart } from '@/lib/opencode/model';

/** Only the final message splits its non-text parts from its answer/footer. */
export const LiveFinalActivityContext = createContext<{
    messageId: string;
    expanded: boolean;
    contentId: string;
    animateCollapse: boolean;
    /** Pages the turn's agent showed, drawn above the answer instead of inside the fold. */
    pages: readonly ToolPart[];
} | null>(null);

/** Calls whose page the final answer draws, so their own row stays out of the fold. */
export const LiveTurnHoistedPagesContext = createContext<ReadonlySet<string> | null>(null);
