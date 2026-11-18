import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { ProjectEntry } from '@/lib/api/types';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { isVSCodeRuntime } from '@/lib/desktop';
import { cn } from '@/lib/utils';
import { useSuggestedTasksStore } from '@/stores/useSuggestedTasksStore';
import { useSuggestedTasksSettingsStore } from '@/stores/useSuggestedTasksSettingsStore';
import { DismissSuggestionDialog } from './DismissSuggestionDialog';
import { SuggestionCard } from './SuggestionCard';
import { SuggestedTasksRun } from './SuggestedTasksRun';
import type { SuggestedTasksLeaveReason } from './SuggestedTasksPage';
import { SuggestedTasksSettingsDialog } from './SuggestedTasksSettingsDialog';
import { useSuggestedTasksGit } from './useSuggestedTasksGit';
import { useSuggestionActions } from './useSuggestionActions';
import { SuggestionBotHandoff } from './SuggestionBotHandoff';

const FILTERS = [
  { id: 'open', label: 'suggestedTasks.filter.open' },
  { id: 'snoozed', label: 'suggestedTasks.filter.snoozed' },
  { id: 'approved', label: 'suggestedTasks.filter.approved' },
  { id: 'dismissed', label: 'suggestedTasks.filter.dismissed' },
] as const satisfies readonly { id: string; label: I18nKey }[];
const ALL_LENSES = '__all';

