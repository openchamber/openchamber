import { createContext } from 'react';

import type { MessageSlice } from '../lib/turns/timelineRows';

export const MessageSliceContext = createContext<MessageSlice | null>(null);
