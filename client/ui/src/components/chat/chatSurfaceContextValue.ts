import React from 'react';

export type ChatSurfaceMode = 'default' | 'mini-chat';

export const ChatSurfaceContext = React.createContext<ChatSurfaceMode>('default');
