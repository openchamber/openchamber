import React from 'react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Icon } from "@/components/icon/Icon";
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';

export type FileTreeSearchMode = 'names' | 'contents';

export const FileTreeSearchField: React.FC<{
  canSearchContents: boolean;
  contentSearchActive: boolean;
  searchMode: FileTreeSearchMode;
  onSearchModeChange: (mode: FileTreeSearchMode) => void;
  regexSearch: boolean;
  onToggleRegex: () => void;
  searchQuery: string;
  onSearchQueryChange: (query: string) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
}> = ({
  canSearchContents,
  contentSearchActive,
  searchMode,
  onSearchModeChange,
  regexSearch,
  onToggleRegex,
  searchQuery,
  onSearchQueryChange,
  inputRef: searchInputRef,
}) => {
  const { t } = useI18n();
  return (
    <div className="relative min-w-0 flex-1">
      {canSearchContents ? (
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="absolute inset-s-0.5 top-1/2 inline-flex -translate-y-1/2">
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="relative size-6 p-0 text-muted-foreground hover:text-foreground"
                    aria-label={t('sidebarFilesTree.search.mode.aria')}
                  >
                    <Icon name={contentSearchActive ? 'file-search' : 'search'} className="size-3.5" />
                  </Button>
                </DropdownMenuTrigger>
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>{t('sidebarFilesTree.search.mode.aria')}</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="start" side="bottom">
            <DropdownMenuRadioGroup
              value={searchMode}
              onValueChange={(value) => onSearchModeChange(value === 'contents' ? 'contents' : 'names')}
            >
              <DropdownMenuRadioItem value="names" closeOnClick className="items-center">
                <Icon name="search" className="size-3.5" />
                {t('sidebarFilesTree.search.mode.names')}
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="contents" closeOnClick className="items-center">
                <Icon name="file-search" className="size-3.5" />
                {t('sidebarFilesTree.search.mode.contents')}
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <Icon name="search" className="pointer-events-none absolute inset-s-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
      )}
      <Input
        ref={searchInputRef}
        inputSize="compact"
        value={searchQuery}
        onChange={(event) => onSearchQueryChange(event.target.value)}
        placeholder={t(contentSearchActive ? 'sidebarFilesTree.search.contentsPlaceholder' : 'sidebarFilesTree.search.placeholder')}
        className={cn('ps-7', contentSearchActive ? 'pe-14' : searchQuery.trim().length > 0 ? 'pe-7' : 'pe-2')}
      />
      {contentSearchActive ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="chip"
              size="xs"
              aria-pressed={regexSearch}
              onClick={() => {
                onToggleRegex();
                searchInputRef.current?.focus();
              }}
              aria-label={t('sidebarFilesTree.search.regexTitle')}
              className="absolute inset-e-1 top-1/2 h-5 min-w-0 -translate-y-1/2 px-1 font-mono typography-micro"
            >
              .*
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>{t(regexSearch ? 'contextTooltips.files.searchPlainText' : 'sidebarFilesTree.search.regexTitle')}</TooltipContent>
        </Tooltip>
      ) : null}
      {searchQuery.trim().length > 0 ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={t('sidebarFilesTree.search.clearAria')}
              className={cn('absolute top-1/2 inline-flex size-4 -translate-y-1/2 items-center justify-center text-muted-foreground hover:text-foreground', contentSearchActive ? 'inset-e-8' : 'inset-e-2')}
              onClick={() => {
                onSearchQueryChange('');
                searchInputRef.current?.focus();
              }}
            >
              <Icon name="close" className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>{t('sidebarFilesTree.search.clearAria')}</TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  );
};
