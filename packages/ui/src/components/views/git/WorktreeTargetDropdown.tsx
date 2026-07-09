import React from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';

export interface WorktreeTargetOption {
  /** Absolute path this option resolves to. */
  path: string;
  /** Branch name for worktrees, or a generic label for the repository root. */
  label: string;
  isRoot: boolean;
}

interface WorktreeTargetDropdownProps {
  options: WorktreeTargetOption[];
  activePath: string | null;
  onSelect: (option: WorktreeTargetOption) => void;
}

/**
 * Lets a session point its Git/Diff/Files/Terminal tabs at a worktree other
 * than the one it was created in, without changing where the agent itself
 * reads and writes files. Only rendered when there is more than one target
 * to choose from.
 */
export const WorktreeTargetDropdown: React.FC<WorktreeTargetDropdownProps> = ({
  options,
  activePath,
  onSelect,
}) => {
  const { t } = useI18n();

  if (options.length < 2) {
    return null;
  }

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 w-8 px-0"
              aria-label={t('gitView.header.worktreeTargetTooltip')}
            >
              <Icon name="git-branch" className="size-4" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent sideOffset={8}>{t('gitView.header.worktreeTargetTooltip')}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-64">
        {options.map((option) => {
          const isSelected = activePath === option.path;
          return (
            <DropdownMenuItem key={option.path} onSelect={() => onSelect(option)}>
              <span className="flex min-w-0 items-center gap-2">
                <Icon
                  name={option.isRoot ? 'git-repository' : 'git-branch'}
                  className="size-4 shrink-0 text-muted-foreground"
                />
                <span className="min-w-0 truncate typography-ui-label text-foreground">
                  {option.label}
                </span>
                {isSelected ? (
                  <Icon name="check" className="ml-auto size-4 shrink-0 text-foreground" />
                ) : null}
              </span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
