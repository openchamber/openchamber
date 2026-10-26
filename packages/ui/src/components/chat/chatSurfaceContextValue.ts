import React from 'react';

/**
 * 'mini-chat' is the browser-panel side chat (compact, no fork/plan actions).
 * 'peek' is a read-only glance surface (the /btw panel): messages render with
 * no per-message controls at all — no user action row, no assistant action
 * buttons, no turn footer.
 */
export type ChatSurfaceMode = 'default' | 'mini-chat' | 'peek';

export const ChatSurfaceContext = React.createContext<ChatSurfaceMode>('default');
