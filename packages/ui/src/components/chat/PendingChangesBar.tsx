import React from 'react';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useGitStore, useIsGitRepo } from '@/stores/useGitStore';
import { useUIStore } from '@/stores/useUIStore';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import { sessionEvents } from '@/lib/sessionEvents';
import { normalizePath } from '@/components/session/sidebar/utils';
import { Icon } from "@/components/icon/Icon";
import { cn } from '@/lib/utils';
import {
    type ChangedFileEntry,
    type GitChangedFile,
    extractGitChangedFiles,
    isGitFile,
} from './changedFiles';
import { ChangedFilesList } from './ChangedFilesList';
import { useI18n } from '@/lib/i18n';

export const PendingChangesBar: React.FC = React.memo(() => {
    const { t } = useI18n();
    const [isExpanded, setIsExpanded] = React.useState(false);
    const popoverRef = React.useRef<HTMLDivElement>(null);
    const currentDirectory = useDirectoryStore((s) => s.currentDirectory);
    const runtime = React.useContext(RuntimeAPIContext);
    const isGitRepo = useIsGitRepo(currentDirectory);
    const gitStatus = useGitStore((s) =>
        currentDirectory ? s.directories.get(currentDirectory)?.status ?? null : null,
    );
    const ensureStatus = useGitStore((s) => s.ensureStatus);
    const fetchStatus = useGitStore((s) => s.fetchStatus);

    // Close popover when clicking outside
    React.useEffect(() => {
        if (!isExpanded) return;

        const handleClickOutside = (event: MouseEvent) => {
            if (popoverRef.current && !popoverRef.current.contains(event.target as Node)) {
                setIsExpanded(false);
            }
        };

        document.addEventListener("mousedown", handleClickOutside);
        return () => document.removeEventListener("mousedown", handleClickOutside);
    }, [isExpanded]);

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
    const labelHead = fileCount === 1
        ? t('chat.pendingChanges.fileCountSingle', { count: fileCount })
        : t('chat.pendingChanges.fileCountPlural', { count: fileCount });

    return (
        <div className="relative" ref={popoverRef}>
            <button
                type="button"
                className="flex min-w-0 max-w-full items-center gap-1 text-left text-muted-foreground"
                onClick={() => setIsExpanded((value) => !value)}
                aria-expanded={isExpanded}
            >
                <Icon name="file-edit" className="h-3.5 w-3.5 flex-shrink-0 text-[var(--status-warning)]" />
                <span className="min-w-0 typography-ui-label text-foreground flex-shrink-0">{labelHead}</span>
                <span className="status-row__changed-label min-w-0 typography-ui-label text-foreground truncate">
                    {t('chat.pendingChanges.changedInWorkspace')}
                </span>
                <span className="text-[0.75rem] tabular-nums inline-flex items-baseline gap-1 flex-shrink-0">
                    {totalAdded > 0 ? <span style={{ color: 'var(--status-success)' }}>+{totalAdded}</span> : null}
                    {totalRemoved > 0 ? <span style={{ color: 'var(--status-error)' }}>-{totalRemoved}</span> : null}
                </span>
                {isExpanded ? (
                    <Icon name="arrow-up-s" className="h-3.5 w-3.5 flex-shrink-0" />
                ) : (
                    <Icon name="arrow-down-s" className="h-3.5 w-3.5 flex-shrink-0" />
                )}
            </button>
            {isExpanded && (
                <div
                    style={{
                        maxWidth: 'min(28rem, calc(100cqw - 4ch))',
                        backgroundColor: 'var(--surface-elevated)',
                        color: 'var(--surface-elevated-foreground)',
                    }}
                    className={cn(
                        "absolute left-0 bottom-full mb-1 z-50",
                        "w-max min-w-[280px] max-w-full rounded-xl p-1",
                        "shadow-[inset_0_1px_0_0_rgba(255,255,255,0.8),inset_0_0_0_1px_rgba(0,0,0,0.04),0_0_0_1px_rgba(0,0,0,0.10),0_1px_2px_-0.5px_rgba(0,0,0,0.08),0_4px_8px_-2px_rgba(0,0,0,0.08),0_12px_20px_-4px_rgba(0,0,0,0.08)]",
                        "dark:shadow-[inset_0_1px_0_0_rgba(255,255,255,0.12),inset_0_0_0_1px_rgba(255,255,255,0.08),0_0_0_1px_rgba(0,0,0,0.36),0_1px_1px_-0.5px_rgba(0,0,0,0.22),0_3px_3px_-1.5px_rgba(0,0,0,0.20),0_6px_6px_-3px_rgba(0,0,0,0.16)]",
                        "animate-in fade-in-0 zoom-in-95 slide-in-from-bottom-2",
                        "duration-150"
                    )}
                >
                    <ChangedFilesList
                        files={gitChangedFiles}
                        currentDirectory={currentDirectory}
                        onOpenFile={handleOpenFile}
                    />
                </div>
            )}
        </div>
    );
});

PendingChangesBar.displayName = 'PendingChangesBar';
