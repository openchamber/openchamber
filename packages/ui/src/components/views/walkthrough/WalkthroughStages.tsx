import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import type { I18nKey } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { WalkthroughStageProgress } from './useWalkthroughStageProgress';

interface WalkthroughStagesProps {
  progress: WalkthroughStageProgress;
}

/**
 * The wait is long and uneven — collecting a pull request diff is seconds of
 * network, the model call is minutes — and a lone spinner makes those look
 * identical. Naming the phase says which one you are waiting on, and that the
 * cost has been committed once it reads "waiting on the model".
 *
 * No durations: a stopwatch on a step nobody can hurry adds pressure, not
 * information. And no mention of the schema fallback — from out here it is the
 * same wait, and naming our plumbing only invites the question of what it is.
 */
const STAGES: Array<{ labelKey: I18nKey }> = [
  { labelKey: 'walkthrough.stage.collecting' },
  { labelKey: 'walkthrough.stage.asking' },
  { labelKey: 'walkthrough.stage.assembling' },
];

export const WalkthroughStages = ({ progress }: WalkthroughStagesProps) => {
  const { t } = useI18n();
  const { completedCount, activeIndex } = progress;

  return (
    <ul className="flex flex-col gap-2 text-left">
      {STAGES.map((entry, index) => {
        const isDone = index < completedCount;
        const isActive = activeIndex === index;

        return (
          <li key={entry.labelKey} className="flex items-center gap-2">
            <span className="flex size-4 shrink-0 items-center justify-center">
              {isDone ? (
                <Icon name="check" className="size-3.5 text-status-success" />
              ) : isActive ? (
                <Icon name="loader-4" className="size-3.5 animate-spin text-[var(--status-info)]" />
              ) : (
                <span className="size-1.5 rounded-full bg-surface-muted" />
              )}
            </span>
            <span
              className={cn(
                'typography-meta',
                isActive ? 'text-foreground' : isDone ? 'text-muted-foreground' : 'text-muted-foreground/60'
              )}
            >
              {t(entry.labelKey)}
            </span>
          </li>
        );
      })}
    </ul>
  );
};
