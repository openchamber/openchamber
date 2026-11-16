import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useI18n } from '@/lib/i18n';
import {
  answerOperatorChildrenDoneQuestion,
  getOperatorChildrenDoneQuestion,
  subscribeOperatorChildrenDoneQuestion,
} from '@/sync/operator-children-done';

export const OperatorChildrenDoneDialog = () => {
  const { t } = useI18n();
  const question = React.useSyncExternalStore(
    subscribeOperatorChildrenDoneQuestion,
    getOperatorChildrenDoneQuestion,
    getOperatorChildrenDoneQuestion,
  );
  const count = question?.titles.length ?? 0;
  const single = count === 1;

  return (
    <Dialog open={question !== null} onOpenChange={(open) => { if (!open) answerOperatorChildrenDoneQuestion('cancel'); }}>
      <DialogContent className="max-w-md" data-operator-children-done-dialog="">
        <DialogHeader>
          <DialogTitle>{t('sessions.operatorChildren.done.title')}</DialogTitle>
          <DialogDescription>
            {single
              ? t('sessions.operatorChildren.done.descriptionOne')
              : t('sessions.operatorChildren.done.descriptionMany', { count })}
          </DialogDescription>
        </DialogHeader>
        <ul className="max-h-40 space-y-1 overflow-y-auto rounded-lg bg-[var(--surface-muted)] px-3 py-2 typography-meta text-[var(--surface-foreground)]">
          {question?.titles.map((title, index) => (
            <li key={`${index}-${title}`} dir="auto" className="truncate">{title || t('sessions.sidebar.session.untitled')}</li>
          ))}
        </ul>
        <DialogFooter>
          <Button size="sm" variant="outline" autoFocus onClick={() => answerOperatorChildrenDoneQuestion('finish')}>
            {single ? t('sessions.operatorChildren.done.finishOne') : t('sessions.operatorChildren.done.finishMany')}
          </Button>
          <Button size="sm" variant="default" onClick={() => answerOperatorChildrenDoneQuestion('stop')}>
            {single ? t('sessions.operatorChildren.done.stopOne') : t('sessions.operatorChildren.done.stopMany')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
