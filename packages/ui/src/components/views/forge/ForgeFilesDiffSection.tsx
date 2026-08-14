import React, { useMemo, useState } from 'react';
import { Icon } from '@/components/icon/Icon';
import { Skeleton } from '@/components/ui/skeleton';
import { useI18n } from '@/lib/i18n';
import { getLanguageFromExtension } from '@/lib/toolHelpers';
import { fileDiffFromPatch } from '@/lib/diff/patchFileDiff';
import type { FileDiffMetadata } from '@pierre/diffs';
import type { ForgeFileChange } from '@/lib/forge/types';
import { PierreDiffViewer } from '@/components/views/PierreDiffViewer';

interface ForgeFilesDiffSectionProps {
  files: ForgeFileChange[] | null;
  diff?: string | null;
  loading?: boolean;
  error?: string | null;
}

const CHANGE_DESCRIPTORS: Record<string, { code: string; color: string }> = {
  added: { code: 'A', color: 'var(--status-success)' },
  removed: { code: 'D', color: 'var(--status-error)' },
  renamed: { code: 'R', color: 'var(--status-info)' },
  modified: { code: 'M', color: 'var(--status-warning)' },
};

const DEFAULT_DESCRIPTOR = CHANGE_DESCRIPTORS.modified;

const descriptorFor = (status?: string): { code: string; color: string } => {
  if (!status) return DEFAULT_DESCRIPTOR;
  const key = status.toLowerCase();
  return CHANGE_DESCRIPTORS[key] ?? DEFAULT_DESCRIPTOR;
};

/**
 * Split a combined multi-file diff into per-file sections so a file without
 * its own `patch` field can still show an inline diff.
 */
const splitDiffSections = (diff: string): string[] => {
  if (!diff) return [];
  const sections: string[] = [];
  let current: string[] = [];
  for (const line of diff.split('\n')) {
    if (/^diff --(git|cc|combined) /.test(line)) {
      if (current.length > 0) {
        sections.push(current.join('\n'));
        current = [];
      }
    }
    current.push(line);
  }
  if (current.length > 0) {
    sections.push(current.join('\n'));
  }
  return sections;
};

const diffSectionFor = (diff: string | null | undefined, filename: string): string | null => {
  if (!diff) return null;
  const needle = ` b/${filename}`;
  const section = splitDiffSections(diff).find((sectionText) => sectionText.includes(needle));
  return section && section.trim() ? section : null;
};

/**
 * File-change list for a pull request. Each row shows the change symbol
 * (A/M/D/R), filename, and add/delete counts, and expands to an inline diff
 * rendered by PierreDiffViewer (per-file `patch` when present, else the
 * matching section sliced from the combined `diff`). Pure presentation.
 */
export const ForgeFilesDiffSection = React.memo<ForgeFilesDiffSectionProps>(function ForgeFilesDiffSection({ files, diff, loading, error }) {
  const { t } = useI18n();
  const [openPaths, setOpenPaths] = useState<Set<string>>(new Set());

  const toggle = React.useCallback((path: string) => {
    setOpenPaths((previous) => {
      const next = new Set(previous);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const fileDiffs = useMemo(() => {
    const map = new Map<string, FileDiffMetadata | null>();
    for (const file of files ?? []) {
      const patch = file.patch?.trim() ? file.patch : diffSectionFor(diff, file.filename);
      map.set(file.filename, patch && patch.trim() ? fileDiffFromPatch(file.filename, patch) : null);
    }
    return map;
  }, [diff, files]);

  if (loading) {
    return (
      <div className="flex flex-col gap-2" data-testid="forge-files-loading">
        <Skeleton className="h-7 w-full" />
        <Skeleton className="h-7 w-full" />
        <Skeleton className="h-7 w-3/4" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-[var(--status-error-border)] bg-[var(--status-error-background)]/40 px-3 py-2 typography-micro text-[var(--status-error)]">
        <Icon name="error-warning" className="size-4 shrink-0" />
        {error}
      </div>
    );
  }

  if (!files || files.length === 0) {
    return <p className="py-3 text-center typography-micro text-muted-foreground">{t('forge.files.empty')}</p>;
  }

  return (
    <ul className="flex flex-col">
      {files.map((file) => {
        const descriptor = descriptorFor(file.status);
        const isOpen = openPaths.has(file.filename);
        const fileDiff = fileDiffs.get(file.filename) ?? null;
        return (
          <li key={file.filename}>
            <button
              type="button"
              onClick={() => toggle(file.filename)}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-[var(--interactive-hover)]/40"
              aria-expanded={isOpen}
            >
              <span
                className="w-4 shrink-0 text-center typography-micro font-semibold"
                style={{ color: descriptor.color }}
                aria-hidden
              >
                {descriptor.code}
              </span>
              <span className="min-w-0 flex-1 truncate typography-ui-label text-foreground" title={file.filename}>
                {file.filename}
              </span>
              <span className="shrink-0 typography-micro tabular-nums">
                <span style={{ color: 'var(--status-success)' }}>+{file.additions ?? 0}</span>
                <span className="text-muted-foreground"> / </span>
                <span style={{ color: 'var(--status-error)' }}>-{file.deletions ?? 0}</span>
              </span>
              <Icon
                name={isOpen ? 'arrow-down-s' : 'arrow-right-s'}
                className="size-3 shrink-0 text-muted-foreground"
              />
            </button>
            {isOpen ? (
              <div className="mx-2 mb-1 max-h-[400px] overflow-y-auto rounded border border-border/40">
                {fileDiff ? (
                  <PierreDiffViewer
                    original=""
                    modified=""
                    fileDiff={fileDiff}
                    language={getLanguageFromExtension(file.filename) || ''}
                    fileName={file.filename}
                    renderSideBySide={false}
                    layout="inline"
                    enableComments={false}
                  />
                ) : (
                  <p className="px-3 py-2 typography-micro text-muted-foreground">{t('forge.files.noDiff')}</p>
                )}
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
});
