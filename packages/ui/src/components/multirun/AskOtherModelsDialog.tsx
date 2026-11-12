import React from 'react';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useI18n } from '@/lib/i18n';
import type { Session } from '@/lib/opencode/model';
import { loadLaneFirstPrompt } from '@/lib/multirun/laneData';
import { askOtherModels, NotFirstTurnError } from '@/lib/multirun/runActions';
import { useUIStore } from '@/stores/useUIStore';
import { ModelMultiSelect, type ModelSelectionWithId } from './ModelMultiSelect';

type Eligibility = 'checking' | 'eligible' | 'not-first-turn' | 'unavailable';

export function AskOtherModelsDialog({
  session,
  turnUserMessageId,
  open,
  onOpenChange,
}: {
  session: Session;
  turnUserMessageId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.ReactNode {
  const { t } = useI18n();
  const [models, setModels] = React.useState<ModelSelectionWithId[]>([]);
  const [eligibility, setEligibility] = React.useState<Eligibility>('checking');
  const [isStarting, setIsStarting] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setModels([]);
    setEligibility('checking');
    loadLaneFirstPrompt(session.id, session.directory).then(
      (prompt) => {
        if (!cancelled) setEligibility(prompt?.messageId === turnUserMessageId ? 'eligible' : 'not-first-turn');
      },
      () => {
        if (!cancelled) setEligibility('unavailable');
      },
    );
    return () => { cancelled = true; };
  }, [open, session.directory, session.id, turnUserMessageId]);

  const handleStart = async () => {
    setIsStarting(true);
    try {
      const result = await askOtherModels({ session, turnUserMessageId, models });
      if (result.failedCount > 0) toast.error(t('multirun.launcher.toast.partialFailure', { failed: result.failedCount }));
      onOpenChange(false);
      useUIStore.getState().setRunOverviewKey(result.runKey);
    } catch (error) {
      console.error('[MultiRun] Ask other models failed', error);
      toast.error(error instanceof NotFirstTurnError ? t('multirun.ask.notFirstTurn') : t('multirun.ask.failed'));
    } finally {
      setIsStarting(false);
    }
  };

  let status: string;
  if (eligibility === 'checking') status = t('multirun.ask.checking');
  else if (eligibility === 'not-first-turn') status = t('multirun.ask.notFirstTurn');
  else if (eligibility === 'unavailable') status = t('multirun.ask.failed');
  else status = t('multirun.ask.description');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg overflow-visible">
        <DialogHeader>
          <DialogTitle>{t('multirun.ask.title')}</DialogTitle>
          <DialogDescription>{status}</DialogDescription>
        </DialogHeader>
        {eligibility === 'eligible' ? (
          <ModelMultiSelect
            selectedModels={models}
            onAdd={(model) => setModels((current) => [...current, model])}
            onRemove={(index) => setModels((current) => current.filter((_, i) => i !== index))}
            onUpdate={(index, model) => setModels((current) => current.map((entry, i) => (i === index ? model : entry)))}
            dropdownSide="bottom"
          />
        ) : null}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>{t('multirun.overview.cancel')}</Button>
          <Button onClick={() => void handleStart()} disabled={eligibility !== 'eligible' || models.length === 0 || isStarting}>
            {isStarting
              ? t('multirun.fusion.actions.starting')
              : models.length === 1
                ? t('multirun.ask.startSingle', { count: models.length })
                : t('multirun.ask.startPlural', { count: models.length })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
