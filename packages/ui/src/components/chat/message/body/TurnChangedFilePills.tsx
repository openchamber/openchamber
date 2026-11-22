import React from 'react';
import { useMobileAppActions } from '@/apps/mobileAppContext';
import type { TurnChangedFile } from '../../lib/turns/types';
import { cn } from '@/lib/utils';
import { useChatSessionSelection } from '../../chatColumnSession';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useUIStore } from '@/stores/useUIStore';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { opencodeClient } from '@/lib/opencode/client';
import { openTurnFileDiffInEditor } from '../openTurnFileDiffInEditor';
import { toast } from '@/components/ui';
import { Icon } from '@/components/icon/Icon';
import { HoverTooltip } from '@/components/ui/row-tooltip';
import { useI18n } from '@/lib/i18n';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { hasTextSelectionInside } from '@/lib/textSelection';
import { DiffCount } from '@/components/ui/diff-count';
import { FULL_CONTEXT_DIFF_LINES } from '@/components/views/diffView/diffContextLines';

const getDisplayFileName = (file: string): string => {
    const normalized = file.replace(/\\/g, '/');
    const segments = normalized.split('/').filter(Boolean);
    return segments.at(-1) ?? file;
};

const CHANGED_FILE_CHIP_CLASS_NAME = 'inline-flex max-w-full items-center gap-1.5 rounded-lg oc-tile px-2 py-1 text-xs text-muted-foreground';
const CHANGED_FILE_CHIP_HOVER_CLASS_NAME = 'oc-tile-hover';
const CHANGED_FILE_CHIP_STYLE = { lineHeight: 'round(1.35em, 1px)' };
const CHANGED_FILE_CHIP_BUTTON_CLASS_NAME = 'inline-flex h-8 max-w-full cursor-pointer items-center rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]';

const TurnChangedFileChipContent = React.memo(({ file, interactive = false }: { file: TurnChangedFile; interactive?: boolean }) => (
    <span
        className={cn(CHANGED_FILE_CHIP_CLASS_NAME, interactive && CHANGED_FILE_CHIP_HOVER_CLASS_NAME)}
        style={CHANGED_FILE_CHIP_STYLE}
    >
        <FileTypeIcon filePath={file.file} className="h-3.5 w-3.5 flex-shrink-0" />
        <span className="max-w-52 truncate text-foreground/80" title={file.file}>{getDisplayFileName(file.file)}</span>
        {file.additions !== undefined && file.deletions !== undefined ? (
            <DiffCount added={file.additions} removed={file.deletions} className="typography-meta" />
        ) : null}
    </span>
));

const TurnChangedFilePillButton = React.memo(({
    file,
    onOpen,
}: {
    file: TurnChangedFile;
    onOpen: (file: string) => void;
}) => {
    const { t } = useI18n();
    return (
        <button
            type="button"
            className={CHANGED_FILE_CHIP_BUTTON_CLASS_NAME}
            aria-label={t('chat.changedFiles.actions.openFileTitle', { path: file.file })}
            title={file.file}
            onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                if (hasTextSelectionInside(event.currentTarget)) return;
                onOpen(file.file);
            }}
        >
            <TurnChangedFileChipContent file={file} interactive />
        </button>
    );
});

const StaticTurnChangedFilePills = React.memo(({ files }: { files: TurnChangedFile[] }) => (
    <>
        {files.map((file) => (
            <span key={file.file} className="inline-flex h-8 max-w-full items-center" title={file.file}>
                <TurnChangedFileChipContent file={file} />
            </span>
        ))}
    </>
));

