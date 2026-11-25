import React from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useI18n } from '@/lib/i18n';
import type { IntegrateConflict } from '@/lib/git/integrateWorktreeCommits';
import type { WorktreeMetadata } from '@/types/worktree';
import { IntegrateCommitsSection } from './IntegrateCommitsSection';
import { IntegrateConflictCard } from './IntegrateConflictCard';

export const IntegrateCommitsDialog: React.FC<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  directory: string;
  source: { repoRoot: string; sourceBranch: string; worktreeMetadata: WorktreeMetadata } | null;
  conflicts: readonly IntegrateConflict[];
  onReloadConflicts: () => Promise<void>;
  localBranches: string[];
  defaultTargetBranch: string;
  refreshKey: number;
  onRefresh: () => void;
}> = ({ open, onOpenChange, directory, source, conflicts, onReloadConflicts, localBranches, defaultTargetBranch, refreshKey, onRefresh }) => {
  const { t } = useI18n();
  const [settled, setSettled] = React.useState(0);
  const settle = () => {
    setSettled((value) => value + 1);
    onRefresh();
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl min-h-[26rem]">
        <DialogHeader>
          <DialogTitle>{t('gitView.integrate.title')}</DialogTitle>
          <DialogDescription>
            {source ? (
              <span className="font-mono text-foreground">{source.sourceBranch} → {defaultTargetBranch}</span>
            ) : null}
          </DialogDescription>
        </DialogHeader>
        {source ? (
          <IntegrateCommitsSection
            key={source.worktreeMetadata.path}
            repoRoot={source.repoRoot}
            sourceBranch={source.sourceBranch}
            worktreeMetadata={source.worktreeMetadata}
            localBranches={localBranches}
            defaultTargetBranch={defaultTargetBranch}
            openConflicts={conflicts.filter((conflict) => conflict.state.sourceBranch === source.sourceBranch)}
            onConflict={onReloadConflicts}
            refreshKey={refreshKey + settled}
            showHeader={false}
            onRefresh={onRefresh}
          />
        ) : null}
        {conflicts.length > 0 ? (
          <div className="flex flex-col gap-3">
            {conflicts.map((conflict) => (
              <IntegrateConflictCard
                key={conflict.state.tempWorktreePath}
                conflict={conflict}
                directory={directory}
                onActed={onReloadConflicts}
                onSettled={settle}
              />
            ))}
          </div>
        ) : null}
        {!source && conflicts.length === 0 ? (
          <div className="typography-meta text-muted-foreground">{t('gitView.integrate.noCommitsToMove')}</div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
};
