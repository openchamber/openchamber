import React from 'react';
import { useI18n } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { RUN_GUIDANCE_LIMIT } from '@/lib/multirun/identity';

export function FusionGuidance({ saved, disabled, onSave }: {
  saved: string;
  disabled: boolean;
  onSave: (text: string) => Promise<void>;
}): React.ReactNode {
  const { t } = useI18n();
  const [draft, setDraft] = React.useState(saved);
  const [error, setError] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const previousSaved = React.useRef(saved);
  React.useEffect(() => {
    const previous = previousSaved.current;
    setDraft((text) => text === previous ? saved : text);
    previousSaved.current = saved;
  }, [saved]);
  const save = async () => {
    if (saving) return;
    setSaving(true);
    setError(false);
    try { await onSave(draft); }
    catch { setError(true); }
    finally { setSaving(false); }
  };
  return (
    <div className="flex flex-col gap-1">
      <Textarea value={draft} onChange={(event) => setDraft(event.target.value)} maxLength={RUN_GUIDANCE_LIMIT} aria-label={t('multirun.fusion.guidance')} placeholder={t('multirun.fusion.guidance')} className="min-h-20 typography-meta" />
      <div className="flex items-center justify-between gap-2">
        <span className="h-5 truncate typography-micro text-muted-foreground" role={error ? 'alert' : undefined}>
          {error ? t('multirun.fusion.guidanceFailed') : t('multirun.fusion.guidanceHint')}
        </span>
        <Button variant="outline" size="xs" disabled={disabled || saving || draft.trim() === saved} onClick={() => void save()}>{t('multirun.fusion.saveGuidance')}</Button>
      </div>
    </div>
  );
}
