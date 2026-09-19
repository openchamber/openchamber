import React from 'react';
import { toast } from 'sonner';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { useEnsureSessionMessages, useSession, useSessionPartsForMessages } from '@/sync/sync-context';
import { getContextObligatoryMessages } from '@/lib/contextObligatoryMessages';
import { setContextObligatoryMessage } from '@/sync/session-actions';
import { WorkStatusRow, WorkStatusSection } from './WorkStatusPrimitives';
import { useReportWorkStatusPresence } from './presenceContext';

type Props = {
  sessionId: string | null;
  directory: string | null;
};

/**
 * Messages pinned into the context.
 *
 * The row carries two destinations, so the pin is its own button: pressing the
 * pin unpins, pressing the text takes you to the message.
 */
export const WorkStatusPinnedSection: React.FC<Props> = ({ sessionId, directory }) => {
  const { t } = useI18n();
  const session = useSession(sessionId ?? '', directory ?? undefined);
  const [busyId, setBusyId] = React.useState<string | null>(null);

  const pinnedEntries = React.useMemo(
    () => getContextObligatoryMessages(session),
    [session],
  );
  const pinnedIds = React.useMemo(
    () => pinnedEntries.map((entry) => entry.id),
    [pinnedEntries],
  );

  // Subscribe to the pinned messages' parts only. An unrelated session's
  // streaming delta clones the whole `state.part` map, but `useSessionPartsForMessages`
  // keys its notified ids and cached snapshot on these arrays alone, so the
  // section neither re-renders nor re-reads the map for it.
  const partsByMessageId = useSessionPartsForMessages(pinnedIds, directory ?? undefined);

  const pinned = React.useMemo(() => {
    if (pinnedEntries.length === 0) return [];
    return pinnedEntries.map((entry) => {
      const messageParts = partsByMessageId[entry.id] ?? [];
      const text = messageParts.find(
        (part): part is Extract<typeof part, { type: 'text' }> => part.type === 'text',
      )?.text?.trim();
      return { id: entry.id, text: text || null };
    });
  }, [pinnedEntries, partsByMessageId]);

  // Pinned messages are most useful on a long session — which is exactly when
  // the pinned message has scrolled far enough back not to be loaded, leaving
  // the row with a placeholder instead of its text. Materialise the session,
  // but only when a pin actually resolves to nothing: having pins is not a
  // reason to fetch, and neither is something being unloaded in general.
  const hasUnresolvedPin = pinned.length > 0 && pinned.some((entry) => entry.text === null);
  useEnsureSessionMessages(sessionId ?? '', directory ?? undefined, hasUnresolvedPin);

  const handleUnpin = React.useCallback(async (messageId: string) => {
    if (!sessionId || busyId) return;
    setBusyId(messageId);
    try {
      // Only the id matters when unpinning — `withContextObligatoryMessage`
      // filters by it and discards the rest of the payload.
      await setContextObligatoryMessage(
        sessionId,
        directory,
        { id: messageId, createdAt: 0, role: 'user' },
        false,
      );
    } catch {
      toast.error(t('chat.workStatus.pinned.unpinFailed'));
    } finally {
      setBusyId((current) => (current === messageId ? null : current));
    }
  }, [busyId, directory, sessionId, t]);

  // The transcript listens for `#message-<id>` and scrolls there; it is the
  // only cross-component jump the chat exposes. An unchanged hash fires no
  // event, so clear it first to make a repeat press work.
  const handleReveal = React.useCallback((messageId: string) => {
    if (typeof window === 'undefined') return;
    const target = `#message-${messageId}`;
    if (window.location.hash === target) {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    }
    window.location.hash = target;
  }, []);

  useReportWorkStatusPresence('pinned', pinned.length > 0);

  if (pinned.length === 0) return null;

  return (
    <WorkStatusSection title={t('chat.workStatus.section.pinned')}>
      {pinned.map((entry) => (
        <WorkStatusRow
          key={entry.id}
          leading={(
            <button
              type="button"
              disabled={busyId === entry.id}
              aria-label={t('chat.workStatus.pinned.unpin')}
              onClick={(event) => {
                event.stopPropagation();
                void handleUnpin(entry.id);
              }}
              className="shrink-0 rounded p-0.5 transition-opacity hover:opacity-70 disabled:opacity-40"
            >
              <Icon name="pushpin-2-fill" className="size-3.5" style={{ color: 'var(--primary)' }} />
            </button>
          )}
          muted
          label={entry.text ?? t('chat.workStatus.pinned.unavailable')}
          onClick={() => handleReveal(entry.id)}
          ariaLabel={t('chat.workStatus.pinned.reveal')}
        />
      ))}
    </WorkStatusSection>
  );
};
