import { z } from 'zod';

/**
 * Extension-host delivery of OpenChamber notifications (finished turn, error,
 * question). The webview decides which events notify and with what text; it
 * cannot show anything itself, because Chromium never displays a
 * `new Notification()` from a VS Code webview frame. Kept free of the `vscode`
 * dependency so it can be unit tested; `extension.ts` wires the VS Code calls.
 */

const DUPLICATE_WINDOW_MS = 10_000;

/** The `api:notifications:show` bridge payload. */
export const sessionNotificationSchema = z.object({
  title: z.string().trim().optional(),
  body: z.string().trim().optional(),
  sessionId: z.string().trim().optional(),
  requireHidden: z.boolean().optional(),
});

export type SessionNotification = z.infer<typeof sessionNotificationSchema>;

type SessionNotifierDeps = {
  /** VS Code is focused and an OpenChamber chat (sidebar or session tab) is on screen. */
  isChatAttended: () => boolean;
  /** Shows the message; resolves with the picked action, or undefined when dismissed. */
  show: (message: string, ...actions: string[]) => PromiseLike<string | undefined>;
  openSession: (sessionId: string) => void | Promise<void>;
  openSessionLabel: string;
  now?: () => number;
};

/** Returns a function that shows one notification and reports whether it did. */
export function createSessionNotifier(deps: SessionNotifierDeps) {
  const now = deps.now ?? Date.now;
  // Every open OpenChamber webview sees the same session event and asks to
  // notify; the first request for a session message wins.
  const recent = new Map<string, number>();

  const isDuplicate = (key: string): boolean => {
    const at = now();
    for (const [claimed, claimedAt] of recent) {
      if (at - claimedAt > DUPLICATE_WINDOW_MS) recent.delete(claimed);
    }
    if (recent.has(key)) return true;
    recent.set(key, at);
    return false;
  };

  return ({ title, body, sessionId, requireHidden }: SessionNotification): boolean => {
    if (requireHidden && deps.isChatAttended()) return false;
    if (sessionId && isDuplicate([sessionId, title, body].join('|'))) return false;

    const message = [title || 'OpenChamber', body].filter(Boolean).join(': ');
    if (!sessionId) {
      void deps.show(message);
      return true;
    }
    void Promise.resolve(deps.show(message, deps.openSessionLabel)).then((picked) => {
      if (picked === deps.openSessionLabel) return deps.openSession(sessionId);
    });
    return true;
  };
}
