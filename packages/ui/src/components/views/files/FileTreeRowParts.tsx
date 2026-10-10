import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { FILE_TREE_BASE_PADDING_PX, FILE_TREE_INDENT_PX, type FileTreeGitStatus } from './fileTreeRow';

// Shared look of every file tree row (files sidebar, Files page, changes):
// flat rows indented by depth, one faint guide per ancestor level, a chevron
// on folders and a coloured git letter on the right.

/** One guide per ancestor level, centred under that ancestor's chevron. */
export const FileTreeIndentGuides: React.FC<{ depth: number }> = ({ depth }) => (
  <>
    {Array.from({ length: depth }, (_, level) => (
      <span
        key={level}
        aria-hidden
        className="pointer-events-none absolute inset-y-0 w-px bg-border/50"
        style={{ left: `${FILE_TREE_BASE_PADDING_PX + level * FILE_TREE_INDENT_PX + 7}px` }}
      />
    ))}
  </>
);

export const FileTreeChevron: React.FC<{ expanded: boolean }> = ({ expanded }) => (
  <Icon
    name="arrow-right-s"
    className={cn('size-3.5 flex-shrink-0 text-muted-foreground transition-transform', expanded && 'rotate-90')}
  />
);

export const FileTreeStatusLetter: React.FC<{ code: string; color: string; label: string }> = ({ code, color, label }) => (
  <span
    className="w-3 flex-shrink-0 text-center typography-micro font-semibold uppercase"
    style={{ color }}
    title={label}
    aria-label={label}
  >
    {code}
  </span>
);

const GIT_STATUS_LETTERS = {
  'git-modified': { code: 'M', color: 'var(--status-warning)', labelKey: 'diffView.change.modified' },
  'git-added': { code: 'A', color: 'var(--status-success)', labelKey: 'diffView.change.new' },
  'git-deleted': { code: 'D', color: 'var(--status-error)', labelKey: 'diffView.change.deleted' },
} satisfies Record<FileTreeGitStatus, { code: string; color: string; labelKey: I18nKey }>;

/** Right-hand markers of a file row: open in a tab (dot), then its git state. */
export const FileTreeFileMarkers: React.FC<{ isOpen: boolean; status: FileTreeGitStatus | null | undefined }> = ({ isOpen, status }) => {
  const { t } = useI18n();
  const letter = status ? GIT_STATUS_LETTERS[status] : null;
  return (
    <>
      {isOpen ? <span aria-hidden className="size-1.5 flex-shrink-0 rounded-full bg-[var(--status-info)]" /> : null}
      {letter ? <FileTreeStatusLetter code={letter.code} color={letter.color} label={t(letter.labelKey)} /> : null}
    </>
  );
};

export const FileTreeFolderBadge: React.FC<{ badge: { modified: number; added: number } }> = ({ badge }) => (
  <span className="ml-auto flex flex-shrink-0 items-center gap-1 typography-micro tabular-nums">
    {badge.modified > 0 && <span className="text-[var(--status-warning)]">M{badge.modified}</span>}
    {badge.added > 0 && <span className="text-[var(--status-success)]">+{badge.added}</span>}
  </span>
);
