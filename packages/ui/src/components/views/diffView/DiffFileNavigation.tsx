import React from 'react';
import { cn } from '@/lib/utils';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { describeChange } from '../git/changeStatus';
import { FileTreeChevron, FileTreeIndentGuides, FileTreeRowEnd, FileTreeStatusLetter } from '../files/FileTreeRowParts';
import { fileTreeRowPaddingLeft, fileTreeRowStateClassName } from '../files/fileTreeRow';
import { useFileTreeDisclosure } from '../files/useFileTreeDisclosure';
import { Icon } from '@/components/icon/Icon';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { ReviewFileMark } from '@/components/review/ReviewFileMark';
import { useI18n } from '@/lib/i18n';
import { buildDiffTreeRows } from '../diffFileTree';
import type { FileEntry } from './types';
import { formatDiffTotals } from './diffData';

interface FileListProps {
    changedFiles: FileEntry[];
    selectedFile: string | null;
    onSelectFile: (path: string) => void;
    reviewedPaths?: ReadonlySet<string>;
}

export const FileList = React.memo<FileListProps>(({
    changedFiles,
    selectedFile,
    onSelectFile,
    reviewedPaths,
}) => {
    const { t } = useI18n();
    if (changedFiles.length === 0) return null;

    return (
        <ScrollableOverlay outerClassName="flex-1 min-h-0" className="px-2 py-2">
            <ul className="flex flex-col gap-1">
                {changedFiles.map((file) => {
                    const descriptor = describeChange(file);
                    const isActive = selectedFile === file.path;
                    const isReviewed = reviewedPaths?.has(file.path) ?? false;

                    return (
                        <li key={file.path}>
                            <button
                                type="button"
                                onClick={() => onSelectFile(file.path)}
                                className={cn(
                                    'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start transition-colors',
                                    isActive
                                        ? 'bg-interactive-selection text-interactive-selection-foreground'
                                        : 'text-muted-foreground hover:bg-interactive-hover hover:text-foreground'
                                )}
                            >
                                <FileTypeIcon filePath={file.path} className="h-3.5 w-3.5 flex-shrink-0" />
                                <span
                                    className="typography-micro font-semibold w-4 text-center uppercase"
                                    style={{ color: descriptor.color }}
                                    title={t(descriptor.descriptionKey)}
                                    aria-label={t(descriptor.descriptionKey)}
                                >
                                    {descriptor.code}
                                </span>
                                <span
                                    className="oc-ui-start-align min-w-0 flex-1 truncate typography-meta"
                                    style={{ direction: 'rtl', unicodeBidi: 'plaintext' }}
                                    title={file.path}
                                >
                                    {file.path}
                                </span>
                                {isReviewed && (
                                    <Icon
                                        name="checkbox-circle"
                                        className="size-3.5 shrink-0 text-[var(--status-success)]"
                                        aria-label={t('diffView.reviewed.label')}
                                    />
                                )}
                                {formatDiffTotals(file.insertions, file.deletions)}
                            </button>
                        </li>
                    );
                })}
            </ul>
        </ScrollableOverlay>
    );
});
export const FileTree = React.memo<FileListProps>(({
    changedFiles,
    selectedFile,
    onSelectFile,
    reviewedPaths,
}) => {
    const { t } = useI18n();
    const [collapsedDirectories, setCollapsedDirectories] = React.useState<ReadonlySet<string>>(() => new Set());
    const rows = React.useMemo(
        () => buildDiffTreeRows(changedFiles, collapsedDirectories),
        [changedFiles, collapsedDirectories],
    );

    React.useEffect(() => {
        if (!selectedFile) return;
        setCollapsedDirectories((previous) => {
            const hiding = Array.from(previous).filter((path) => selectedFile.startsWith(`${path}/`));
            if (hiding.length === 0) return previous;
            const next = new Set(previous);
            hiding.forEach((path) => next.delete(path));
            return next;
        });
    }, [selectedFile]);

    const listRef = React.useRef<HTMLUListElement>(null);
    const toggleWithMotion = useFileTreeDisclosure(listRef);
    const toggleDirectory = React.useCallback((path: string, expanded: boolean) => {
        toggleWithMotion(path, expanded, () => setCollapsedDirectories((previous) => {
            const next = new Set(previous);
            if (!next.delete(path)) {
                next.add(path);
            }
            return next;
        }));
    }, [toggleWithMotion]);

    return (
        <ScrollableOverlay outerClassName="flex-1 min-h-0" className="px-1.5 py-1.5">
            <ul ref={listRef} className="relative flex w-max min-w-full flex-col">
                {rows.map((row) => {
                    const paddingLeft = fileTreeRowPaddingLeft(row.depth);

                    if (row.kind === 'directory') {
                        return (
                            <li key={row.key} className="relative" data-tree-disclosure-path={row.path}>
                                <FileTreeIndentGuides depth={row.depth} />
                                <button
                                    type="button"
                                    onClick={() => toggleDirectory(row.path, row.expanded)}
                                    aria-expanded={row.expanded}
                                    aria-label={row.expanded
                                        ? t('diffView.fileTree.collapseDirectoryAria', { path: row.path })
                                        : t('diffView.fileTree.expandDirectoryAria', { path: row.path })}
                                    className="oc-file-tree-row flex w-full items-center gap-1 rounded-md py-1 text-start text-muted-foreground hover:bg-interactive-hover hover:text-foreground hover:[--oc-file-tree-row-fill:var(--interactive-hover)]"
                                    style={{ paddingInlineStart: paddingLeft }}
                                    title={row.path}
                                >
                                    <FileTreeChevron expanded={row.expanded} />
                                    <span className="oc-file-tree-row-name typography-meta">{row.label}</span>
                                    <FileTreeRowEnd className="pe-2" />
                                </button>
                            </li>
                        );
                    }

                    const descriptor = describeChange(row.file);
                    const isActive = selectedFile === row.file.path;
                    const isReviewed = reviewedPaths?.has(row.file.path) ?? false;
                    return (
                        <li key={row.key} className="relative" data-tree-disclosure-path={row.file.path}>
                            <FileTreeIndentGuides depth={row.depth} />
                            <button
                                type="button"
                                onClick={() => onSelectFile(row.file.path)}
                                aria-current={isActive ? 'true' : undefined}
                                className={cn(
                                    'oc-file-tree-row flex w-full items-center gap-1.5 rounded-md py-1 text-start',
                                    fileTreeRowStateClassName(isActive)
                                )}
                                style={{ paddingInlineStart: paddingLeft }}
                                title={row.file.path}
                            >
                                <FileTypeIcon filePath={row.file.path} className="ms-0.5 size-3.5 flex-shrink-0" />
                                <span className={cn('oc-file-tree-row-name typography-meta', isReviewed && !isActive && 'text-muted-foreground')}>{row.name}</span>
                                <FileTreeRowEnd className="pe-2">
                                    {isReviewed && (
                                        <Icon
                                            name="checkbox-circle"
                                            className="size-3.5 shrink-0 text-[var(--status-success)]"
                                            aria-label={t('diffView.reviewed.label')}
                                        />
                                    )}
                                    <ReviewFileMark path={row.file.path} />
                                    <FileTreeStatusLetter
                                        code={descriptor.code}
                                        color={descriptor.color}
                                        label={t(descriptor.descriptionKey)}
                                    />
                                </FileTreeRowEnd>
                            </button>
                        </li>
                    );
                })}
            </ul>
        </ScrollableOverlay>
    );
});
