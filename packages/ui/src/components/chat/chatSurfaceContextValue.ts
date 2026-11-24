import React from 'react';

export type ChatSurfaceMode = 'default' | 'mini-chat' | 'peek';

export const ChatSurfaceContext = React.createContext<ChatSurfaceMode>('default');
