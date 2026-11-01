import { createContext } from 'react';

import type { MessageSlice } from '../lib/turns/timelineRows';

/**
 * The part of its message a transcript row draws, when a long answer spans
 * several rows (`timelineRows.ts`); null draws the whole message.
 */
export const MessageSliceContext = createContext<MessageSlice | null>(null);
