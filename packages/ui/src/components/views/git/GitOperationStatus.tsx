import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { GitActionRecovery } from './useGitOperationRecovery';

/**
 * Says what a Git transfer left for the person to act on.
 *
 * A transfer in flight already shows on the control that started it, and a
 * check of saved operations with nothing saved is bookkeeping, so neither
 * renders here. The card appears for a failure, an outcome nobody knows, a
 * saved operation from earlier, or a commit whose publication did not happen.
 */
export function GitOperationStatus({ entry, onRefresh, onCancel, className }: {
  entry: GitActionRecovery | undefined;
  onRefresh: () => void;
  onCancel: () => void;
  /** Outer spacing; the panel insets the card like the in-progress banner, the dialog stacks it flush. */
  className?: string;
}) {
  const { t } = useI18n();
  if (!entry) return null;
  const restored = entry.pending ?? [];
  const settledReads = entry.reads.filter(({ operation, availability }) => availability === 'unavailable'
    || (operation.state !== 'planned' && operation.state !== 'running' && operation.state !== 'succeeded'));
  // Checking saved operations is only news when there is one to check.
  const problem = entry.problem === 'reconciling' && !restored.length ? null : entry.problem;
  const unreadRestored = restored.filter((reference) => !entry.reads.some((read) => read.operation.operationId === reference.operationId));
  if (!settledReads.length && !unreadRestored.length && !problem && !entry.localCommit) return null;
  const last = entry.reads.at(-1);
  const canCancel = last?.availability === 'unavailable' && (last.operation.state === 'planned' || last.operation.state === 'running');
  const unknown = Boolean(unreadRestored.length || settledReads.some(({ operation, availability }) => availability === 'unavailable'
    || operation.state === 'outcome-unknown'));
  return (
    <section
      className={cn('min-w-0 shrink-0 rounded-lg border border-border bg-[var(--surface-elevated)] p-3 typography-meta', className)}
      aria-live="polite"
      aria-busy={entry.checking}
      aria-label={t('gitView.operation.title')}
    >
      <div className="max-h-48 space-y-1 overflow-y-auto">
        {problem ? <p className="text-[var(--status-warning)]">{t(`gitView.operation.recovery.${problem}`)}</p> : null}
        {unreadRestored.map((reference) => (
          <div key={reference.operationId} className="space-y-1 text-muted-foreground">
            <p>{t('gitView.operation.state.unavailable')}</p>
            <code className="block break-all typography-micro">{reference.operationId}</code>
          </div>
        ))}
        {entry.localCommit ? <p className="text-foreground">{t('gitView.operation.localCommit')}</p> : null}
        {settledReads.map(({ operation, availability }) => {
          const unavailable = availability === 'unavailable' || operation.state === 'outcome-unknown';
          const hydrationProblems = operation.hydration
            ? [...operation.hydration.submodules.map((item) => ({ ...item, kind: 'submodule' as const })),
              ...operation.hydration.lfs.map((item) => ({ ...item, kind: 'lfs' as const }))]
              .filter((item) => item.status !== 'succeeded' && item.status !== 'not-needed')
            : [];
          return (
            <div key={operation.operationId} className="space-y-1">
              <p className="text-foreground">
                {t(`gitView.operation.state.${availability === 'unavailable' ? 'unavailable' : operation.state}`)}
              </p>
              {'error' in operation ? <p className="break-words text-muted-foreground">{operation.error.message}</p> : null}
              {operation.stepResults?.map((step) => <p key={step.step} className="flex justify-between gap-3 text-muted-foreground">
                <span>{t(`gitView.sync.${step.step}`)}</span>
                <span>{t(`gitView.operation.state.${step.status}`)}</span>
              </p>)}
              {hydrationProblems.map((item) => (
                <p key={`${item.kind}:${item.path}:${item.endpoint?.fingerprint ?? item.status}`} className="break-words text-muted-foreground">
                  {item.path} · {t(item.kind === 'submodule' ? 'gitView.hydration.kind.submodule' : 'gitView.hydration.kind.lfs')}
                  {' · '}{t(`gitView.hydration.status.${item.status}`)}
                  {item.endpoint ? <> · <code>{item.endpoint.displayUrl}</code></> : null}
                </p>
              ))}
              {/* The ID is what the person looks for outside OpenChamber when nobody knows the outcome. */}
              {unavailable ? <code className="block break-all typography-micro text-muted-foreground">{operation.operationId}</code> : null}
            </div>
          );
        })}
        {unknown ? <p className="text-[var(--status-warning)]">{t('gitView.operation.unknownHint')}</p> : null}
        {unknown ? <p className="text-muted-foreground">{t('gitView.operation.recovery.inspect')}</p> : null}
      </div>
      {unknown || problem ? <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="outline" size="sm" disabled={entry.checking} onClick={onRefresh}>{t('gitView.operation.refresh')}</Button>
        {canCancel ? <Button variant="ghost" size="sm" disabled={entry.checking} onClick={onCancel}>{t('gitView.operation.cancel')}</Button> : null}
      </div> : null}
    </section>
  );
}
