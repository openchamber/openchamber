import { Icon } from '@/components/icon/Icon';
import { Spinner } from '@/components/ui/spinner';
import { useI18n } from '@/lib/i18n';
import type { I18nKey } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { WalkthroughStageProgress } from './useWalkthroughStageProgress';

interface WalkthroughStagesProps {
  progress: WalkthroughStageProgress;
}

const STAGES: Array<{ labelKey: I18nKey }> = [
  { labelKey: 'walkthrough.stage.collecting' },
  { labelKey: 'walkthrough.stage.asking' },
  { labelKey: 'walkthrough.stage.assembling' },
];

export const WalkthroughStages = ({ progress }: WalkthroughStagesProps) => {
  const { t } = useI18n();
  const { completedCount, activeIndex } = progress;

  return (
    <ul className="flex flex-col gap-2 text-start">
      {STAGES.map((entry, index) => {
        const isDone = index < completedCount;
        const isActive = activeIndex === index;

        return (
          <li key={entry.labelKey} className="flex items-center gap-2">
            <span className="flex size-4 shrink-0 items-center justify-center">
              {isDone ? (
                <Icon name="check" className="size-3.5 text-status-success" />
              ) : isActive ? (
                <Spinner className="size-3.5 text-[var(--status-info)]" />
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