const InteractiveTurnChangedFilePills = React.memo(({ files, turnId }: { files: TurnChangedFile[]; turnId?: string }) => {
    const { t } = useI18n();
    const effectiveDirectory = useEffectiveDirectory();
    const { sessionId } = useChatSessionSelection();
    const isMobile = useUIStore((state) => state.isMobile);
    const navigateToDiff = useUIStore((state) => state.navigateToDiff);
    const openContextDiff = useUIStore((state) => state.openContextDiff);
    const setPendingTurnDiffFile = useUIStore((state) => state.setPendingTurnDiffFile);
    const mobileActions = useMobileAppActions();
    const runtime = useRuntimeAPIs();

    const openTurnDiff = React.useCallback((file: string) => {
        const editor = runtime.editor;
        if (runtime.runtime.isVSCode && editor && effectiveDirectory) {
            if (!sessionId) return;
            void opencodeClient.getSessionTurnDiff(sessionId, { directory: effectiveDirectory, from: turnId, context: FULL_CONTEXT_DIFF_LINES })
                .then((turnDiff) => openTurnFileDiffInEditor({ directory: effectiveDirectory, editor, file, turnDiff }))
                .catch(() => toast.error(t('diffView.state.failedToLoadDiff')));
            return;
        }

        if (mobileActions) {
            mobileActions.openChanges({ diffPath: file, scope: 'turn', turnId, sessionId, directory: effectiveDirectory });
            return;
        }

        setPendingTurnDiffFile({ file, sessionId, turnId, panelSessionId: useSessionUIStore.getState().currentSessionId });
        if (!isMobile && effectiveDirectory) {
            openContextDiff(effectiveDirectory, file, false, 'turn');
            return;
        }

        navigateToDiff(file, false, 'turn');
    }, [effectiveDirectory, isMobile, mobileActions, navigateToDiff, openContextDiff, runtime, sessionId, setPendingTurnDiffFile, t, turnId]);

    return (
        <>
            {files.map((file) => file.inTurnDiff === false ? (
                <span key={file.file} className="inline-flex h-8 max-w-full items-center" title={file.file}>
                    <TurnChangedFileChipContent file={file} />
                </span>
            ) : (
                <TurnChangedFilePillButton key={file.file} file={file} onOpen={openTurnDiff} />
            ))}
        </>
    );
});

const CHANGED_FILE_CHIP_LIMIT = 4;

export const TurnChangedFilePills = React.memo(({ files, turnId, isLatestTurn }: { files?: TurnChangedFile[]; turnId?: string; isLatestTurn: boolean }) => {
    const { t } = useI18n();
    const [expanded, setExpanded] = React.useState(false);
    const toggleRef = React.useRef<HTMLButtonElement>(null);
    React.useLayoutEffect(() => {
        const toggle = toggleRef.current;
        if (!expanded && toggle && toggle.ownerDocument.activeElement === toggle) {
            toggle.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }
    }, [expanded]);
    if (!files || files.length === 0) return null;

    const hiddenCount = files.length - CHANGED_FILE_CHIP_LIMIT;
    const renderFiles = (visibleFiles: TurnChangedFile[]) => isLatestTurn || turnId
        ? <InteractiveTurnChangedFilePills files={visibleFiles} turnId={isLatestTurn ? undefined : turnId} />
        : <StaticTurnChangedFilePills files={visibleFiles} />;
    if (hiddenCount <= 0) return renderFiles(files);

    const label = expanded
        ? t('chat.changedFiles.actions.showFewer')
        : t('chat.changedFiles.actions.otherFiles', { count: hiddenCount });
    return (
        <>
            {renderFiles(expanded ? files : files.slice(0, CHANGED_FILE_CHIP_LIMIT))}
            <HoverTooltip label={label}>
                <button
                    ref={toggleRef}
                    type="button"
                    className={CHANGED_FILE_CHIP_BUTTON_CLASS_NAME}
                    aria-expanded={expanded}
                    aria-label={label}
                    onClick={(event) => {
                        event.stopPropagation();
                        setExpanded((value) => !value);
                    }}
                >
                    <span className={cn(CHANGED_FILE_CHIP_CLASS_NAME, CHANGED_FILE_CHIP_HOVER_CLASS_NAME)} style={CHANGED_FILE_CHIP_STYLE}>
                        {expanded ? (
                            <span className="inline-flex h-[round(1.35em,1px)] items-center">
                                <Icon name="arrow-up-s" className="h-3.5 w-3.5" />
                            </span>
                        ) : `+${hiddenCount}`}
                    </span>
                </button>
            </HoverTooltip>
        </>
    );
});
