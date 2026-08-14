import React, { useState } from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { useI18n } from '@/lib/i18n';
import type { ForgeEntityRef, ForgeProvider } from '@/lib/forge/provider';
import type { ForgeComment } from '@/lib/forge/types';
import { ForgeMentionTextarea } from './ForgeMentionTextarea';

/** Anchor of the thread being replied to (see `ForgeComment.inReplyToId`/`path`/`line`). */
export interface ForgeThreadTarget {
  inReplyToId: string;
  path?: string | null;
  line?: number | null;
}

interface ForgeThreadReplyProps {
  provider: ForgeProvider;
  directory: string;
  ref: ForgeEntityRef;
  thread: ForgeThreadTarget;
  onPosted?: (comment: ForgeComment) => void;
  onCancel?: () => void;
}

/**
 * Inline reply editor for one comment thread. Renders nothing when the
 * provider has no `replyToThread` method. The parent decides when the editor
 * is visible (expansion is driven from outside); posting clears the editor and
 * reports the created comment via `onPosted`.
 */
export const ForgeThreadReply: React.FC<ForgeThreadReplyProps> = ({ provider, directory, ref, thread, onPosted, onCancel }) => {
  const { t } = useI18n();
  const [body, setBody] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const replyToThread = provider.replyToThread;
  if (!replyToThread) return null;

  const canSubmit = body.trim().length > 0 && !submitting;

  const submit = async (): Promise<void> => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const result = await replyToThread(directory, ref, {
        body: body.trim(),
        inReplyToId: thread.inReplyToId,
        path: thread.path ?? null,
        line: thread.line ?? null,
      });
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
    <div className="flex flex-col gap-1.5">
      <ForgeMentionTextarea
        provider={provider}
        directory={directory}
        value={body}
        onChange={setBody}
        placeholder={t('forge.actions.commentPlaceholder')}
        disabled={submitting}
        ariaLabel={t('forge.actions.commentPlaceholder')}
        className="min-h-[56px]"
        autoFocus
      />
      <div className="flex items-center justify-end gap-1.5">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={submitting}>
          {t('forge.actions.cancel')}
        </Button>
        <Button size="sm" onClick={() => void submit()} disabled={!canSubmit}>
          {submitting ? (
            <Icon name="loader-4" className="size-4 animate-spin" />
          ) : (
            <Icon name="chat-1" className="size-4" />
          )}
          {t('forge.actions.reply')}
        </Button>
      </div>
    </div>
  );
};
