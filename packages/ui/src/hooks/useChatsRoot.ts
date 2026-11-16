import React from 'react';
import { getChatsRoot, subscribeChatsRoot } from '@/lib/chatDirectories';

export const useChatsRoot = (): string | null => React.useSyncExternalStore(subscribeChatsRoot, getChatsRoot, getChatsRoot);
