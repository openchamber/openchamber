import React from 'react';
import { useI18n } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  getContributorDestinationLabelKey,
  type ContributorDestinationCandidate,
} from './contributorDestination';

export const ContributorDestinationDialog: React.FC<{
  candidates: ContributorDestinationCandidate[] | null;
  onSelect: (name: string | null) => void;
}> = ({ candidates, onSelect }) => {
  const { t } = useI18n();
  return (
    <Dialog open={Boolean(candidates)} onOpenChange={(open) => { if (!open) onSelect(null); }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{t('gitView.publish.title')}</DialogTitle>
          <DialogDescription>{t('gitView.contributor.chooseDestination')}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          {candidates?.map((candidate) => (
            <Button key={candidate.remote.name} size="sm" variant="outline" onClick={() => onSelect(candidate.remote.name)}>
              <span className="flex min-w-0 flex-1 items-center justify-between gap-3">
                <span className="truncate">{candidate.remote.name}</span>
                <span className="typography-meta text-muted-foreground">
                  {t(getContributorDestinationLabelKey(candidate.classification))}
                </span>
              </span>
            </Button>
          ))}
        </div>
        <DialogFooter>
          <Button size="sm" variant="ghost" onClick={() => onSelect(null)}>{t('gitView.common.cancel')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
