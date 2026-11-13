import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/lib/i18n';

import type { ChangeIdPreflight } from './changeIdPreflight';

/**
 * The push-for-review form of a review host, in place of a pull request's
 * title and description: the commit message is the change's description, so
 * its subject shows read only. Topic, hashtags, work in progress and private
 * go with the push. Under them, what the Change-Id check found: nothing to
 * send, the checked-out commit without one (with a way to add it), or older
 * commits without one, which hold the push back.
 */
export const ReviewPushFields: React.FC<{
  preflight: ChangeIdPreflight | null;
  topic: string;
  onTopicChange: (topic: string) => void;
  hashtags: string;
  onHashtagsChange: (hashtags: string) => void;
  wip: boolean;
  onWipChange: (wip: boolean) => void;
  privateChange: boolean;
  onPrivateChange: (privateChange: boolean) => void;
  /** Amends the checked-out commit with a Change-Id; absent where the runtime cannot. */
  onAddChangeId?: () => void;
  disabled: boolean;
}> = ({ preflight, topic, onTopicChange, hashtags, onHashtagsChange, wip, onWipChange, privateChange, onPrivateChange, onAddChangeId, disabled }) => {
  const { t } = useI18n();
  const ready = preflight?.status === 'ready' ? preflight : null;

  let notice: React.ReactNode = null;
  if (ready?.commits === 0) {
    notice = <span className="text-muted-foreground">{t('gitView.change.push.nothingToPush')}</span>;
  } else if (ready?.missing === 'tip') {
    notice = (
      <>
        <span className="min-w-0 flex-1 text-[var(--status-warning)]">{t('gitView.change.changeId.missingTip')}</span>
        {onAddChangeId ? (
          <Button size="xs" variant="outline" className="shrink-0" onClick={onAddChangeId} disabled={disabled}>
            {t('gitView.change.changeId.add')}
          </Button>
        ) : null}
      </>
    );
  } else if (ready?.missing === 'many') {
    notice = <span className="text-[var(--status-warning)]">{t('gitView.change.changeId.missingMany', { count: ready.missingCount })}</span>;
  } else if (preflight?.status === 'error') {
    notice = <span className="text-[var(--status-error-text)]">{t('gitView.change.push.readFailed')}</span>;
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="space-y-1">
        <div className="typography-micro text-muted-foreground">{t('gitView.change.push.subject')}</div>
        <div className="min-h-5 truncate typography-ui-label text-foreground" title={ready?.subject ?? undefined}>
          {ready?.subject ?? (preflight?.status === 'loading' ? <Icon name="loader-4" className="size-3.5 animate-spin text-muted-foreground" /> : null)}
        </div>
        <div className="typography-micro text-muted-foreground">{t('gitView.change.push.subjectHint')}</div>
      </div>
      <div className="flex flex-col gap-3">
        <label className="space-y-1">
          <div className="typography-micro text-muted-foreground">{t('gitView.change.push.topic')}</div>
          <Input value={topic} onChange={(event) => onTopicChange(event.target.value)} placeholder={t('gitView.change.push.optional')} disabled={disabled} />
        </label>
        <label className="space-y-1">
          <div className="typography-micro text-muted-foreground">{t('gitView.change.push.hashtags')}</div>
          <Input value={hashtags} onChange={(event) => onHashtagsChange(event.target.value)} placeholder={t('gitView.change.push.hashtagsPlaceholder')} disabled={disabled} />
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <label className="flex cursor-pointer items-center gap-2 typography-meta text-foreground">
          <Checkbox checked={wip} onChange={onWipChange} disabled={disabled} ariaLabel={t('gitView.change.push.wip')} />
          {t('gitView.change.push.wip')}
        </label>
        <label className="flex cursor-pointer items-center gap-2 typography-meta text-foreground">
          <Checkbox checked={privateChange} onChange={onPrivateChange} disabled={disabled} ariaLabel={t('gitView.change.push.private')} />
          {t('gitView.change.push.private')}
        </label>
      </div>
      {/* One reserved line for what the Change-Id check says, so the form keeps its height. */}
      <div className="flex min-h-7 items-center gap-2 typography-micro">{notice}</div>
    </div>
  );
};
