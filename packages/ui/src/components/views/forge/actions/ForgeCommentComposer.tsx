import React, { useState } from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { useI18n } from '@/lib/i18n';
import type { ForgeEntityRef, ForgeProvider } from '@/lib/forge/provider';
import type { ForgeComment } from '@/lib/forge/types';

interface ForgeCommentComposerProps {
  provider: ForgeProvider;
  directory: string;
  ref: ForgeEntityRef;
  onPosted?: (comment: ForgeComment) => void;
}

/**
 * Comment composer for an issue or pull request thread. Renders nothing when
 * the provider has no `addComment` method. Posts through the facade and reports
 * the created comment via `onPosted`; failures toast a stable message.
 */
export const ForgeCommentComposer: React.FC<ForgeCommentComposerProps> = ({ provider, directory, ref, onPosted }) => {
  const { t } = useI18n();
  const [body, setBody] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const addComment = provider.addComment;
  if (!addComment) return null;

  const canSubmit = body.trim().length > 0 && !submitting;

  const submit = async (): Promise<void> => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const result = await addComment(directory, ref, { body: body.trim() });
      if (!result.ok) {
        toast.error(t('forge.actions.error'));
        return;
      }
      setBody('');
      if (result.comment) onPosted?.(result.comment);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <Textarea
        value={body}
        onChange={(event) => setBody(event.target.value)}
        placeholder={t('forge.actions.commentPlaceholder')}
        disabled={submitting}
        aria-label={t('forge.actions.commentPlaceholder')}
        className="min-h-[72px]"
      />
      <div className="flex justify-end">
        <Button size="sm" onClick={() => void submit()} disabled={!canSubmit}>
          {submitting ? (
            <>
              <Icon name="loader-4" className="size-4 animate-spin" />
              {t('forge.actions.posting')}
            </>
          ) : (
            <>
              <Icon name="chat-1" className="size-4" />
              {t('forge.actions.comment')}
            </>
          )}
        </Button>
      </div>
    </div>
  );
};
