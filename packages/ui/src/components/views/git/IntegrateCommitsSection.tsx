import * as React from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { dropdownTriggerVariants } from '@/components/ui/dropdown-trigger';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { toast } from '@/components/ui';
import { Icon } from "@/components/icon/Icon";
import { useSessionUIStore } from '@/sync/session-ui-store';
import { rankByQuery } from '@/lib/search/fuzzySearch';
import { getGitCommitSummaries } from '@/lib/gitApi';
import {
  computeIntegratePlan,
  integrateWorktreeCommits,
  type IntegrateConflict,
  type IntegratePlan,
} from '@/lib/git/integrateWorktreeCommits';
import { captureRuntimeInstance } from '@/lib/runtime-switch';
import type { WorktreeMetadata } from '@/types/worktree';
import { useI18n } from '@/lib/i18n';
import { ButtonTooltip } from '@/components/ui/action-toolbar';

type IntegrateUiState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; plan: IntegratePlan }
  | { kind: 'running'; plan: IntegratePlan };

export const IntegrateCommitsSection: React.FC<{
  repoRoot: string;
  sourceBranch: string;
  worktreeMetadata: WorktreeMetadata;
  localBranches: string[];
  defaultTargetBranch: string;
  openConflicts: readonly IntegrateConflict[];
  onConflict: () => Promise<void>;
  refreshKey?: number;
  onRefresh?: () => void;
  showHeader?: boolean;
}> = ({
  repoRoot,
  sourceBranch,
  worktreeMetadata,
  localBranches,
  defaultTargetBranch,
  openConflicts,
  onConflict,
  refreshKey,
  onRefresh,
  showHeader = true,
}) => {
  const { t } = useI18n();
  const currentSessionId = useSessionUIStore((s) => s.currentSessionId);
  const [branchDropdownOpen, setBranchDropdownOpen] = React.useState(false);
  const [branchSearch, setBranchSearch] = React.useState('');
  const searchInputRef = React.useRef<HTMLInputElement>(null);

  const filteredBranches = React.useMemo(
    () => rankByQuery(localBranches, branchSearch, (branch) => [branch]),
    [localBranches, branchSearch]
  );

  const [targetBranch, setTargetBranch] = React.useState<string>(defaultTargetBranch);
  React.useEffect(() => {
    setTargetBranch(defaultTargetBranch);
  }, [defaultTargetBranch]);

  React.useEffect(() => {
    if (branchDropdownOpen) {
      const timer = setTimeout(() => {
        searchInputRef.current?.focus();
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [branchDropdownOpen]);

  const isEligible = Boolean(
    repoRoot && sourceBranch && targetBranch && targetBranch !== 'HEAD' && sourceBranch !== targetBranch
  );

  const [ui, setUi] = React.useState<IntegrateUiState>({ kind: 'idle' });
  const [showAllCommits, setShowAllCommits] = React.useState(false);
  const [commitSummaries, setCommitSummaries] = React.useState<Array<{ sha: string; short: string; subject: string }>>([]);

  React.useEffect(() => {
    if (!isEligible) {
      setUi({ kind: 'idle' });
      return;
    }
    let cancelled = false;
    setUi({ kind: 'loading' });
    void (async () => {
      try {
        const plan = await computeIntegratePlan({ repoRoot, sourceBranch, targetBranch });
        if (cancelled) return;
        setUi({ kind: 'ready', plan });

        if (plan.commits.length > 0) {
          const max = 50;
          const subset = plan.commits.slice(-max).reverse();
          const parsed = await getGitCommitSummaries(repoRoot, subset);
          if (!cancelled) {
            setCommitSummaries(parsed);
            setShowAllCommits(false);
          }
        } else {
          if (!cancelled) {
            setCommitSummaries([]);
            setShowAllCommits(false);
          }
        }
      } catch {
        if (!cancelled) setUi({ kind: 'idle' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isEligible, repoRoot, sourceBranch, targetBranch, refreshKey, openConflicts.length]);

  const persistTarget = React.useCallback(
    (branch: string) => {
      if (!currentSessionId) return;
      useSessionUIStore.getState().setWorktreeMetadata(currentSessionId, {
        ...worktreeMetadata,
        createdFromBranch: branch,
      });
    },
    [currentSessionId, worktreeMetadata]
  );

  const handleMove = React.useCallback(async () => {
    if (ui.kind !== 'ready') return;
    if (ui.plan.commits.length === 0) {
      toast.message(t('gitView.integrate.noCommitsToMoveToast'));
      return;
    }
    const isCurrent = captureRuntimeInstance();
    setUi({ kind: 'running', plan: ui.plan });
    try {
      const result = await integrateWorktreeCommits(ui.plan);
      if (!isCurrent()) return;
      if (result.kind === 'success') {
        toast.success(t('gitView.integrate.commitsMovedToast'), {
          description: result.moved === 1
            ? t('gitView.integrate.commitsMovedDescriptionSingle', { count: result.moved, branch: ui.plan.targetBranch })
            : t('gitView.integrate.commitsMovedDescriptionPlural', { count: result.moved, branch: ui.plan.targetBranch }),
        });
        const next = await computeIntegratePlan(ui.plan);
        if (!isCurrent()) return;
        setUi({ kind: 'ready', plan: next });
        onRefresh?.();
        return;
      }
      if (result.kind === 'conflict') {
        if (result.reason === 'alreadyOpen') toast.message(t('gitView.integrate.conflict.alreadyOpen'));
        else toast.error(t('gitView.integrate.cherryPickConflictToast'), { description: t('gitView.integrate.cherryPickConflictDescription') });
        await onConflict();
      }
      if (result.kind === 'busy') toast.error(t('gitView.integrate.conflict.busy'));
      setUi({ kind: 'ready', plan: ui.plan });
    } catch (e) {
      if (!isCurrent()) return;
      const message = e instanceof Error ? e.message : String(e);
      toast.error(t('gitView.integrate.failedToMoveToast'), { description: message });
      const next = await computeIntegratePlan({ repoRoot, sourceBranch, targetBranch }).catch(() => null);
      if (next) setUi({ kind: 'ready', plan: next });
      else setUi({ kind: 'idle' });
    }
  }, [ui, onRefresh, repoRoot, sourceBranch, targetBranch, onConflict, t]);

  if (!repoRoot || !sourceBranch) {
    return null;
  }

  const containerClassName = 'border-0 bg-transparent rounded-none';
  const headerClassName = 'px-0 py-3 border-b border-edge-muted flex items-center justify-between gap-2';
  const bodyClassName = 'flex flex-col gap-3 py-3';

  return (
    <section className={containerClassName}>
      {showHeader ? (
        <div className={headerClassName}>
          <div className="flex items-center gap-2 min-w-0">
            <Icon name="split-cells-horizontal" className="size-4 text-muted-foreground" />
            <h3 className="typography-ui-header font-semibold text-foreground truncate">{t('gitView.integrate.title')}</h3>
            {ui.kind === 'ready' && ui.plan.commits.length > 0 ? (
              <span className="typography-meta text-muted-foreground truncate">
                {t('gitView.integrate.toMoveCount', { count: ui.plan.commits.length })}
              </span>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            {ui.kind === 'loading' || ui.kind === 'running' ? (
              <Icon name="loader-4" className="size-4 animate-spin text-muted-foreground" />
            ) : null}
          </div>
        </div>
      ) : null}

      <div className={bodyClassName}>
        <div className="flex flex-wrap items-center gap-2">
          <div className="min-w-0">
            <div className="typography-ui-label text-foreground">{t('gitView.integrate.moveCommits')}</div>
              <div className="typography-micro text-muted-foreground truncate">
                {sourceBranch} → {targetBranch}
              </div>
            </div>

            <div className="flex-1" />

            <DropdownMenu open={branchDropdownOpen} onOpenChange={setBranchDropdownOpen}>
              <ButtonTooltip sideOffset={8} label={t('contextTooltips.git.integrateTarget')}>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className={dropdownTriggerVariants({ size: 'default' })}
                  >
                    {t('gitView.integrate.target')}
                    <span className="max-w-[160px] truncate font-mono text-xs text-muted-foreground">{targetBranch}</span>
                    <Icon name="arrow-down-s" className="size-4 opacity-60" />
                  </button>
                </DropdownMenuTrigger>
              </ButtonTooltip>
              <DropdownMenuContent
                align="end"
                className="w-72 p-0 max-h-[var(--available-height)] flex flex-col overflow-hidden"
              >
                {/* external: https://github.com/dip/cmdk#command-commandmenu Disable cmdk filtering to preserve rankByQuery's ordering. */}
                <Command className="h-full min-h-0" shouldFilter={false}>
                  <CommandInput
                    ref={searchInputRef}
                    placeholder={t('gitView.branch.searchPlaceholder')}
                    value={branchSearch}
                    onValueChange={setBranchSearch}
                    onKeyDown={(event) => event.stopPropagation()}
                  />
                  <CommandList
                    className="h-full min-h-0"
                    scrollbarClassName="overlay-scrollbar--flush overlay-scrollbar--dense overlay-scrollbar--zero"
                    disableHorizontal
                  >
                    <CommandEmpty>{t('gitView.branch.empty')}</CommandEmpty>
                    <CommandGroup heading={t('gitView.branch.localBranches')}>
                      {filteredBranches.map((branch) => (
                        <CommandItem
                          key={branch}
                          value={branch}
                          onSelect={() => {
                            setTargetBranch(branch);
                            persistTarget(branch);
                            setBranchDropdownOpen(false);
                            setBranchSearch('');
                          }}
                        >
                          {branch}
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </DropdownMenuContent>
            </DropdownMenu>

            {ui.kind === 'ready' ? (
              <ButtonTooltip sideOffset={8} label={t('contextTooltips.git.integrateMove')}>
                <Button size="sm" onClick={() => void handleMove()} disabled={!isEligible || ui.plan.commits.length === 0 || openConflicts.some((conflict) => conflict.state.targetBranch === targetBranch)}>
                  {t('gitView.integrate.move')}
                </Button>
              </ButtonTooltip>
            ) : ui.kind === 'loading' ? (
              <Button size="sm" variant="outline" disabled>
                {t('gitView.integrate.checking')}
              </Button>
            ) : ui.kind === 'running' ? (
              <Button size="sm" variant="outline" disabled>
                {t('gitView.integrate.moving')}
              </Button>
            ) : null}
          </div>

          {ui.kind === 'ready' && ui.plan.commits.length === 0 && (
            <div className="typography-meta text-muted-foreground">{t('gitView.integrate.noCommitsToMove')}</div>
          )}

          {ui.kind === 'ready' && ui.plan.commits.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div className="typography-meta text-foreground">
                  {t('gitView.integrate.commitsToMove')}
                  <span className="text-muted-foreground"> ({ui.plan.commits.length})</span>
                </div>
                {commitSummaries.length > 0 && ui.plan.commits.length > 5 && (
                  <button
                    type="button"
                    onClick={() => setShowAllCommits((v) => !v)}
                    className="typography-micro text-muted-foreground hover:text-foreground"
                  >
                    {showAllCommits ? t('gitView.integrate.showLess') : t('gitView.integrate.showAll')}
                  </button>
                )}
              </div>

              <div className="space-y-1">
                {(showAllCommits ? commitSummaries : commitSummaries.slice(0, 5)).map((c) => (
                  <div key={c.sha} className="flex items-baseline gap-2 min-w-0">
                    <span className="font-mono text-xs text-muted-foreground flex-shrink-0">{c.short}</span>
                    <span className="typography-meta text-muted-foreground truncate">{c.subject || c.sha}</span>
                  </div>
                ))}
                {commitSummaries.length === 0 && (
                  <div className="typography-meta text-muted-foreground">{t('gitView.integrate.previewUnavailable')}</div>
                )}
                {ui.plan.commits.length > commitSummaries.length && (
                  <div className="typography-micro text-muted-foreground">
                    {t('gitView.integrate.showingFirstCommits', { count: commitSummaries.length })}
                  </div>
                )}
              </div>
            </div>
          )}
      </div>
    </section>
  );
};
