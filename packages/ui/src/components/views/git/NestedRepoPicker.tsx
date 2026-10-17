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
  /** Repository paths to choose from, the root itself included when it is one. */
  repositories: string[];
  /** Currently selected repository path (the operating directory). */
  selectedRepository: string | null;
  onSelectRepository: (repository: string) => void;
  /** Root the repository paths are relative to for display labels. */
  repositoryRoot?: string;
};

/**
 * Repository switcher shown on git surfaces when more than one repository is
 * reachable from the project root: nested repositories under a
 * non-repository root, or a root repository with no commits yet alongside the
 * nested repositories below it. The root option gets a readable label; nested
 * entries keep their relative paths.
 */
export const NestedRepoPicker: React.FC<NestedRepoPickerProps> = ({
  repositories,
  selectedRepository,
  onSelectRepository,
  repositoryRoot,
}) => {
  const { t } = useI18n();

  const displayLabel = (repository: string): string => {
    if (repositoryRoot && repository === repositoryRoot) {
      return t('gitView.empty.repositoryRootLabel');
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
      <SelectTrigger
        className="max-w-[13rem] gap-1.5 px-2 py-1"
        aria-label={t('gitView.empty.selectRepositoryPlaceholder')}
      >
        <Icon name="folder-3" className="size-4 text-muted-foreground" />
        <span className="min-w-0 truncate font-medium text-start">
          {selectedRepository ? displayLabel(selectedRepository) : ''}
        </span>
      </SelectTrigger>
      <SelectContent align="start">
        {repositories.map((repository) => (
          <SelectItem key={repository} value={repository}>
            <span className="truncate">{displayLabel(repository)}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
};
