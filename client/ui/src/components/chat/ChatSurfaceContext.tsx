import React from 'react';
import { ChatSurfaceContext, type ChatSurfaceMode } from './chatSurfaceContextValue';

export const ChatSurfaceProvider: React.FC<{ mode: ChatSurfaceMode; children: React.ReactNode }> = ({ mode, children }) => {
  return <ChatSurfaceContext.Provider value={mode}>{children}</ChatSurfaceContext.Provider>;
};
