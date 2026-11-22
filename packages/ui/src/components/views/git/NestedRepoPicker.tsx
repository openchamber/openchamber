import React from 'react';

import { Icon } from '@/components/icon/Icon';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';

type NestedRepoPickerProps = {
  repositories: string[];
  selectedRepository: string | null;
  onSelectRepository: (repository: string) => void;
  repositoryRoot?: string;
};

export const NestedRepoPicker: React.FC<NestedRepoPickerProps> = ({
  repositories,
  selectedRepository,
  onSelectRepository,
  repositoryRoot,
}) => {
  const { t } = useI18n();

  const relativePath = (repository: string): string => {
    if (repository === repositoryRoot) {
      return repository.split('/').filter(Boolean).pop() ?? repository;
    }
    const rootPrefix = `${repositoryRoot ?? ''}/`;
    return repository.startsWith(rootPrefix) ? repository.slice(rootPrefix.length) : repository;
  };

  return (
    <Select
      value={selectedRepository ?? undefined}
      onValueChange={(value) => {
        if (value) {
          onSelectRepository(value);
        }
      }}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <SelectTrigger
            className="max-w-[13rem] gap-1.5 px-2 py-1"
            aria-label={t('gitView.empty.selectRepositoryPlaceholder')}
          >
            <Icon name="folder-3" className="size-4 text-muted-foreground" />
            <span className="grid min-w-0 grid-cols-[minmax(0,max-content)]">
              <span className="truncate font-medium text-start">
                {selectedRepository ? relativePath(selectedRepository) : ''}
              </span>
            </span>
          </SelectTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>{t('contextTooltips.git.switchRepository')}</TooltipContent>
      </Tooltip>
      <SelectContent align="start">
        {repositories.map((repository) => (
          <SelectItem key={repository} value={repository}>
            <span className="truncate">{relativePath(repository)}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
};
