import type { TerminalAPI } from './api/types';

export const waitForTerminalExit = (
  terminal: TerminalAPI,
  sessionId: string,
  timeoutMs: number,
): Promise<boolean> => new Promise((resolve) => {
  let settled = false;
  let subscription: { close: () => void } | null = null;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const finish = (exited: boolean) => {
    if (settled) return;
    settled = true;
    if (timeout) clearTimeout(timeout);
    subscription?.close();
    resolve(exited);
  };
  subscription = terminal.connect(sessionId, {
    onEvent: (event) => {
      if (event.type === 'exit' || (event.type === 'snapshot' && event.status === 'exited')) finish(true);
    },
    onError: (_error, fatal) => { if (fatal) finish(true); },
  });
  if (settled) subscription.close();
  else timeout = setTimeout(() => finish(false), timeoutMs);
});
