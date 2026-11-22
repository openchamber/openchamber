import React from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useI18n } from '@/lib/i18n';
import type { PromptGenerationSession } from '@/lib/multirun/identity';
import { loadPromptGenerationSession } from '@/lib/multirun/promptCandidates';

function GenerationHistory({ sources }: { sources: readonly PromptGenerationSession[] }): React.ReactNode {
  const { t } = useI18n();
  const [selected, setSelected] = React.useState(sources[0]?.sessionID ?? '');
  const [retry, setRetry] = React.useState(0);
  const [record, setRecord] = React.useState<{ state: 'loading' | 'error' } | { state: 'ready'; request: string | null; result: string | null }>({ state: 'loading' });
  const source = sources.find((entry) => entry.sessionID === selected);
  const sessionID = source?.sessionID;
  const directory = source?.directory;
  React.useEffect(() => {
    if (!sessionID || !directory) return;
    let cancelled = false;
    setRecord({ state: 'loading' });
    loadPromptGenerationSession({ sessionID, directory }).then((value) => {
      if (!cancelled) setRecord({ state: 'ready', ...value });
    }, () => { if (!cancelled) setRecord({ state: 'error' }); });
    return () => { cancelled = true; };
  }, [sessionID, directory, retry]);
  return <>
    <DialogHeader>
      <DialogTitle>{t('multirun.prompts.history')}</DialogTitle>
      <DialogDescription>{t('multirun.prompts.historyHint')}</DialogDescription>
    </DialogHeader>
    <div className="flex gap-1 overflow-x-auto">
      {sources.map((source) => <Button key={source.sessionID} variant="chip" size="sm" aria-pressed={source.sessionID === selected} onClick={() => setSelected(source.sessionID)} className="shrink-0 max-w-64">
        <span dir="ltr" className="truncate">{source.providerID}/{source.modelID}{source.variant ? `#${source.variant}` : ''}</span>
      </Button>)}
    </div>
    <div className="flex h-6 items-center gap-2 typography-meta text-muted-foreground" role={record.state === 'error' ? 'alert' : 'status'}>
      <span className="truncate">{record.state === 'error' ? t('multirun.prompts.historyFailed') : record.state === 'loading' ? t('multirun.prompts.loadingHistory') : ''}</span>
      {record.state === 'error' ? <Button size="xs" variant="outline" onClick={() => setRetry((value) => value + 1)}>{t('contextPanel.preview.actions.retry')}</Button> : null}
    </div>
    <label className="typography-meta">{t('multirun.prompts.request')}
      <Textarea readOnly value={record.state === 'ready' ? record.request ?? '' : ''} placeholder={record.state === 'ready' && record.request === null ? t('multirun.prompts.missingRecord') : undefined} className="mt-1 h-40 resize-none overflow-y-auto" />
    </label>
    <label className="typography-meta">{t('multirun.prompts.output')}
      <Textarea readOnly value={record.state === 'ready' ? record.result ?? '' : ''} placeholder={record.state === 'ready' && record.result === null ? t('multirun.prompts.missingRecord') : undefined} className="mt-1 h-48 resize-none overflow-y-auto" />
    </label>
  </>;
}

export function PromptGenerationHistoryDialog({ open, onOpenChange, sources }: { open: boolean; onOpenChange: (value: boolean) => void; sources: readonly PromptGenerationSession[] }): React.ReactNode {
  const { t } = useI18n();
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-w-3xl">
      <GenerationHistory sources={sources} />
      <DialogFooter><Button variant="outline" onClick={() => onOpenChange(false)}>{t('multirun.overview.cancel')}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}