export function SuggestedTasksInbox({ project, onLeave }: {
  project: ProjectEntry;
  onLeave: (reason: SuggestedTasksLeaveReason) => void;
}) {
  const { t } = useI18n();
  const entry = useSuggestedTasksStore((state) => state.inboxes[project.id]);
  const summaryError = useSuggestedTasksStore((state) => state.summaryError);
  const settingsEntry = useSuggestedTasksSettingsStore((state) => state.entries[project.id]);
  const [filter, setFilter] = React.useState<(typeof FILTERS)[number]['id']>('open');
  const [lensFilter, setLensFilter] = React.useState(ALL_LENSES);
  const [configuring, setConfiguring] = React.useState(false);
  const git = useSuggestedTasksGit(project.path);
  const actions = useSuggestionActions(project, onLeave);
  const reload = React.useCallback(() => {
    void useSuggestedTasksStore.getState().loadInbox(project.id, true);
    void useSuggestedTasksSettingsStore.getState().load(project.id);
  }, [project.id]);
  React.useEffect(reload, [reload]);

  const inbox = entry && entry.status !== 'loading' ? entry.inbox : null;
  const suggestions = inbox?.suggestions ?? [];
  const counts = { open: 0, snoozed: 0, dismissed: 0, approved: 0 };
  const lenses = new Map<string, string>();
  for (const suggestion of suggestions) {
    counts[suggestion.status] += 1;
    lenses.set(suggestion.lensId, suggestion.lensName);
  }
  const selectedLens = lenses.has(lensFilter) ? lensFilter : ALL_LENSES;
  const visible = suggestions.filter((suggestion) => suggestion.status === filter && (selectedLens === ALL_LENSES || suggestion.lensId === selectedLens));
  const lastRun = inbox?.runs[0];
  const scanRunning = lastRun?.status === 'running';
  const settings = settingsEntry?.settings;
  const enabledLens = settings?.config.lenses.some((lens) => lens.enabled) || settings?.repoLenses.some((lens) => lens.status === 'enabled');
  const canScan = Boolean(settings?.config.enabled && enabledLens && !settingsEntry?.saving && !actions.running && !scanRunning);
  const error = entry?.status === 'error' ? entry.error : settingsEntry?.error ?? (git.availability.status === 'error' ? git.availability.error : summaryError);
  const emptyText = filter !== 'open' ? t('suggestedTasks.empty.filtered')
    : !lastRun ? t('suggestedTasks.empty.neverScanned') : t('suggestedTasks.empty.noOpen');

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => { if (canScan) void actions.runNow(); }} disabled={!canScan}>
          <Icon name={actions.running || scanRunning ? 'loader-4' : 'play'} className={cn('size-4', (actions.running || scanRunning) && 'animate-spin')} />
          {scanRunning ? t('suggestedTasks.page.scanning') : t('suggestedTasks.page.runNow')}
        </Button>
        <Button size="sm" variant="outline" onClick={() => setConfiguring(true)}>
          <Icon name="settings-3" className="size-4" /> {t('suggestedTasks.page.settings')}
        </Button>
      </div>
      {settings && !settings.config.enabled ? <p className="typography-meta text-muted-foreground">{t('suggestedTasks.settings.status.off')}</p> : null}
      {settings?.config.enabled && !enabledLens ? <p className="typography-meta text-muted-foreground">{t('suggestedTasks.run.skipped.noLenses')}</p> : null}
      {error ? (
        <div role="alert" className="flex items-start gap-2 rounded-md border p-2 typography-meta" style={{ color: 'var(--status-error-text)', backgroundColor: 'var(--status-error-background)', borderColor: 'var(--status-error-border)' }}>
          <Icon name="error-warning" className="mt-0.5 size-4 shrink-0" />
          <span className="min-w-0 flex-1 break-words">{t('suggestedTasks.error.load', { error })}</span>
          <Button size="xs" variant="ghost" onClick={() => { reload(); git.retry(); void useSuggestedTasksStore.getState().loadSummary(); }}>{t('suggestedTasks.error.retry')}</Button>
        </div>
      ) : null}
      {lastRun ? <SuggestedTasksRun run={lastRun} onOpenSession={(lens) => { if (lens.sessionId) actions.openSession(lens.sessionId, lens.directory); }} onStop={() => void actions.stop(lastRun.id)} /> : null}
      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label={t('suggestedTasks.filter.label')} className="flex flex-wrap gap-1">
          {FILTERS.map((item) => (
            <Button key={item.id} type="button" variant="chip" size="xs" aria-pressed={filter === item.id} onClick={() => setFilter(item.id)}>
              {t(item.label)} <span className="text-muted-foreground" dir="auto">{counts[item.id]}</span>
            </Button>
          ))}
        </div>
        {lenses.size > 1 ? (
          <Select value={selectedLens} onValueChange={setLensFilter}>
            <SelectTrigger className="w-fit max-w-56" aria-label={t('suggestedTasks.filter.lens')}>
              <SelectValue>{(value) => value === ALL_LENSES ? t('suggestedTasks.filter.allLenses') : lenses.get(value ?? '') ?? ''}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_LENSES}>{t('suggestedTasks.filter.allLenses')}</SelectItem>
              {[...lenses].map(([id, name]) => <SelectItem key={id} value={id}>{name}</SelectItem>)}
            </SelectContent>
          </Select>
        ) : null}
      </div>
      {!entry || entry.status === 'loading' ? (
        <div className="flex items-center gap-2 typography-meta text-muted-foreground"><Icon name="loader-4" className="size-4 animate-spin" /> {t('suggestedTasks.page.loading')}</div>
      ) : inbox && visible.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-4 typography-meta text-muted-foreground">{emptyText}</div>
      ) : (
        <div className="space-y-2.5">
          {visible.map((suggestion) => (
            <SuggestionCard key={suggestion.id} suggestion={suggestion} projectPath={project.path} issueProviders={inbox?.issueProviders ?? []}
              canCreateWorktree={git.canCreateWorktree} busy={actions.busyIds.has(suggestion.id)}
              botsAvailable={!isVSCodeRuntime()} handoffBotId={actions.attemptedBots.get(suggestion.id)}
              onDecide={(decision) => {
                if (decision.kind === 'approve' && (decision.action === 'worktree' || decision.action === 'draft-pr') && !git.canCreateWorktree) return;
                void actions.decide(suggestion, decision);
              }} />
          ))}
        </div>
      )}
      {actions.dismissTarget ? (
        <DismissSuggestionDialog key={actions.dismissTarget.id} title={actions.dismissTarget.title}
          onOpenChange={(open) => { if (!open) actions.setDismissTarget(null); }} onDismiss={actions.dismiss} />
      ) : null}
      {configuring ? <SuggestedTasksSettingsDialog project={project} onOpenChange={setConfiguring} /> : null}
      {actions.handoffTarget ? <SuggestionBotHandoff key={actions.handoffTarget.id} projectId={project.id} title={actions.handoffTarget.title}
        lockedBotId={actions.attemptedBots.get(actions.handoffTarget.id)} busy={actions.busyIds.has(actions.handoffTarget.id)} error={actions.handoffError}
        onHandoff={actions.handoff} onClose={() => actions.setHandoffTarget(null)} /> : null}
    </div>
  );
}
