import React from 'react';

import { invokeDesktopCommand } from '@/lib/desktopNative';

const AGENT_INPUT_ACTIONS = new Set(['browser.click', 'browser.hover', 'browser.drag', 'browser.type', 'browser.press', 'browser.select', 'browser.upload', 'browser.dialog']);

export const useAgentInputMark = (webviewRef: React.RefObject<WebviewElement | null>) => React.useCallback(
  async <T,>(action: string, actingSessionId: string | null, run: () => Promise<T>): Promise<T> => {
    if (!AGENT_INPUT_ACTIONS.has(action)) return run();
    let webContentsId = -1;
    try {
      webContentsId = webviewRef.current?.getWebContentsId() ?? -1;
    } catch {
      return run();
    }
    if (webContentsId < 0) return run();
    const mark = (active: boolean) => invokeDesktopCommand('desktop_browser_agent_action', { webContentsId, active, sessionId: actingSessionId })
      .catch(() => undefined);
    await mark(true);
    try {
      return await run();
    } finally {
      void mark(false);
    }
  },
  [webviewRef],
);
