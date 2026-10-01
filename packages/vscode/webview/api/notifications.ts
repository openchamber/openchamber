import type { NotificationPayload, NotificationsAPI } from '@openchamber/ui/lib/api/types';
import { sendBridgeMessage } from './bridge';

/**
 * VS Code runtime notifications.
 *
 * The browser `Notification` API can never display from a VS Code webview
 * (subframe, not the top-level browsing context), so delivery is delegated to
 * the extension host over `api:notifications:show`, which uses
 * `vscode.window.show*Message`. The boolean resolves to the host's real
 * outcome, so the Settings test button reports honestly instead of always
 * claiming success.
 */
export const createVSCodeNotificationsAPI = (): NotificationsAPI => ({
  async notifyAgentCompletion(payload?: NotificationPayload): Promise<boolean> {
    try {
      const result = await sendBridgeMessage<{ shown?: boolean }>('api:notifications:show', {
        title: payload?.title,
        body: payload?.body,
        tag: payload?.tag,
        kind: payload?.kind ?? 'completion',
        sessionId: payload?.sessionId,
        requireHidden: payload?.requireHidden,
      });
      return result?.shown !== false;
    } catch {
      return false;
    }
  },

  async canNotify(): Promise<boolean> {
    return true;
  },
});
