import React from 'react';
import { cn } from '@/lib/utils';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { describeChange } from '../git/changeStatus';
import { FileTreeChevron, FileTreeIndentGuides, FileTreeRowEnd, FileTreeStatusLetter } from '../files/FileTreeRowParts';
import { fileTreeRowPaddingLeft } from '../files/fileTreeRow';
import { useFileTreeDisclosure } from '../files/useFileTreeDisclosure';
import { Icon } from '@/components/icon/Icon';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { ReviewFileMark } from '@/components/review/ReviewFileMark';
import { FileReviewedButton } from '../FileReviewedButton';
import { useI18n } from '@/lib/i18n';
import { buildDiffTreeRows } from '../diffFileTree';
import type { DiffData, FileEntry } from './types';
import { formatDiffTotals } from './diffData';

const REVIEW_TOGGLE_REVEAL_CLASSNAME = 'pointer-events-none opacity-0 transition-opacity group-data-[review-hover]:pointer-events-auto group-data-[review-hover]:opacity-100 group-has-[:focus-visible]:pointer-events-auto group-has-[:focus-visible]:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100';
const REVIEW_TOGGLE_TOUCH_CLASSNAME = 'pointer-coarse:size-9';
const REVIEW_MARK_HIDE_CLASSNAME = 'transition-opacity group-data-[review-hover]:opacity-0 group-has-[:focus-visible]:opacity-0 pointer-coarse:opacity-0 [@media(hover:none)]:opacity-0';

const markMouseHover = (event: React.PointerEvent<HTMLElement>) => {
    if (event.pointerType === 'mouse') event.currentTarget.setAttribute('data-review-hover', '');
};

const clearMouseHover = (event: React.PointerEvent<HTMLElement>) => {
    event.currentTarget.removeAttribute('data-review-hover');
};

const ReviewedMarkSlot: React.FC<{ reviewed: boolean; interactive: boolean }> = ({ reviewed, interactive }) => {
    const { t } = useI18n();
    return (
        <span className="flex w-6 shrink-0 items-center justify-center self-stretch pointer-coarse:w-9">
            {reviewed ? (
                <>
                    <Icon
                        name="checkbox-circle"
                        className={cn(
                            'size-3.5 shrink-0 text-[var(--status-success)]',
                            interactive && REVIEW_MARK_HIDE_CLASSNAME
                        )}
                        aria-label={interactive ? undefined : t('diffView.reviewed.label')}
                        aria-hidden={interactive ? true : undefined}
                    />
                    {interactive ? <span className="sr-only">{t('diffView.reviewed.label')}</span> : null}
                </>
            ) : null}
        </span>
    );
};

interface FileListProps {
    changedFiles: FileEntry[];
    selectedFile: string | null;
    onSelectFile: (path: string) => void;
    reviewedPaths?: ReadonlySet<string>;
    onToggleReviewed?: (path: string, diffData: DiffData | null) => void;
}

export const FileList = React.memo<FileListProps>(({
    changedFiles,
    selectedFile,
    onSelectFile,
    reviewedPaths,
    onToggleReviewed,
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
                        <li
                            key={file.path}
                            onPointerEnter={markMouseHover}
                            onPointerLeave={clearMouseHover}
                            className={cn(
                                'group relative rounded-md transition-colors',
                                isActive ? 'bg-interactive-selection' : 'hover:bg-interactive-hover'
                            )}
                        >
                            <button
                                type="button"
                                onClick={() => onSelectFile(file.path)}
                                className={cn(
                                    'flex w-full items-center gap-2 rounded-md ps-2 py-1.5 text-start pointer-coarse:min-h-9',
                                    onToggleReviewed ? 'pe-1' : 'pe-2',
                                    isActive
                                        ? 'text-interactive-selection-foreground'
                                        : 'text-muted-foreground group-hover:text-foreground'
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
                                {formatDiffTotals(file.insertions, file.deletions)}
                                <ReviewedMarkSlot reviewed={isReviewed} interactive={Boolean(onToggleReviewed)} />
                            </button>
                            {onToggleReviewed ? (
                                <span className={cn('absolute inset-y-0 end-1 flex w-6 items-center justify-center pointer-coarse:w-9', REVIEW_TOGGLE_REVEAL_CLASSNAME)}>
                                    <FileReviewedButton
                                        compact
                                        reviewed={isReviewed}
                                        onToggle={() => onToggleReviewed(file.path, null)}
                                        className={REVIEW_TOGGLE_TOUCH_CLASSNAME}
                                    />
                                </span>
                            ) : null}
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
    onToggleReviewed,
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
                                    className="oc-file-tree-row flex w-full items-center gap-1 rounded-md py-1 text-start text-muted-foreground hover:bg-interactive-hover hover:text-foreground hover:[--oc-file-tree-row-fill:var(--interactive-hover)] pointer-coarse:min-h-9"
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
                            <div
                                onPointerEnter={markMouseHover}
                                onPointerLeave={clearMouseHover}
                                className={cn(
                                    'group relative flex items-center rounded-md transition-colors',
                                    isActive ? 'bg-interactive-selection' : 'hover:bg-interactive-hover'
                                )}
                            >
                                <button
                                    type="button"
                                    onClick={() => onSelectFile(row.file.path)}
                                    aria-current={isActive ? 'true' : undefined}
                                    className={cn(
                                        'oc-file-tree-row flex w-full items-center gap-1.5 rounded-md py-1 text-start pointer-coarse:min-h-9',
                                        isActive
                                            ? 'text-interactive-selection-foreground [--oc-file-tree-row-fill:var(--interactive-selection)]'
                                            : 'text-foreground/90 group-hover:text-foreground group-hover:[--oc-file-tree-row-fill:var(--interactive-hover)]'
                                    )}
                                    style={{ paddingInlineStart: paddingLeft }}
                                    title={row.file.path}
                                >
                                    <FileTypeIcon filePath={row.file.path} className="ms-0.5 size-3.5 flex-shrink-0" />
                                    <span className={cn('oc-file-tree-row-name typography-meta', isReviewed && !isActive && 'text-muted-foreground')}>{row.name}</span>
                                    <FileTreeRowEnd className="pe-2">
                                        <ReviewFileMark path={row.file.path} />
                                        <FileTreeStatusLetter
                                            code={descriptor.code}
                                            color={descriptor.color}
                                            label={t(descriptor.descriptionKey)}
                                        />
                                        <ReviewedMarkSlot reviewed={isReviewed} interactive={Boolean(onToggleReviewed)} />
                                    </FileTreeRowEnd>
                                </button>
                                {onToggleReviewed ? (
                                    <span className="sticky end-2 z-[2] -ms-6 flex h-6 w-6 shrink-0 items-center justify-center pointer-coarse:-ms-9 pointer-coarse:w-9">
                                        <FileReviewedButton
                                            compact
                                            reviewed={isReviewed}
                                            onToggle={() => onToggleReviewed(row.file.path, null)}
                                            className={cn(REVIEW_TOGGLE_REVEAL_CLASSNAME, REVIEW_TOGGLE_TOUCH_CLASSNAME)}
                                        />
                                    </span>
                                ) : null}
                            </div>
                        </li>
                    );
                })}
            </ul>
        </ScrollableOverlay>
    );
});
