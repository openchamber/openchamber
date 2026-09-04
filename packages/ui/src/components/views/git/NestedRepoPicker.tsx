import React from 'react';

import { Icon } from '@/components/icon/Icon';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from '@/components/ui/select';
import { useI18n } from '@/lib/i18n';

type NestedRepoPickerProps = {
  /** Discovered repository paths under the project root. */
  repositories: string[];
  /** Currently selected repository path (the operating directory). */
  selectedRepository: string | null;
  onSelectRepository: (repository: string) => void;
  /** Root the repository paths are relative to for display labels. */
  repositoryRoot?: string;
};

/**
 * Repository switcher shown on git surfaces when a project root is not itself
 * a git repository but nested repositories were discovered under it.
 */
export const NestedRepoPicker: React.FC<NestedRepoPickerProps> = ({
  repositories,
  selectedRepository,
  onSelectRepository,
  repositoryRoot,
}) => {
  const { t } = useI18n();

  const relativePath = (repository: string): string => {
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
      <SelectTrigger
        size="sm"
        className="max-w-[13rem] gap-1.5 px-2 py-1"
        aria-label={t('gitView.empty.selectRepositoryPlaceholder')}
      >
        <Icon name="folder-3" className="size-4 text-muted-foreground" />
        <span className="min-w-0 truncate font-medium text-left">
          {selectedRepository ? relativePath(selectedRepository) : ''}
        </span>
      </SelectTrigger>
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
