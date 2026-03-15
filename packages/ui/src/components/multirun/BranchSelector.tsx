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
import { checkIsGitRepository, getGitBranches } from '@/lib/gitApi';
import { resolveRootTrackingRemote } from '@/lib/worktrees/worktreeCreate';
import { useLanguage } from '@/hooks/useLanguage';

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
  branches: WorktreeBaseOption[];
  isLoading: boolean;
  isGitRepository: boolean | null;
}

const parseTrackingRemote = (tracking: string | null | undefined): string | null => {
  const value = String(tracking || '').trim().replace(/^remotes\//, '');
  if (!value) {
    return null;
  }
  const slashIndex = value.indexOf('/');
  if (slashIndex <= 0) {
    return null;
  }
  return value.slice(0, slashIndex);
};

/**
 * Hook to load available git branches for a directory.
 */
// eslint-disable-next-line react-refresh/only-export-components -- Hook is tightly coupled with BranchSelector
export function useBranchOptions(directory: string | null): BranchSelectorState {
  const { t } = useLanguage();
  const [branches, setBranches] = React.useState<WorktreeBaseOption[]>([
    { value: 'HEAD', label: t('multirun.currentHead'), group: 'special' },
  ]);
  const [isLoading, setIsLoading] = React.useState(false);
  const [isGitRepository, setIsGitRepository] = React.useState<boolean | null>(null);

  React.useEffect(() => {
    let cancelled = false;

    if (!directory) {
      setIsGitRepository(null);
      setIsLoading(false);
      setBranches([{ value: 'HEAD', label: t('multirun.currentHead'), group: 'special' }]);
      return;
    }

    setIsLoading(true);
    setIsGitRepository(null);

    (async () => {
      try {
        const isGit = await checkIsGitRepository(directory);
        if (cancelled) return;

        setIsGitRepository(isGit);

        if (!isGit) {
          setBranches([{ value: 'HEAD', label: t('multirun.currentHead'), group: 'special' }]);
          return;
        }

        const branchData = await getGitBranches(directory).catch(() => null);
        if (cancelled) return;

        const rootTrackingRemote = await resolveRootTrackingRemote(directory).catch(() => null);
        if (cancelled) return;

        const worktreeBaseOptions: WorktreeBaseOption[] = [];
        const headLabel = branchData?.current ? t('multirun.currentHeadWithBranch', { branch: branchData.current }) : t('multirun.currentHead');
        worktreeBaseOptions.push({ value: 'HEAD', label: headLabel, group: 'special' });

        if (branchData) {
          const localBranches = branchData.all
            .filter((branchName) => !branchName.startsWith('remotes/'))
            .filter((branchName) => {
              if (!rootTrackingRemote) {
                return true;
              }
              const tracking = branchData.branches?.[branchName]?.tracking;
              const trackingRemote = parseTrackingRemote(tracking);
              if (!trackingRemote) {
                return true;
              }
              return trackingRemote === rootTrackingRemote;
            })
            .sort((a, b) => a.localeCompare(b));
          localBranches.forEach((branchName) => {
            worktreeBaseOptions.push({ value: branchName, label: branchName, group: 'local' });
          });

          const remoteBranches = branchData.all
            .filter((branchName) => branchName.startsWith('remotes/'))
            .map((branchName) => branchName.replace(/^remotes\//, ''))
            .filter((branchName) => {
              if (!rootTrackingRemote) {
                return true;
              }
              const slashIndex = branchName.indexOf('/');
              if (slashIndex <= 0) {
                return false;
              }
              return branchName.slice(0, slashIndex) === rootTrackingRemote;
            })
            .sort((a, b) => a.localeCompare(b));
          remoteBranches.forEach((branchName) => {
            worktreeBaseOptions.push({ value: branchName, label: branchName, group: 'remote' });
          });
        }

        setBranches(worktreeBaseOptions);
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [directory, t]);

  return { branches, isLoading, isGitRepository };
}

/**
 * Branch selector dropdown for selecting a base branch for worktree creation.
 */
export const BranchSelector: React.FC<BranchSelectorProps> = ({
  directory,
  value,
  onChange,
  className,
  disabled,
  id,
}) => {
  const { t } = useLanguage();
  const { branches, isLoading, isGitRepository } = useBranchOptions(directory);
  const selectedLabel = React.useMemo(() => {
    return branches.find((option) => option.value === value)?.label ?? null;
  }, [branches, value]);

  // Update value if it's no longer valid
  React.useEffect(() => {
    const isValid = branches.some((option) => option.value === value);
    if (!isValid && branches.length > 0) {
      onChange('HEAD');
    }
  }, [branches, value, onChange]);

  const isDisabled = disabled || !isGitRepository || isLoading;

  return (
    <div className="space-y-2">
      <Select
        value={value}
        onValueChange={onChange}
        disabled={isDisabled}
      >
        <SelectTrigger
          id={id}
          size="lg"
          className={className ?? 'max-w-full typography-meta text-foreground'}
        >
          {selectedLabel ? (
            <SelectValue>{selectedLabel}</SelectValue>
          ) : (
            <SelectValue placeholder={isLoading ? t('multirun.loadingBranches') : t('multirun.selectBranch')} />
          )}
        </SelectTrigger>
        <SelectContent fitContent>
          <SelectGroup>
            <SelectLabel>{t('multirun.default')}</SelectLabel>
            {branches
              .filter((option) => option.group === 'special')
              .map((option) => (
                <SelectItem key={option.value} value={option.value} className="w-auto whitespace-nowrap">
                  {option.label}
                </SelectItem>
              ))}
          </SelectGroup>

          {branches.some((option) => option.group === 'local') ? (
            <>
              <SelectSeparator />
              <SelectGroup>
                <SelectLabel>{t('branchSelector.localBranches')}</SelectLabel>
                {branches
                  .filter((option) => option.group === 'local')
                  .map((option) => (
                    <SelectItem key={option.value} value={option.value} className="w-auto whitespace-nowrap">
                      {option.label}
                    </SelectItem>
                  ))}
              </SelectGroup>
            </>
          ) : null}

          {branches.some((option) => option.group === 'remote') ? (
            <>
              <SelectSeparator />
              <SelectGroup>
                <SelectLabel>{t('branchSelector.remoteBranches')}</SelectLabel>
                {branches
                  .filter((option) => option.group === 'remote')
                  .map((option) => (
                    <SelectItem key={option.value} value={option.value} className="w-auto whitespace-nowrap">
                      {option.label}
                    </SelectItem>
                  ))}
              </SelectGroup>
            </>
          ) : null}
        </SelectContent>
      </Select>
      
      {isGitRepository === false && (
        <p className="typography-micro text-muted-foreground/70">{t('multirun.notInGitRepository')}</p>
      )}
    </div>
  );
};
