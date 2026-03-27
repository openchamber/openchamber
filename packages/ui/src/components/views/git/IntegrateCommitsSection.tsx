import * as React from 'react';
import { RiArrowDownSLine, RiLoader4Line, RiSplitCellsHorizontal, RiSparklingLine } from '@remixicon/react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { toast } from '@/components/ui';
import { useSessionStore } from '@/stores/useSessionStore';
import { useUIStore } from '@/stores/useUIStore';
import { execCommand } from '@/lib/execCommands';
import {
  abortIntegrate,
  computeIntegratePlan,
  continueIntegrate,
  integrateWorktreeCommits,
  getIntegrateConflictDetails,
  isCherryPickInProgress,
  type IntegrateConflictDetails,
  type IntegrateInProgress,
  type IntegratePlan,
} from '@/lib/git/integrateWorktreeCommits';
import type { WorktreeMetadata } from '@/types/worktree';

type IntegrateUiState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; plan: IntegratePlan }
  | { kind: 'running'; plan: IntegratePlan }
  | { kind: 'conflict'; state: IntegrateInProgress; details: IntegrateConflictDetails };

export const IntegrateCommitsSection: React.FC<{
  repoRoot: string;
  sourceBranch: string;
  worktreeMetadata: WorktreeMetadata;
  localBranches: string[];
  defaultTargetBranch: string;
  refreshKey?: number;
  onRefresh?: () => void;
}> = ({
  repoRoot,
  sourceBranch,
  worktreeMetadata,
  localBranches,
  defaultTargetBranch,
  refreshKey,
  onRefresh,
}) => {
  const currentSessionId = useSessionStore((s) => s.currentSessionId);
  const setActiveMainTab = useUIStore((s) => s.setActiveMainTab);
  const [branchDropdownOpen, setBranchDropdownOpen] = React.useState(false);
  const searchInputRef = React.useRef<HTMLInputElement>(null);

  const [targetBranch, setTargetBranch] = React.useState<string>(defaultTargetBranch);
  React.useEffect(() => {
    setTargetBranch(defaultTargetBranch);
  }, [defaultTargetBranch]);

  // Focus search input when branch dropdown opens
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

  const conflictStorageKey = React.useMemo(() => {
    if (!currentSessionId) return null;
    return `openchamber.integrate.conflict:${currentSessionId}`;
  }, [currentSessionId]);

  React.useEffect(() => {
    if (!conflictStorageKey || typeof window === 'undefined') return;
    const raw = window.localStorage.getItem(conflictStorageKey);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as IntegrateInProgress;
      if (!parsed?.tempWorktreePath || parsed.repoRoot !== repoRoot) {
        window.localStorage.removeItem(conflictStorageKey);
        return;
      }
      void (async () => {
        const ok = await isCherryPickInProgress(parsed.tempWorktreePath).catch(() => false);
        if (!ok) {
          window.localStorage.removeItem(conflictStorageKey);
          return;
        }
        const details = await getIntegrateConflictDetails(parsed.tempWorktreePath).catch(() => null);
        if (!details) {
          return;
        }
        setUi({ kind: 'conflict', state: parsed, details });
      })();
    } catch {
      window.localStorage.removeItem(conflictStorageKey);
    }
  }, [conflictStorageKey, repoRoot]);

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

        // Preload commit subjects for preview.
        if (plan.commits.length > 0) {
          const max = 50;
          // Show newest -> oldest.
          const subset = plan.commits.slice(-max).reverse();
          const quoted = subset.map((s) => JSON.stringify(s)).join(' ');
          const result = await execCommand(
            `git show -s --format=%H%x09%h%x09%s ${quoted}`,
            repoRoot
          );
          const lines = (result.stdout || '').split(/\r?\n/).filter(Boolean);
          const parsed: Array<{ sha: string; short: string; subject: string }> = [];
          for (const line of lines) {
            const [sha, short, subject] = line.split('\t');
            if (!sha || !short) continue;
            parsed.push({ sha, short, subject: subject || '' });
          }
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
  }, [isEligible, repoRoot, sourceBranch, targetBranch, refreshKey]);

  const persistTarget = React.useCallback(
    (branch: string) => {
      if (!currentSessionId) return;
      useSessionStore.getState().setWorktreeMetadata(currentSessionId, {
        ...worktreeMetadata,
        createdFromBranch: branch,
      });
    },
    [currentSessionId, worktreeMetadata]
  );

  const openNewSessionDraft = useSessionStore((s) => s.openNewSessionDraft);

  const buildConflictContext = React.useCallback((payload: { state: IntegrateInProgress; details: IntegrateConflictDetails }) => {
    const visibleText = `Resolve cherry-pick conflicts, stage the resolved files, and continue the cherry-pick. Keep intent of commit ${payload.state.currentCommit} onto branch ${payload.state.targetBranch}.`;
    const instructionsText = `Worktree commit integration (cherry-pick) is in progress with conflicts.
- Repo root: ${payload.state.repoRoot}
- Temp target worktree: ${payload.state.tempWorktreePath}
- Source branch: ${payload.state.sourceBranch}
- Target branch: ${payload.state.targetBranch}
- Current commit: ${payload.state.currentCommit}

Required steps:
1. Read each conflicted file in the temp worktree to understand the conflict markers (<<<<<<< HEAD, =======, >>>>>>> ...)
2. Edit each file to resolve conflicts by choosing the correct code or merging both changes appropriately
3. Stage all resolved files with: git add <file>
4. Complete the cherry-pick with: git cherry-pick --continue

Important:
- Work inside the temp worktree directory: ${payload.state.tempWorktreePath}
- Remove ALL conflict markers from files (<<<<<<< HEAD, =======, >>>>>>>)
- Preserve the intent of the commit being applied
- Make sure the final code is syntactically correct
- Do not leave any files with unresolved conflict markers
- After completing all steps, confirm the cherry-pick was successful
`;
    const payloadText = `Cherry-pick conflict context (JSON)\n${JSON.stringify({
      repoRoot: payload.state.repoRoot,
      tempWorktreePath: payload.state.tempWorktreePath,
      sourceBranch: payload.state.sourceBranch,
      targetBranch: payload.state.targetBranch,
      currentCommit: payload.state.currentCommit,
      remainingCommits: payload.state.remainingCommits,
      statusPorcelain: payload.details.statusPorcelain,
      unmergedFiles: payload.details.unmergedFiles,
      currentPatchMeta: payload.details.currentPatchMeta,
      currentPatch: payload.details.currentPatch,
      diff: payload.details.diff,
    }, null, 2)}`;

    return { visibleText, instructionsText, payloadText };
  }, []);

  const setPendingInputText = useSessionStore((s) => s.setPendingInputText);
  const setPendingSyntheticParts = useSessionStore((s) => s.setPendingSyntheticParts);

  const handleResolveWithAi = React.useCallback((
    payload: { state: IntegrateInProgress; details: IntegrateConflictDetails },
    useNewSession: boolean
  ) => {
    const context = buildConflictContext(payload);

    if (useNewSession) {
      // Open new session with the conflict context as initial prompt + synthetic parts
      openNewSessionDraft({
        directoryOverride: payload.state.tempWorktreePath,
        initialPrompt: context.visibleText,
        syntheticParts: [
          { text: context.instructionsText, synthetic: true },
          { text: context.payloadText, synthetic: true },
        ],
      });
      // Navigate to chat tab so user sees the new session
      setActiveMainTab('chat');
      return;
    }

    // Use current session - set pending input text and synthetic parts
    if (!currentSessionId) {
      toast.error('No active session', { description: 'Open a chat session first or start a new session.' });
      return;
    }

    setPendingInputText(context.visibleText, 'replace');
    setPendingSyntheticParts([
      { text: context.instructionsText, synthetic: true },
      { text: context.payloadText, synthetic: true },
    ]);
    setActiveMainTab('chat');
  }, [currentSessionId, setActiveMainTab, buildConflictContext, openNewSessionDraft, setPendingInputText, setPendingSyntheticParts]);

  const handleMove = React.useCallback(async () => {
    if (ui.kind !== 'ready') return;
    if (ui.plan.commits.length === 0) {
      toast.message('No commits to move');
      return;
    }
    setUi({ kind: 'running', plan: ui.plan });
    try {
      const result = await integrateWorktreeCommits(ui.plan);
      if (result.kind === 'success') {
        toast.success('Commits moved', {
          description: `${result.moved} commit${result.moved === 1 ? '' : 's'} into ${ui.plan.targetBranch}`,
        });
        const next = await computeIntegratePlan(ui.plan);
        setUi({ kind: 'ready', plan: next });
        onRefresh?.();
        return;
      }
      if (result.kind === 'conflict') {
        toast.error('Cherry-pick conflict', { description: 'Resolve conflicts, then continue.' });
        setUi({ kind: 'conflict', state: result.state, details: result.details });
        if (conflictStorageKey && typeof window !== 'undefined') {
          window.localStorage.setItem(conflictStorageKey, JSON.stringify(result.state));
        }
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      toast.error('Failed to move commits', { description: message });
      const next = await computeIntegratePlan({ repoRoot, sourceBranch, targetBranch }).catch(() => null);
      if (next) setUi({ kind: 'ready', plan: next });
      else setUi({ kind: 'idle' });
    }
  }, [ui, onRefresh, repoRoot, sourceBranch, targetBranch, conflictStorageKey]);

  const handleAbort = React.useCallback(async () => {
    if (ui.kind !== 'conflict') return;
    try {
      await abortIntegrate(ui.state);
      toast.message('Cherry-pick aborted');
      if (conflictStorageKey && typeof window !== 'undefined') {
        window.localStorage.removeItem(conflictStorageKey);
      }
    } finally {
      const next = await computeIntegratePlan({ repoRoot, sourceBranch, targetBranch }).catch(() => null);
      if (next) setUi({ kind: 'ready', plan: next });
      else setUi({ kind: 'idle' });
    }
  }, [ui, repoRoot, sourceBranch, targetBranch, conflictStorageKey]);

  const handleContinue = React.useCallback(async () => {
    if (ui.kind !== 'conflict') return;
    try {
      const result = await continueIntegrate(ui.state);
      if (result.kind === 'success') {
        toast.success('Cherry-pick finished');
        const next = await computeIntegratePlan({ repoRoot, sourceBranch, targetBranch }).catch(() => null);
        if (next) setUi({ kind: 'ready', plan: next });
        else setUi({ kind: 'idle' });
        if (conflictStorageKey && typeof window !== 'undefined') {
          window.localStorage.removeItem(conflictStorageKey);
        }
        onRefresh?.();
        return;
      }
      if (result.kind === 'conflict') {
        setUi({ kind: 'conflict', state: result.state, details: result.details });
        if (conflictStorageKey && typeof window !== 'undefined') {
          window.localStorage.setItem(conflictStorageKey, JSON.stringify(result.state));
        }
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      toast.error('Cherry-pick continue failed', { description: message });
    }
  }, [ui, repoRoot, sourceBranch, targetBranch, onRefresh, conflictStorageKey]);

  if (!repoRoot || !sourceBranch) {
    return null;
  }

  const containerClassName = 'border-0 bg-transparent rounded-none';
  const headerClassName = 'px-0 py-3 border-b border-border/40 flex items-center justify-between gap-2';
  const bodyClassName = 'flex flex-col gap-3 py-3';

  return (
    <section className={containerClassName}>
      <div className={headerClassName}>
        <div className="flex items-center gap-2 min-w-0">
          <RiSplitCellsHorizontal className="size-4 text-muted-foreground" />
          <h3 className="typography-ui-header font-semibold text-foreground truncate">Re-integrate commits</h3>
          {ui.kind === 'ready' && ui.plan.commits.length > 0 ? (
            <span className="typography-meta text-muted-foreground truncate">{ui.plan.commits.length} to move</span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {ui.kind === 'loading' || ui.kind === 'running' ? (
            <RiLoader4Line className="size-4 animate-spin text-muted-foreground" />
          ) : null}
        </div>
      </div>

      <div className={bodyClassName}>
        <div className="flex flex-wrap items-center gap-2">
          <div className="min-w-0">
            <div className="typography-ui-label text-foreground">Move commits</div>
              <div className="typography-micro text-muted-foreground truncate">
                {sourceBranch} → {targetBranch}
              </div>
            </div>

            <div className="flex-1" />

            <DropdownMenu open={branchDropdownOpen} onOpenChange={setBranchDropdownOpen}>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="gap-1.5">
                  Target
                  <span className="max-w-[160px] truncate font-mono text-xs text-muted-foreground">{targetBranch}</span>
                  <RiArrowDownSLine className="size-4 opacity-60" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                className="w-72 p-0 max-h-(--radix-dropdown-menu-content-available-height) flex flex-col overflow-hidden"
              >
                <Command className="h-full min-h-0">
                  <CommandInput ref={searchInputRef} placeholder="Search branches..." />
                  <CommandList
                    className="h-full min-h-0"
                    scrollbarClassName="overlay-scrollbar--flush overlay-scrollbar--dense overlay-scrollbar--zero"
                    disableHorizontal
                  >
                    <CommandEmpty>No branches found.</CommandEmpty>
                    <CommandGroup heading="Local branches">
                      {localBranches.map((branch) => (
                        <CommandItem
                          key={branch}
                          value={branch}
                          onSelect={() => {
                            setTargetBranch(branch);
                            persistTarget(branch);
                            setBranchDropdownOpen(false);
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
              <Button size="sm" onClick={() => void handleMove()} disabled={!isEligible || ui.plan.commits.length === 0}>
                Move
              </Button>
            ) : ui.kind === 'loading' ? (
              <Button size="sm" variant="outline" disabled>
                Checking…
              </Button>
            ) : ui.kind === 'running' ? (
              <Button size="sm" variant="outline" disabled>
                Moving…
              </Button>
            ) : null}
          </div>

          {ui.kind === 'ready' && ui.plan.commits.length === 0 && (
            <div className="typography-meta text-muted-foreground">No commits to move.</div>
          )}

          {ui.kind === 'ready' && ui.plan.commits.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div className="typography-meta text-foreground">
                  Commits to move
                  <span className="text-muted-foreground"> ({ui.plan.commits.length})</span>
                </div>
                {commitSummaries.length > 0 && ui.plan.commits.length > 5 && (
                  <button
                    type="button"
                    onClick={() => setShowAllCommits((v) => !v)}
                    className="typography-micro text-muted-foreground hover:text-foreground"
                  >
                    {showAllCommits ? 'Show less' : 'Show all'}
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
                  <div className="typography-meta text-muted-foreground">Preview unavailable.</div>
                )}
                {ui.plan.commits.length > commitSummaries.length && (
                  <div className="typography-micro text-muted-foreground/70">
                    Showing first {commitSummaries.length} commits.
                  </div>
                )}
              </div>
            </div>
          )}

          {ui.kind === 'conflict' && (
            <div className="rounded-md border border-border/60 bg-background/60 p-3 space-y-2">
              <div className="typography-meta text-foreground">
                Conflicts in {ui.details.unmergedFiles.length} files
              </div>
              <div className="typography-micro text-muted-foreground/80">
                Current commit: <span className="font-mono">{ui.state.currentCommit.slice(0, 7)}</span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {ui.details.unmergedFiles.slice(0, 6).map((file) => (
                  <span key={file} className="font-mono text-xs px-2 py-0.5 rounded bg-muted/40 text-muted-foreground">
                    {file}
                  </span>
                ))}
                {ui.details.unmergedFiles.length > 6 && (
                  <span className="text-xs text-muted-foreground">+{ui.details.unmergedFiles.length - 6} more</span>
                )}
              </div>
              <div className="flex items-center gap-2 pt-1">
                <Button size="sm" variant="ghost" className="typography-meta" onClick={() => void handleAbort()}>
                  Abort
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  className="typography-meta gap-1"
                  disabled={!currentSessionId}
                  onClick={() => void handleResolveWithAi({ state: ui.state, details: ui.details }, false)}
                >
                  <RiSparklingLine className="size-3.5" />
                  Current Session
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  className="typography-meta gap-1"
                  onClick={() => void handleResolveWithAi({ state: ui.state, details: ui.details }, true)}
                >
                  <RiSparklingLine className="size-3.5" />
                  New Session
                </Button>
                <Button size="sm" className="typography-meta" onClick={() => void handleContinue()}>
                  Continue
                </Button>
              </div>
            </div>
          )}
      </div>
    </section>
  );
};
