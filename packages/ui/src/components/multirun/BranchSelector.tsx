import React from 'react';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useGitStore, useGitBranches } from '@/stores/useGitStore';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { getRootBranch } from '@/lib/worktrees/worktreeStatus';

/** localStorage key matching NewWorktreeDialog */
const LAST_SOURCE_BRANCH_KEY = 'oc:lastWorktreeSourceBranch';

export type WorktreeBaseOption = {
  value: string;
  label: string;
  group: 'special' | 'local' | 'remote';
};

export interface BranchSelectorProps {
  /** Current directory to check for git repository */
  directory: string | null;
  /** Currently selected branch */
  value: string;
  /** Called when branch selection changes */
  onChange: (branch: string) => void;
  /** Optional className for the trigger */
  className?: string;
  /** Whether the selector is disabled */
  disabled?: boolean;
  /** ID for accessibility */
  id?: string;
}

export interface BranchSelectorState {
  localBranches: string[];
  remoteBranches: string[];
  isLoading: boolean;
  isGitRepository: boolean | null;
}

/**
 * Hook to load available git branches for a directory.
 * Uses the shared useGitStore (same as NewWorktreeDialog).
 */
// eslint-disable-next-line react-refresh/only-export-components -- Hook is tightly coupled with BranchSelector
export function useBranchOptions(directory: string | null): BranchSelectorState {
  const { git } = useRuntimeAPIs();
  const branches = useGitBranches(directory);
  const isLoading = useGitStore((state) => state.isLoadingBranches);
  const fetchBranches = useGitStore((state) => state.fetchBranches);

  // Fetch branches if not cached
  React.useEffect(() => {
    if (!directory || !git) return;
    if (branches?.all) return; // Already cached
    void fetchBranches(directory, git);
  }, [directory, git, branches?.all, fetchBranches]);

  // Compute local and remote branch lists (same as NewWorktreeDialog)
  const localBranches = React.useMemo(() => {
    if (!branches?.all) return [];
    return branches.all
      .filter((branchName: string) => !branchName.startsWith('remotes/'))
      .sort();
  }, [branches]);

  const remoteBranches = React.useMemo(() => {
    if (!branches?.all) return [];
    return branches.all
      .filter((branchName: string) => branchName.startsWith('remotes/'))
      .map((branchName: string) => branchName.replace(/^remotes\//, ''))
      .sort();
  }, [branches]);

  // isGitRepository: true if we got branches, false if fetch returned empty, null if not yet loaded
  const isGitRepository = React.useMemo<boolean | null>(() => {
    if (!directory) return null;
    if (isLoading) return null;
    if (!branches) return null;
    return Boolean(branches.all);
  }, [directory, isLoading, branches]);

  return { localBranches, remoteBranches, isLoading, isGitRepository };
}

/**
 * Branch selector dropdown for selecting a source branch for worktree creation.
 * Matches the NewWorktreeDialog source branch selector exactly.
 */
export const BranchSelector: React.FC<BranchSelectorProps> = ({
  directory,
  value,
  onChange,
  className,
  disabled,
  id,
}) => {
  const { localBranches, remoteBranches, isLoading, isGitRepository } = useBranchOptions(directory);
  const allBranches = React.useMemo(
    () => [...localBranches, ...remoteBranches.map(b => `remotes/${b}`)],
    [localBranches, remoteBranches],
  );

  // Resolve default source branch (same priority as NewWorktreeDialog)
  React.useEffect(() => {
    if (disabled || isLoading || allBranches.length === 0) return;
    // If current value is valid, keep it
    if (value && allBranches.includes(value)) return;

    const resolve = async () => {
      try {
        const rootBranch = directory ? await getRootBranch(directory).catch(() => null) : null;
        const saved = localStorage.getItem(LAST_SOURCE_BRANCH_KEY);

        if (saved && allBranches.includes(saved)) {
          onChange(saved);
        } else if (rootBranch && allBranches.includes(rootBranch)) {
          onChange(rootBranch);
        } else if (allBranches.includes('main')) {
          onChange('main');
        } else if (allBranches.includes('master')) {
          onChange('master');
        } else if (allBranches[0]) {
          onChange(allBranches[0]);
        }
      } catch {
        // ignore
      }
    };

    void resolve();
  }, [allBranches, directory, disabled, isLoading, onChange, value]);

  const isDisabled = disabled || !isGitRepository || isLoading;

  return (
    <div>
      <Select
        value={value}
        onValueChange={onChange}
        disabled={isDisabled}
      >
        <SelectTrigger
          id={id}
          size="lg"
          className={className ?? 'w-fit typography-meta text-foreground'}
        >
          <SelectValue placeholder={isLoading ? 'Loading branches…' : 'Select source branch...'} />
        </SelectTrigger>
        <SelectContent className="max-h-[280px] max-w-[320px]">
          {isLoading ? (
            <div className="px-2 py-4 text-center typography-meta text-muted-foreground">
              Loading branches...
            </div>
          ) : localBranches.length === 0 && remoteBranches.length === 0 ? (
            <div className="px-2 py-4 text-center typography-meta text-muted-foreground">
              No branches found
            </div>
          ) : (
            <>
              {localBranches.length > 0 && (
                <SelectGroup>
                  <SelectLabel className="font-semibold text-foreground">Local branches</SelectLabel>
                  {localBranches.map((branch) => (
                    <SelectItem key={branch} value={branch} className="whitespace-normal break-all">
                      {branch}
                    </SelectItem>
                  ))}
                </SelectGroup>
              )}
              {localBranches.length > 0 && remoteBranches.length > 0 && (
                <SelectSeparator />
              )}
              {remoteBranches.length > 0 && (
                <SelectGroup>
                  <SelectLabel className="font-semibold text-foreground">Remote branches</SelectLabel>
                  {remoteBranches.map((branch) => (
                    <SelectItem key={`remotes/${branch}`} value={`remotes/${branch}`} className="whitespace-normal break-all">
                      {branch}
                    </SelectItem>
                  ))}
                </SelectGroup>
              )}
            </>
          )}
        </SelectContent>
      </Select>

      {isGitRepository === false && (
        <p className="typography-micro text-muted-foreground/70 mt-2">Not in a git repository.</p>
      )}
    </div>
  );
};
