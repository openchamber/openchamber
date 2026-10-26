import React from 'react';
import { ChatSurfaceContext, type ChatSurfaceMode } from './chatSurfaceContextValue';

export const useChatSurfaceMode = (): ChatSurfaceMode => React.useContext(ChatSurfaceContext);
