import { z } from 'zod';


const DUPLICATE_WINDOW_MS = 10_000;

export const sessionNotificationSchema = z.object({
  title: z.string().trim().optional(),
  body: z.string().trim().optional(),
  sessionId: z.string().trim().optional(),
  requireHidden: z.boolean().optional(),
});

export type SessionNotification = z.infer<typeof sessionNotificationSchema>;

type SessionNotifierDeps = {
  isChatAttended: () => boolean;
  show: (message: string, ...actions: string[]) => PromiseLike<string | undefined>;
  openSession: (sessionId: string) => void | Promise<void>;
  openSessionLabel: string;
  now?: () => number;
};

export function createSessionNotifier(deps: SessionNotifierDeps) {
  const now = deps.now ?? Date.now;
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
