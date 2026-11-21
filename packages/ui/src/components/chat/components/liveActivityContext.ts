import { createContext } from 'react';

import type { ShownPart } from '../lib/turns/liveActivity';

export const LiveFinalActivityContext = createContext<{
    messageId: string;
    expanded: boolean;
    contentId: string;
    pages: readonly ShownPart[];
} | null>(null);

export const LiveTurnHoistedPagesContext = createContext<ReadonlySet<string> | null>(null);

export const LiveActivityInteractionContext = createContext<{
    hold: () => void;
    release: () => void;
    pagesShown: boolean;
} | null>(null);
