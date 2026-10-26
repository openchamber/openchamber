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
 * Repository switcher shown on git surfaces when nested repositories were
 * discovered under a project root that is not itself a git repository, or is
 * one with no commits yet (then the root is listed first).
 */
export const NestedRepoPicker: React.FC<NestedRepoPickerProps> = ({
  repositories,
  selectedRepository,
  onSelectRepository,
  repositoryRoot,
}) => {
  const { t } = useI18n();

  const relativePath = (repository: string): string => {
    // The root is listed when it is a repository with no commits yet; it has
    // no path relative to itself, so it goes by its folder name.
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
      <SelectTrigger
        className="max-w-[13rem] gap-1.5 px-2 py-1"
        aria-label={t('gitView.empty.selectRepositoryPlaceholder')}
      >
        <Icon name="folder-3" className="size-4 text-muted-foreground" />
        {/* The name's grid track has no minimum, so in a narrow row the
            picker truncates the name down to its icon and chevron instead
            of keeping its width and sliding under the next control. */}
        <span className="grid min-w-0 grid-cols-[minmax(0,max-content)]">
          <span className="truncate font-medium text-start">
            {selectedRepository ? relativePath(selectedRepository) : ''}
          </span>
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
