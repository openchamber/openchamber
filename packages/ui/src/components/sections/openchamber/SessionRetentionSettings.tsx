import React from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { RiInformationLine, RiRestartLine } from '@remixicon/react';
import { toast } from '@/components/ui';
import { NumberInput } from '@/components/ui/number-input';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionAutoCleanup } from '@/hooks/useSessionAutoCleanup';
import { m } from '@/lib/i18n/messages';

const MIN_DAYS = 1;
const MAX_DAYS = 365;
const DEFAULT_RETENTION_DAYS = 30;
const RETENTION_ACTION_OPTIONS = [
  { value: 'archive', label: m.actionArchive() },
  { value: 'delete', label: m.commonDelete() },
] as const;

export const SessionRetentionSettings: React.FC = () => {
  const autoDeleteEnabled = useUIStore((state) => state.autoDeleteEnabled);
  const autoDeleteAfterDays = useUIStore((state) => state.autoDeleteAfterDays);
  const sessionRetentionAction = useUIStore((state) => state.sessionRetentionAction);
  const setAutoDeleteEnabled = useUIStore((state) => state.setAutoDeleteEnabled);
  const setAutoDeleteAfterDays = useUIStore((state) => state.setAutoDeleteAfterDays);
  const setSessionRetentionAction = useUIStore((state) => state.setSessionRetentionAction);

  const { candidates, isRunning, runCleanup, action } = useSessionAutoCleanup({ autoRun: false });
  const pendingCount = candidates.length;

  const handleRunCleanup = React.useCallback(async () => {
    const result = await runCleanup({ force: true });

    if (result.completedIds.length === 0 && result.failedIds.length === 0) {
      toast.message(m.srToastNoneEligible({ action: result.action === 'archive' ? 'archiving' : 'deletion' }));
      return;
    }
    if (result.completedIds.length > 0) {
      toast.success(result.action === 'archive'
        ? m.srToastArchived({ count: result.completedIds.length })
        : m.srToastDeleted({ count: result.completedIds.length }));
    }
    if (result.failedIds.length > 0) {
      toast.error(result.action === 'archive'
        ? m.srToastArchiveFailed({ count: result.failedIds.length })
        : m.srToastDeleteFailed({ count: result.failedIds.length }));
    }
  }, [runCleanup]);

  return (
    <div className="mb-8">
      <div className="mb-1 px-1">
        <div className="flex items-center gap-2">
            <h3 className="typography-ui-header font-medium text-foreground">
              {m.sessionRetentionTitle()}
            </h3>
            <Tooltip delayDuration={1000}>
              <TooltipTrigger asChild>
                <RiInformationLine className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
              </TooltipTrigger>
              <TooltipContent sideOffset={8} className="max-w-xs">
                {m.sessionRetentionTooltip()}
              </TooltipContent>
            </Tooltip>
        </div>
      </div>

      <section className="px-2 pb-2 pt-0 space-y-0.5">
        <div
          className="group flex cursor-pointer items-center gap-2 py-1.5"
          role="button"
          tabIndex={0}
          aria-pressed={autoDeleteEnabled}
          onClick={() => setAutoDeleteEnabled(!autoDeleteEnabled)}
          onKeyDown={(event) => {
            if (event.key === ' ' || event.key === m.commonKeyEnter()) {
              event.preventDefault();
              setAutoDeleteEnabled(!autoDeleteEnabled);
            }
          }}
        >
          <Checkbox
            checked={autoDeleteEnabled}
            onChange={setAutoDeleteEnabled}
            ariaLabel={m.sessionRetentionEnableAria()}
          />
          <span className="typography-ui-label text-foreground">{m.sessionRetentionEnable()}</span>
        </div>

        <div className="flex flex-col gap-2 py-1.5 sm:flex-row sm:items-center sm:gap-8">
          <div className="flex min-w-0 flex-col sm:w-56 shrink-0">
            <span className="typography-ui-label text-foreground">{m.sessionRetentionPeriod()}</span>
          </div>
          <div className="flex items-center gap-2 sm:w-fit">
            <NumberInput
              value={autoDeleteAfterDays}
              onValueChange={setAutoDeleteAfterDays}
              min={MIN_DAYS}
              max={MAX_DAYS}
              step={1}
              aria-label={m.sessionRetentionPeriodAria()}
              className="w-20 tabular-nums"
            />
            <span className="typography-ui-label text-muted-foreground">{m.sessionRetentionDays()}</span>
            <Button size="sm"
              type="button"
              variant="ghost"
              onClick={() => setAutoDeleteAfterDays(DEFAULT_RETENTION_DAYS)}
              disabled={autoDeleteAfterDays === DEFAULT_RETENTION_DAYS}
              className="h-7 w-7 px-0 text-muted-foreground hover:text-foreground"
              aria-label={m.sessionRetentionResetPeriodAria()}
              title={m.commonReset()}
            >
              <RiRestartLine className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>

        <div className="flex flex-col gap-2 py-1.5 sm:flex-row sm:items-center sm:gap-8">
          <div className="flex min-w-0 flex-col sm:w-56 shrink-0">
            <span className="typography-ui-label text-foreground">{m.sessionRetentionAction()}</span>
          </div>
          <div className="flex flex-wrap items-center gap-1 sm:w-fit">
            {RETENTION_ACTION_OPTIONS.map((option) => (
              <Button
                key={option.value}
                type="button"
                variant="outline"
                size="xs"
                className={cn(
                  '!font-normal',
                  sessionRetentionAction === option.value
                    ? 'border-[var(--primary-base)] text-[var(--primary-base)] bg-[var(--primary-base)]/10 hover:text-[var(--primary-base)]'
                    : 'text-foreground'
                )}
                onClick={() => setSessionRetentionAction(option.value)}
              >
                {option.label}
              </Button>
            ))}
          </div>
        </div>
      </section>

      <div className="mt-1 px-2 py-1.5 space-y-1">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-8">
          <div className="flex min-w-0 flex-col sm:w-56 shrink-0">
            <p className="typography-meta text-foreground font-medium">{m.sessionRetentionManual()}</p>
          </div>
          <div className="flex items-center gap-2 sm:w-fit">
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={handleRunCleanup}
              disabled={isRunning}
              className="!font-normal"
            >
              {isRunning ? m.sessionRetentionCleaning() : m.sessionRetentionRun()}
            </Button>
          </div>
        </div>
        <p className="typography-meta text-muted-foreground">
          {m.sessionRetentionEligible({ action: action === 'archive' ? 'archiving' : 'deletion', count: pendingCount })}
        </p>
      </div>
    </div>
  );
};
