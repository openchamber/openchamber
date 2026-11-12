import React from 'react';
import { getChatsRoot, subscribeChatsRoot } from '@/lib/chatDirectories';

/** The chats root the server named for this runtime, or null until it has. */
export const useChatsRoot = (): string | null => React.useSyncExternalStore(subscribeChatsRoot, getChatsRoot, getChatsRoot);
