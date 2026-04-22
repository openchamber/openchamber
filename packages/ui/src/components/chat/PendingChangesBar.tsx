import React from 'react';
import { RiFileEditLine, RiArrowDownSLine, RiArrowUpSLine } from '@remixicon/react';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useGitStore, useIsGitRepo } from '@/stores/useGitStore';
import { useUIStore } from '@/stores/useUIStore';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import { sessionEvents } from '@/lib/sessionEvents';
import { normalizePath } from '@/components/session/sidebar/utils';
import {
    type ChangedFileEntry,
    type GitChangedFile,
    extractGitChangedFiles,
    isGitFile,
} from './changedFiles';
import { ChangedFilesList } from './ChangedFilesList';
import { changedFilesPopoverClassName, changedFilesPopoverStyle } from './changedFilesPopover';

export const PendingChangesBar: React.FC = React.memo(() => {
    const [isExpanded, setIsExpanded] = React.useState(false);
    const currentDirectory = useDirectoryStore((s) => s.currentDirectory);
    const runtime = React.useContext(RuntimeAPIContext);
    const isGitRepo = useIsGitRepo(currentDirectory);
    const gitStatus = useGitStore((s) =>
        currentDirectory ? s.directories.get(currentDirectory)?.status ?? null : null,
    );
    const ensureStatus = useGitStore((s) => s.ensureStatus);
    const fetchStatus = useGitStore((s) => s.fetchStatus);
    const popoverRef = React.useRef<HTMLDivElement>(null);

    // Seed git store for currentDirectory so the bar can render independently of
    // DiffView/GitView/right-sidebar mounting. ensureStatus has a 5s staleness
    // gate and inFlightStatusFetchesByDirectory dedupes against concurrent callers.
    React.useEffect(() => {
        if (!currentDirectory || !runtime?.git) return;
        void ensureStatus(currentDirectory, runtime.git);
    }, [currentDirectory, runtime?.git, ensureStatus]);

    // Mirror the onGitRefreshHint listener that lives in DiffView/GitView so the
    // bar refreshes after mutating tools (edit/write/apply_patch/bash/...) even
    // when neither of those views is open — e.g. VS Code runtime.
    React.useEffect(() => {
        if (!currentDirectory || !runtime?.git) return;
        const git = runtime.git;
        return sessionEvents.onGitRefreshHint((hint) => {
            if (normalizePath(hint.directory) !== normalizePath(currentDirectory)) return;
            void fetchStatus(currentDirectory, git);
        });
    }, [currentDirectory, runtime?.git, fetchStatus]);

    const gitChangedFiles = React.useMemo<GitChangedFile[]>(() => {
        if (isGitRepo !== true || !gitStatus || gitStatus.isClean) return [];
        return extractGitChangedFiles(gitStatus.files, gitStatus.diffStats, currentDirectory);
    }, [isGitRepo, gitStatus, currentDirectory]);

    const { totalAdded, totalRemoved } = React.useMemo(() => {
        let added = 0;
        let removed = 0;
        for (const file of gitChangedFiles) {
            added += file.insertions;
            removed += file.deletions;
        }
        return { totalAdded: added, totalRemoved: removed };
    }, [gitChangedFiles]);

    React.useEffect(() => {
        if (!isExpanded) return;

        const handleClickOutside = (event: MouseEvent) => {
            if (popoverRef.current && !popoverRef.current.contains(event.target as Node)) {
                setIsExpanded(false);
            }
        };

        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [isExpanded]);

    if (isGitRepo !== true) return null;
    if (gitChangedFiles.length === 0) return null;

    const handleOpenFile = (file: ChangedFileEntry) => {
        if (!currentDirectory) return;
        if (!isGitFile(file)) return;

        const absolutePath = file.path.startsWith('/')
            ? file.path
            : (currentDirectory.endsWith('/') ? currentDirectory : currentDirectory + '/') + file.path;

        const editor = runtime?.editor;
        if (editor) {
            void editor.openFile(absolutePath);
            return;
        }

        const store = useUIStore.getState();
        if (!store.isMobile) {
            store.openContextDiff(currentDirectory, file.relativePath);
            return;
        }
        store.navigateToDiff(file.relativePath);
        store.setRightSidebarOpen(false);
    };

    const fileCount = gitChangedFiles.length;
    const labelHead = `${fileCount} file${fileCount !== 1 ? 's' : ''}`;

    return (
        <div className="relative flex min-w-0 items-center" ref={popoverRef}>
            <button
                type="button"
                onClick={() => setIsExpanded((prev) => !prev)}
                className="flex min-w-0 max-w-full items-center gap-1 text-left text-muted-foreground"
            >
                <RiFileEditLine className="h-3.5 w-3.5 flex-shrink-0 text-[var(--status-warning)]" />
                <span className="min-w-0 typography-ui-label text-foreground flex-shrink-0">{labelHead}</span>
                <span className="status-row__changed-label min-w-0 typography-ui-label text-foreground truncate">changed in workspace</span>
                <span className="text-[0.75rem] tabular-nums inline-flex items-baseline gap-1 flex-shrink-0">
                    {totalAdded > 0 ? <span style={{ color: 'var(--status-success)' }}>+{totalAdded}</span> : null}
                    {totalRemoved > 0 ? <span style={{ color: 'var(--status-error)' }}>-{totalRemoved}</span> : null}
                </span>
                {isExpanded ? (
                    <RiArrowUpSLine className="h-3.5 w-3.5 flex-shrink-0" />
                ) : (
                    <RiArrowDownSLine className="h-3.5 w-3.5 flex-shrink-0" />
                )}
            </button>

            {isExpanded ? (
                <div
                    style={changedFilesPopoverStyle}
                    className={`${changedFilesPopoverClassName} absolute z-50 left-0 bottom-full mb-1 slide-in-from-bottom-2`}
                >
                    <ChangedFilesList
                        files={gitChangedFiles}
                        currentDirectory={currentDirectory}
                        onOpenFile={handleOpenFile}
                    />
                </div>
            ) : null}
        </div>
    );
});

PendingChangesBar.displayName = 'PendingChangesBar';
