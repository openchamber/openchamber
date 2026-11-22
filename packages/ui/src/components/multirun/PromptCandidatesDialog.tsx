import React from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useI18n } from '@/lib/i18n';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { generatePromptCandidates, selectPromptCandidates, type PromptCandidate } from '@/lib/multirun/promptCandidates';
import { ModelMultiSelect, type ModelSelectionWithId } from './ModelMultiSelect';
import { BusyDots } from '@/components/ui/busy-dots';

const draftScope = () => {
  const draft = useSessionUIStore.getState().newSessionDraft;
  return JSON.stringify([getRuntimeKey(), draft.draftId, draft.open, draft.selectedProjectId, draft.directoryOverride]);
};

function CandidateReview({ original, directory, initialModels, onUse, onClose }: {
  original: string;
  directory: string;
  initialModels: ModelSelectionWithId[];
  onUse: (texts: string[]) => void;
  onClose: () => void;
}): React.ReactNode {
  const { t } = useI18n();
  const scope = React.useRef(draftScope()).current;
  const [description, setDescription] = React.useState('');
  const [models, setModels] = React.useState(initialModels);
  const [candidates, setCandidates] = React.useState<PromptCandidate[]>([]);
  const [selected, setSelected] = React.useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const generation = React.useRef(0);
  React.useEffect(() => () => { generation.current += 1; }, []);
  const generate = async () => {
    if (busy || !description.trim() || models.length === 0) return;
    const epoch = ++generation.current;
    setBusy(true);
    setFailed(false);
    try {
      const result = await generatePromptCandidates({ original, description, directory, models: models.map((model) => ({ providerID: model.providerID, id: model.modelID, variant: model.variant })) });
      if (generation.current !== epoch || draftScope() !== scope) return;
      setCandidates((current) => [...current, ...result.candidates]);
      setFailed(result.failedModels.length > 0);
    } catch {
      if (generation.current === epoch) setFailed(true);
    } finally {
      if (generation.current === epoch) setBusy(false);
    }
  };
  const chosen = selectPromptCandidates(candidates, selected);
  return <>
    <DialogHeader>
      <DialogTitle>{t('multirun.prompts.title')}</DialogTitle>
      <DialogDescription>{t('multirun.prompts.hint')}</DialogDescription>
    </DialogHeader>
    <Textarea value={description} onChange={(event) => setDescription(event.target.value)} aria-label={t('multirun.prompts.description')} placeholder={t('multirun.prompts.description')} className="min-h-24" />
    <div className="flex flex-wrap items-center gap-2">
      <ModelMultiSelect selectedModels={models} onAdd={(model) => setModels((current) => [...current, model])} onRemove={(index) => setModels((current) => current.filter((_, i) => i !== index))} onUpdate={(index, model) => setModels((current) => current.map((item, i) => i === index ? model : item))} />
      <Button disabled={busy || !description.trim() || models.length === 0 || !directory} onClick={() => void generate()}>{t('multirun.prompts.generate')}</Button>
    </div>
    <p className="h-5 truncate typography-meta text-muted-foreground" role={failed ? 'alert' : 'status'}>{failed ? t('multirun.prompts.failed') : busy ? <>{t('multirun.prompts.generating')}<BusyDots /></> : ''}</p>
    <div className="flex h-64 flex-col gap-2 overflow-y-auto">
      {candidates.map((candidate) => <div key={candidate.id} className="oc-tile shrink-0 rounded-lg p-3">
        <div className="flex items-center gap-2">
          <Checkbox checked={selected.has(candidate.id)} ariaLabel={candidate.title} onChange={(checked) => setSelected((current) => {
            const next = new Set(current);
            if (checked) next.add(candidate.id); else next.delete(candidate.id);
            return next;
          })} />
          <span dir="auto" className="oc-ui-start-align min-w-0 flex-1 truncate typography-ui-label text-foreground">{candidate.title}</span>
          <span className="typography-micro text-muted-foreground">{candidate.model.id}</span>
        </div>
        <div dir="auto" className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap break-words typography-meta text-foreground">{candidate.text}</div>
      </div>)}
    </div>
    <DialogFooter>
      <Button variant="outline" onClick={onClose}>{t('multirun.overview.cancel')}</Button>
      <Button disabled={chosen.length === 0 || busy} onClick={() => {
        if (draftScope() !== scope) return;
        onUse(chosen.map((candidate) => candidate.text));
        onClose();
      }}>{t('multirun.prompts.useSelected', { count: chosen.length })}</Button>
    </DialogFooter>
  </>;
}

export function PromptCandidatesDialog({ open, onOpenChange, original, directory, initialModels, onUse }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  original: string;
  directory: string;
  initialModels: ModelSelectionWithId[];
  onUse: (texts: string[]) => void;
}): React.ReactNode {
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-w-3xl">
      <CandidateReview original={original} directory={directory} initialModels={initialModels} onUse={onUse} onClose={() => onOpenChange(false)} />
    </DialogContent>
  </Dialog>;
}
