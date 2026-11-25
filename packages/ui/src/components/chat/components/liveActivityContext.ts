import { createContext } from 'react';

import type { ShownPart } from '../lib/turns/liveActivity';
import type { StreamPhase } from '../message/types';

export const LiveFinalActivityContext = createContext<{
    messageId: string;
    expanded: boolean;
    contentId: string;
    pages: readonly ShownPart[];
} | null>(null);

export const LiveTurnHoistedPagesContext = createContext<ReadonlySet<string> | null>(null);

export const ShownPartStreamPhaseContext = createContext<(messageId: string) => StreamPhase>(() => 'completed');

export const LiveActivityInteractionContext = createContext<{
    hold: () => void;
    release: () => void;
    pagesShown: boolean;
} | null>(null);
