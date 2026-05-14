import React from 'react';
import type { ToolPart } from '@opencode-ai/sdk/v2';
import { Popover } from '@base-ui/react/popover';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useIsGitRepo } from '@/stores/useGitStore';
import { useUIStore } from '@/stores/useUIStore';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import {
    type ChangedFile,
    type ChangedFileEntry,
    FILE_EDIT_TOOLS,
    extractChangedFiles,
    isGitFile,
    toRelativePath,
} from './changedFiles';
import { ChangedFilesList } from './ChangedFilesList';
import { changedFilesPopoverClassName, changedFilesPopoverStyle } from './changedFilesPopover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Icon } from "@/components/icon/Icon";
import type { TurnActivityRecord } from './lib/turns/types';

interface TurnChangedFilesDropdownProps {
    activityParts: TurnActivityRecord[] | undefined;
}

export const TurnChangedFilesDropdown: React.FC<TurnChangedFilesDropdownProps> = React.memo(({ activityParts }) => {
    const [isExpanded, setIsExpanded] = React.useState(false);
    const [portalContainer, setPortalContainer] = React.useState<HTMLElement | null>(null);
    const triggerButtonRef = React.useRef<HTMLButtonElement | null>(null);
    const currentDirectory = useDirectoryStore((s) => s.currentDirectory);
    const runtime = React.useContext(RuntimeAPIContext);
    const isGitRepo = useIsGitRepo(currentDirectory);

    const changedFiles = React.useMemo<ChangedFile[]>(() => {
        // Skip work entirely in git repos — the global PendingChangesBar handles those.
        if (isGitRepo !== false) return [];
        if (!activityParts || activityParts.length === 0) return [];
        const toolParts: ToolPart[] = [];
        for (const activity of activityParts) {
            const part = activity.part;
            if (part.type !== 'tool') continue;
            if (!FILE_EDIT_TOOLS.has(part.tool)) continue;
            toolParts.push(part);
        }
        if (toolParts.length === 0) return [];
        return extractChangedFiles(toolParts);
    }, [activityParts, isGitRepo]);

    if (changedFiles.length === 0) return null;

    const syncPortalContainer = () => {
        const container = triggerButtonRef.current?.closest('[data-slot="dialog-content"], [role="dialog"]') as HTMLElement | null;
        setPortalContainer(container || null);
    };

    const handleOpenFile = (file: ChangedFileEntry) => {
        if (!currentDirectory) return;
        if (isGitFile(file)) return;

        const absolutePath = file.path.startsWith('/')
            ? file.path
            : (currentDirectory.endsWith('/') ? currentDirectory : currentDirectory + '/') + file.path;

        const editor = runtime?.editor;
        if (editor) {
            void editor.openFile(absolutePath);
            setIsExpanded(false);
            return;
        }

        const store = useUIStore.getState();
        if (!store.isMobile) {
            store.openContextFile(currentDirectory, absolutePath);
            setIsExpanded(false);
            return;
        }
        store.navigateToDiff(toRelativePath(file.path, currentDirectory));
        store.setRightSidebarOpen(false);
        setIsExpanded(false);
    };

    const fileCount = changedFiles.length;
    const label = `${fileCount} file${fileCount !== 1 ? 's' : ''}`;

    return (
        <Popover.Root open={isExpanded} onOpenChange={setIsExpanded}>
            <Tooltip>
                <TooltipTrigger asChild>
                    <Popover.Trigger
                        render={
                            <button
                                ref={triggerButtonRef}
                                type="button"
                                className="flex items-center gap-1 text-sm text-muted-foreground/60 hover:text-muted-foreground tabular-nums"
                                aria-label={`${label} changed in this turn`}
                                onPointerDownCapture={syncPortalContainer}
                                onFocusCapture={syncPortalContainer}
                            >
                                <Icon name="file-edit" className="h-3.5 w-3.5" />
                                <span className="message-footer__label">{label}</span>
                                {isExpanded ? (
                                    <Icon name="arrow-up-s" className="h-3.5 w-3.5" />
                                ) : (
                                    <Icon name="arrow-down-s" className="h-3.5 w-3.5" />
                                )}
                            </button>
                        }
                    />
                </TooltipTrigger>
                <TooltipContent>{label} changed in this turn</TooltipContent>
            </Tooltip>
            <Popover.Portal container={portalContainer || undefined}>
                <Popover.Positioner side="top" align="start" sideOffset={4} collisionPadding={8}>
                    <Popover.Popup
                        style={changedFilesPopoverStyle}
                        className={`${changedFilesPopoverClassName} transition-all duration-150 ease-out data-[starting-style]:opacity-0 data-[starting-style]:scale-95 data-[ending-style]:opacity-0 data-[ending-style]:scale-95`}
                    >
                        <ChangedFilesList
                            files={changedFiles}
                            currentDirectory={currentDirectory}
                            onOpenFile={handleOpenFile}
                        />
                    </Popover.Popup>
                </Popover.Positioner>
            </Popover.Portal>
        </Popover.Root>
    );
});

TurnChangedFilesDropdown.displayName = 'TurnChangedFilesDropdown';
