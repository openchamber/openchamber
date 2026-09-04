import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { useLatestSessionError } from '@/sync/notification-store';
import { useDirectoryStore, useSessionStatus } from '@/sync/sync-context';

interface SessionErrorNoticeProps {
  sessionId: string;
  directory?: string;
}

// How long a user message may sit unanswered on an idle session before the
// notice calls it a reply that never began.
const UNANSWERED_AFTER_MS = 5_000;

type LastMessageState = {
  role: string;
  timestamp: number;
  hasError: boolean;
} | null;

// The last message of a session, with whether it already carries an error of
// its own: an assistant message that OpenCode marked failed renders its error
// inline, so the session-level notice must not repeat it.
const useLastMessageState = (sessionId: string, directory?: string): LastMessageState => {
  const store = useDirectoryStore(directory);
  const cacheRef = React.useRef<LastMessageState>(null);
  const getSnapshot = React.useCallback((): LastMessageState => {
    if (!sessionId) return null;
    const messages = store.getState().message[sessionId];
    const last = messages && messages.length > 0 ? messages[messages.length - 1] : null;
    // SAFETY: store messages are SDK `Message` records; `error` is the optional
    // assistant-message error the SDK types carry, read here only for presence.
    const info = last as { role?: string; time?: { completed?: number; created?: number }; error?: unknown } | null;
    if (!info) {
      cacheRef.current = null;
      return null;
    }
    const next: LastMessageState = {
      role: typeof info.role === 'string' ? info.role : '',
      timestamp: info.time?.completed ?? info.time?.created ?? 0,
      hasError: Boolean(info.error),
    };
    const cached = cacheRef.current;
    if (cached && cached.role === next.role && cached.timestamp === next.timestamp && cached.hasError === next.hasError) {
      return cached;
    }
    cacheRef.current = next;
    return next;
  }, [sessionId, store]);
  const subscribe = React.useCallback((notify: () => void) => {
    if (!sessionId) return () => undefined;
    return store.subscribe(notify);
  }, [sessionId, store]);
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
};

/**
 * Shows what OpenCode reported when it stopped a turn without producing a
 * reply. Rendered under the last message, only while that turn is the latest
 * one: sending again moves the last message past the error and hides it.
 */
export const SessionErrorNotice: React.FC<SessionErrorNoticeProps> = ({ sessionId, directory }) => {
  const { t } = useI18n();
  const latestError = useLatestSessionError(sessionId);
  const status = useSessionStatus(sessionId, directory);
  const lastMessage = useLastMessageState(sessionId, directory);

  const isIdle = !status || status.type === 'idle';
  const reportedError = latestError && isIdle
    && (!lastMessage || latestError.time >= lastMessage.timestamp)
    && !(lastMessage?.role === 'assistant' && lastMessage.hasError)
    ? latestError
    : null;
  // A user message that the session is idle on, with nothing after it for a
  // while, is a reply that never began: the send was accepted but OpenCode
  // produced neither a message nor an error for it.
  const unansweredSince = !reportedError && isIdle && lastMessage?.role === 'user' ? lastMessage.timestamp : null;
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (unansweredSince === null) return undefined;
    const remaining = UNANSWERED_AFTER_MS - (Date.now() - unansweredSince);
    if (remaining <= 0) return undefined;
    const timer = window.setTimeout(() => setNow(Date.now()), remaining + 50);
    return () => window.clearTimeout(timer);
  }, [unansweredSince]);
  const unanswered = unansweredSince !== null && Math.max(now, Date.now()) - unansweredSince >= UNANSWERED_AFTER_MS;

  if (!reportedError && !unanswered) return null;

  const detail = reportedError
    ? (reportedError.error?.message ?? t('chat.sessionError.noDetails'))
    : t('chat.sessionError.noDetails');
  const name = reportedError?.error?.name;

  return (
    <div className="chat-message-column">
      <div
        role="status"
        className="mt-3 max-w-full break-words rounded-2xl border border-[var(--status-error-border)] bg-[var(--status-error-background)] px-4 py-3 text-base leading-relaxed"
      >
        <div className="flex items-start gap-3">
          <Icon name="error-warning" className="mt-0.5 size-4 shrink-0 text-[var(--status-error)]" />
          <div className="min-w-0 flex-1 break-words">
            <div className="font-medium text-foreground">{reportedError ? t('chat.sessionError.title') : t('chat.sessionError.noReply')}</div>
            <div className="mt-1 text-foreground/80">{name ? `${name}: ${detail}` : detail}</div>
          </div>
        </div>
      </div>
    </div>
  );
};
