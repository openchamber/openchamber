import React from 'react';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import {
  fetchGoalObjectiveVersionContent,
  fetchGoalObjectiveVersions,
  type GoalObjectiveVersion,
} from '@/lib/goalObjectiveFiles';

/**
 * The goal's prior spec versions (#1830): a list of the retained versions,
 * a read-only view of one, and Restore, which hands the older text back to
 * the editor as the objective to save. Restoring is a normal save, so the
 * server records the restored text as a new version and nothing in the past
 * is rewritten. The list mounts on demand, so a closed dialog does no work.
 */

type HistoryState =
  | { status: 'loading' }
  | { status: 'ready'; versions: GoalObjectiveVersion[] }
  | { status: 'unavailable' };

type ViewState =
  | { status: 'closed' }
  | { status: 'loading'; version: GoalObjectiveVersion }
  | { status: 'ready'; version: GoalObjectiveVersion; content: string }
  | { status: 'failed'; version: GoalObjectiveVersion };

const formatSavedAt = (savedAt: number, locale: string): string => {
  try {
    return new Intl.DateTimeFormat(locale || undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(savedAt));
  } catch {
    return new Date(savedAt).toISOString();
  }
};


export interface GoalVersionHistoryProps {
  sessionId: string;
  /** The objective currently saved, so its version is not offered as a restore. */
  currentObjective: string;
  /** Hand an older version's text to the editor as the objective to save. */
  onRestore: (content: string) => void;
  /** The locale for the timestamps; the i18n locale when omitted. */
  locale?: string;
  /** Injected for tests; the server routes by default. */
  loadVersions?: (sessionId: string) => Promise<GoalObjectiveVersion[] | null>;
  loadVersionContent?: (sessionId: string, versionId: string) => Promise<string | null>;
}

export function GoalVersionHistory({
  sessionId,
  currentObjective,
  onRestore,
  locale,
  loadVersions = fetchGoalObjectiveVersions,
  loadVersionContent = fetchGoalObjectiveVersionContent,
}: GoalVersionHistoryProps) {
  const { t, locale: i18nLocale } = useI18n();
  const [state, setState] = React.useState<HistoryState>({ status: 'loading' });
  const [view, setView] = React.useState<ViewState>({ status: 'closed' });

  React.useEffect(() => {
    let cancelled = false;
    void loadVersions(sessionId).then((versions) => {
      if (cancelled) return;
      setState(versions === null ? { status: 'unavailable' } : { status: 'ready', versions });
    });
    return () => { cancelled = true; };
  }, [sessionId, loadVersions]);

  const openVersion = async (version: GoalObjectiveVersion) => {
    setView({ status: 'loading', version });
    const content = await loadVersionContent(sessionId, version.id);
    setView(content === null
      ? { status: 'failed', version }
      : { status: 'ready', version, content });
  };

  const shownLocale = locale ?? i18nLocale;
  const current = currentObjective.trim();

  if (view.status === 'loading' || view.status === 'ready' || view.status === 'failed') {
    const savedLabel = formatSavedAt(view.version.savedAt, shownLocale);
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-2" role="region" aria-label={t('chat.goal.versions.viewAria', { date: savedLabel })}>
        <div className="flex items-center justify-between gap-2">
          <span className="min-w-0 truncate typography-ui-label text-foreground">{t('chat.goal.versions.savedAt', { date: savedLabel })}</span>
          <Button type="button" variant="ghost" size="sm" className="h-6 shrink-0 gap-1 px-1.5" onClick={() => setView({ status: 'closed' })}>
            <Icon name="arrow-left" className="size-3.5" aria-hidden="true" />
            {t('chat.goal.versions.back')}
          </Button>
        </div>
        {view.status === 'loading' ? (
          <div className="flex items-start gap-2 py-2" role="status">
            <Icon name="loader-4" className="size-4 shrink-0 animate-spin text-muted-foreground" aria-hidden="true" />
            <p className="typography-meta text-muted-foreground">{t('chat.goal.versions.loadingVersion')}</p>
          </div>
        ) : null}
        {view.status === 'failed' ? (
          <p className="typography-meta text-muted-foreground" role="alert">{t('chat.goal.versions.versionUnavailable')}</p>
        ) : null}
        {view.status === 'ready' ? (
          <>
            <div
              className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-[var(--surface-2)] p-2 typography-meta text-foreground"
              role="group"
              aria-label={t('chat.goal.versions.viewAria', { date: savedLabel })}
              data-testid="goal-version-content"
            >
              {view.content}
            </div>
            {view.content.trim() === current ? (
              <p className="typography-meta text-muted-foreground/70">{t('chat.goal.versions.isCurrent')}</p>
            ) : (
              <div className="flex justify-end">
                <Button
                  type="button"
                  size="sm"
                  onClick={() => {
                    onRestore(view.content);
                    setView({ status: 'closed' });
                  }}
                >
                  <Icon name="restart" className="size-3.5" aria-hidden="true" />
                  {t('chat.goal.versions.restore')}
                </Button>
              </div>
            )}
          </>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1" role="region" aria-label={t('chat.goal.versions.title')}>
      <span className="typography-ui-label text-foreground">{t('chat.goal.versions.title')}</span>
      {state.status === 'loading' ? (
        <div className="flex items-start gap-2 py-2" role="status">
          <Icon name="loader-4" className="size-4 shrink-0 animate-spin text-muted-foreground" aria-hidden="true" />
          <p className="typography-meta text-muted-foreground">{t('chat.goal.versions.loading')}</p>
        </div>
      ) : null}
      {state.status === 'unavailable' ? (
        <p className="typography-meta text-muted-foreground" role="alert">{t('chat.goal.versions.unavailable')}</p>
      ) : null}
      {state.status === 'ready' && state.versions.length === 0 ? (
        <p className="typography-meta text-muted-foreground">{t('chat.goal.versions.empty')}</p>
      ) : null}
      {state.status === 'ready' && state.versions.length > 0 ? (
        <ul className="max-h-64 overflow-auto rounded-lg border border-border" data-testid="goal-version-list">
          {state.versions.map((version) => (
            <li key={version.id} className="border-b border-border last:border-b-0">
              <button
                type="button"
                className="flex w-full items-center gap-2 px-2 py-1.5 text-start hover:bg-[var(--surface-2)] focus-visible:bg-[var(--surface-2)] focus-visible:outline-none"
                onClick={() => void openVersion(version)}
              >
                <Icon name="time" className="size-3.5 shrink-0 text-muted-foreground/70" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate typography-meta text-foreground">{formatSavedAt(version.savedAt, shownLocale)}</span>
                <span className="shrink-0 typography-micro text-muted-foreground/70">{t('chat.goal.versions.view')}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
