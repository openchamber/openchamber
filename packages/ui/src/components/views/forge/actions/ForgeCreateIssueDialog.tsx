import React, { useState } from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { useI18n } from '@/lib/i18n';
import type { ForgeIssue } from '@/lib/forge';
import type { ForgeProvider } from '@/lib/forge/provider';

interface ForgeCreateIssueDialogProps {
  provider: ForgeProvider;
  directory: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (issue: ForgeIssue) => void;
}

/**
 * Create-issue dialog for a forge provider. Renders nothing when the provider
 * has no `createIssue` method. Submits title/body/labels (comma-separated
 * input) through the facade and reports success via `onCreated` so the list
 * can refresh.
 */
export const ForgeCreateIssueDialog: React.FC<ForgeCreateIssueDialogProps> = ({
  provider,
  directory,
  open,
  onOpenChange,
  onCreated,
}) => {
  const { t } = useI18n();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [labels, setLabels] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const createIssue = provider.createIssue;
  if (!createIssue) return null;

  const reset = (): void => {
    setTitle('');
    setBody('');
    setLabels('');
  };

  const handleOpenChange = (next: boolean): void => {
    if (!next) {
      reset();
    }
    onOpenChange(next);
  };

  const submit = async (): Promise<void> => {
    const trimmedTitle = title.trim();
    if (!trimmedTitle || submitting) return;
    setSubmitting(true);
    try {
      const labelList = labels
        .split(',')
        .map((label) => label.trim())
        .filter(Boolean);
      const result = await createIssue(directory, {
        title: trimmedTitle,
        ...(body.trim() ? { body: body.trim() } : {}),
        ...(labelList.length > 0 ? { labels: labelList } : {}),
      });
      if (!result.ok || !result.issue) {
        toast.error(t('forge.actions.error'));
        return;
      }
      toast.success(t('forge.actions.issueCreated'));
      reset();
      onOpenChange(false);
      onCreated?.(result.issue);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('forge.actions.issueDialogTitle')}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <Input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={t('forge.actions.issueTitlePlaceholder')}
            disabled={submitting}
            aria-label={t('forge.actions.issueTitlePlaceholder')}
          />
          <Textarea
            value={body}
            onChange={(event) => setBody(event.target.value)}
            placeholder={t('forge.actions.issueBodyPlaceholder')}
            disabled={submitting}
            aria-label={t('forge.actions.issueBodyPlaceholder')}
            className="min-h-[96px]"
          />
          <Input
            value={labels}
            onChange={(event) => setLabels(event.target.value)}
            placeholder={t('forge.actions.issueLabelsPlaceholder')}
            disabled={submitting}
            aria-label={t('forge.actions.issueLabelsPlaceholder')}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => handleOpenChange(false)} disabled={submitting}>
            {t('forge.actions.cancel')}
          </Button>
          <Button size="sm" onClick={() => void submit()} disabled={submitting || title.trim().length === 0}>
            {submitting ? <Icon name="loader-4" className="size-4 animate-spin" /> : <Icon name="check" className="size-4" />}
            {t('forge.actions.createIssue')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
