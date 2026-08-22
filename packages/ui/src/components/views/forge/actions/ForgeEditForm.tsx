import React, { useState } from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { useI18n } from '@/lib/i18n';
import type { ForgeEntityRef, ForgeProvider } from '@/lib/forge/provider';

interface ForgeEditFormProps {
  provider: ForgeProvider;
  directory: string;
  ref: ForgeEntityRef;
  title: string;
  body?: string;
  onSaved?: () => void;
  onCancel?: () => void;
}

/**
 * Inline edit form for an issue/PR title and body. Renders nothing when the
 * provider has no `updateEntity` method. Saves both fields in one write and
 * reports through `onSaved`.
 */
export const ForgeEditForm: React.FC<ForgeEditFormProps> = ({ provider, directory, ref, title, body, onSaved, onCancel }) => {
  const { t } = useI18n();
  const [editTitle, setEditTitle] = useState(title);
  const [editBody, setEditBody] = useState(body ?? '');
  const [submitting, setSubmitting] = useState(false);

  const updateEntity = provider.updateEntity;
  if (!updateEntity) return null;

  const canSubmit = editTitle.trim().length > 0 && !submitting;

  const save = async (): Promise<void> => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const result = await updateEntity(directory, ref, { title: editTitle.trim(), body: editBody });
      if (!result.ok) {
        toast.error(t('forge.actions.error'));
        return;
      }
      toast.success(t('forge.actions.updated'));
      onSaved?.();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <Input
        value={editTitle}
        onChange={(event) => setEditTitle(event.target.value)}
        placeholder={t('forge.actions.edit')}
        aria-label={t('forge.actions.edit')}
        disabled={submitting}
      />
      <Textarea
        value={editBody}
        onChange={(event) => setEditBody(event.target.value)}
        placeholder={t('forge.actions.commentPlaceholder')}
        disabled={submitting}
        aria-label={t('forge.actions.commentPlaceholder')}
        className="min-h-[96px]"
      />
      <div className="flex items-center justify-end gap-1.5">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={submitting}>
          {t('forge.actions.cancel')}
        </Button>
        <Button size="sm" onClick={() => void save()} disabled={!canSubmit}>
          {submitting ? (
            <Icon name="loader-4" className="size-4 animate-spin" />
          ) : (
            <Icon name="check" className="size-4" />
          )}
          {t('forge.actions.save')}
        </Button>
      </div>
    </div>
  );
};
