import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { formatSessionCompactDateLabel } from '@/components/session/sidebar/utils';
import type { LinkedSessionRow } from '@/lib/linkedSessionMatches';

interface LinkedSessionsSectionProps {
  sessions: LinkedSessionRow[];
  /** Called with the session id when a row is clicked to open its chat. */
  onOpenSession: (sessionId: string) => void;
}

/**
 * "Chats working on this" — sessions in the current project that have this
 * forge entity linked (`metadata.openchamber.linked_issues`). Purely derived
 * from the already-loaded session list; rows open the session's chat. Renders
 * nothing when there are no matches.
 */
export const LinkedSessionsSection = React.memo<LinkedSessionsSectionProps>(function LinkedSessionsSection({
  sessions,
  onOpenSession,
}) {
  const { t } = useI18n();

  if (sessions.length === 0) {
    return null;
  }

  return (
    <section aria-label={t('forge.linkedSessions.title')}>
      <div className="flex items-center gap-2 py-0.5">
        <Icon name="chat-4" className="size-4 shrink-0 text-muted-foreground" />
        <h4 className="typography-ui-label font-semibold text-foreground">{t('forge.linkedSessions.title')}</h4>
        <span
          aria-label={t('forge.linkedSessions.count', { count: sessions.length })}
          title={t('forge.linkedSessions.count', { count: sessions.length })}
          className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-interactive-hover px-1.5 typography-micro text-foreground"
        >
          {sessions.length}
        </span>
      </div>
      <ul className="mt-1 flex flex-col gap-0.5">
        {sessions.map((session) => (
          <li key={session.sessionId}>
            <button
              type="button"
              onClick={() => onOpenSession(session.sessionId)}
              className="flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-1 py-1.5 text-left transition-colors hover:bg-interactive-hover/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
              aria-label={t('forge.linkedSessions.open', { title: session.title })}
              title={session.title}
            >
              <Icon name="chat-4" className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate typography-small text-foreground">{session.title}</span>
              {typeof session.linkedAt === 'number' ? (
                <span className="shrink-0 typography-micro text-muted-foreground">
                  {formatSessionCompactDateLabel(session.linkedAt)}
                </span>
              ) : null}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
});
