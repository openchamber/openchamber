import React from 'react';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { GitPathUnavailableError } from '@/lib/api/git-path-diff';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { toast } from '@/components/ui';
import { hasFileVersionsDiff } from '@/lib/toolHelpers';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { type DiffFindWordRequest, type PierreDiffViewerHandle } from '../PierreDiffViewer';
import { describeChange } from '../git/changeStatus';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useProjectsStore } from '@/stores/useProjectsStore';
import type { FileEntry, DiffData, ComparisonDiffResult, DiffFindReveal } from './types';
import {
    isStagedStatusFile, isWorkingStatusFile, createTextDiffDataFromPatch, formatDiffTotals,
    toNestedFileEntries,
} from './diffData';
import { InlineDiffViewer } from './InlineDiffViewer';
import { LARGE_DIFF_CHANGED_LINES, DEFAULT_CONTEXT_DIFF_LINES } from './diffContextLines';

interface NestedRepositoryDiffProps {
    renderSideBySide: boolean;
    wrapLines: boolean;
    hideWhitespace: boolean;
    findKeyPrefix?: string;
    registerViewerRef?: (key: string, handle: PierreDiffViewerHandle | null) => void;
    onFindWordRequest?: (key: string, request: DiffFindWordRequest) => void;
    findReveal?: DiffFindReveal | null;
}

interface NestedRepositoryFileDiffProps extends NestedRepositoryDiffProps {
    directory: string;
    file: FileEntry;
    revision: number;
}

const NestedRepositoryFileDiff = React.memo<NestedRepositoryFileDiffProps>(({
    directory,
    file,
    revision,
    renderSideBySide,
    wrapLines,
    hideWhitespace,
    findKeyPrefix,
    registerViewerRef,
    onFindWordRequest,
    findReveal = null,
}) => {
    const { t } = useI18n();
    const { git } = useRuntimeAPIs();
    const [result, setResult] = React.useState<Exclude<ComparisonDiffResult, { status: 'large' }>>({ status: 'loading' });
    const [forceRenderLarge, setForceRenderLarge] = React.useState(false);
    const findKey = findKeyPrefix === undefined ? null : `${findKeyPrefix}${file.path}`;
    React.useEffect(() => {
        if (findKey !== null && findReveal?.key === findKey) setForceRenderLarge(true);
    }, [findKey, findReveal]);
    const setViewerRef = React.useCallback((handle: PierreDiffViewerHandle | null) => {
        if (findKey !== null) registerViewerRef?.(findKey, handle);
    }, [findKey, registerViewerRef]);
    const handleFindWordRequest = React.useCallback((request: DiffFindWordRequest) => {
        if (findKey !== null) onFindWordRequest?.(findKey, request);
    }, [findKey, onFindWordRequest]);
    const staged = isStagedStatusFile(file) && !isWorkingStatusFile(file);
    const fileStatusKey = `${file.index}:${file.working_dir}:${file.previousPath ?? ''}:${file.insertions}:${file.deletions}`;

    React.useEffect(() => {
        let cancelled = false;
        const runtimeKey = getRuntimeKey();
        const request: Promise<DiffData> = !git.getGitFileDiff || !git.getGitDiff
            ? Promise.reject(new Error(t('diffView.unavailable.missingTitle')))
            : hasFileVersionsDiff(file.path)
                ? git.getGitFileDiff(directory, { path: file.path, staged, previousPath: file.previousPath }).then((response) => ({
                    original: response.original ?? '',
                    modified: response.modified ?? '',
                    isBinary: response.isBinary,
                    submodule: response.submodule,
                    contextMode: 'full',
                }))
                : git.getGitDiff(directory, { path: file.path, staged, contextLines: DEFAULT_CONTEXT_DIFF_LINES, previousPath: file.previousPath }).then((response) => ({
                    ...createTextDiffDataFromPatch(file.path, response.diff, 'patch'),
                    submodule: response.submodule,
                }));
        void request.then(
            (data) => {
                if (cancelled || runtimeKey !== getRuntimeKey()) return;
                setResult({ status: 'ready', data });
            },
            (error) => {
                if (cancelled || runtimeKey !== getRuntimeKey()) return;
                const message = error instanceof GitPathUnavailableError
                    ? error.reason === 'nested_repository'
                        ? t('diffView.unavailable.nestedRepositoryTitle')
                        : error.reason === 'untracked_directory'
                            ? t('diffView.unavailable.untrackedDirectoryTitle')
                            : t('diffView.unavailable.missingTitle')
                    : error instanceof Error ? error.message : String(error);
                setResult({ status: 'error', message });
            },
        );
        return () => {
            cancelled = true;
        };
    }, [directory, file.path, file.previousPath, fileStatusKey, git, revision, staged, t]);

    if (result.status === 'loading') {
        return (
            <div className="flex items-center justify-center gap-2 px-4 py-4 typography-meta text-muted-foreground">
                <Icon name="loader-4" className="size-4 animate-spin" />
                {t('diffView.state.loadingDiff')}
            </div>
        );
    }
    if (result.status === 'error') {
        return <div className="px-4 py-4 text-center typography-meta text-muted-foreground">{result.message}</div>;
    }
    if (!forceRenderLarge && file.insertions + file.deletions > LARGE_DIFF_CHANGED_LINES) {
        return (
            <div className="flex flex-col items-center gap-2 px-4 py-4 typography-meta text-muted-foreground">
                {t('diffView.state.largeDiff', { count: file.insertions + file.deletions })}
                <button
                    type="button"
                    className="typography-ui-label text-primary hover:underline"
                    onClick={() => setForceRenderLarge(true)}
                >
                    {t('diffView.actions.renderAnyway')}
                </button>
            </div>
        );
    }
    return (
        <InlineDiffViewer
            filePath={file.path}
            diff={result.data}
            staged={staged}
            renderSideBySide={renderSideBySide}
            wrapLines={wrapLines}
            hideWhitespace={hideWhitespace}
            viewerRef={setViewerRef}
            onFindWordRequest={handleFindWordRequest}
        />
    );
});

type NestedRepositoryStatus =
    | { kind: 'loading' }
    | { kind: 'ready'; files: FileEntry[] }
    | { kind: 'error'; message: string };

interface NestedRepositoryChangesProps extends NestedRepositoryDiffProps {
    directory: string;
    revision: number;
}

export const NestedRepositoryChanges = React.memo<NestedRepositoryChangesProps>(({
    directory,
    revision,
    renderSideBySide,
    wrapLines,
    hideWhitespace,
    findKeyPrefix,
    registerViewerRef,
    onFindWordRequest,
    findReveal = null,
}) => {
    const { t } = useI18n();
    const { git } = useRuntimeAPIs();
    const addProject = useProjectsStore((state) => state.addProject);
    const openNewSessionDraft = useSessionUIStore((state) => state.openNewSessionDraft);
    const [status, setStatus] = React.useState<NestedRepositoryStatus>({ kind: 'loading' });
    const [retryNonce, setRetryNonce] = React.useState(0);
    const [expandedFiles, setExpandedFiles] = React.useState<ReadonlySet<string>>(() => new Set());

    React.useEffect(() => {
        let cancelled = false;
        const runtimeKey = getRuntimeKey();
        void git.getGitStatus(directory, { fresh: true }).then(
            (next) => {
                if (cancelled || runtimeKey !== getRuntimeKey()) return;
                setStatus({ kind: 'ready', files: toNestedFileEntries(next) });
            },
            (error) => {
                if (cancelled || runtimeKey !== getRuntimeKey()) return;
                setStatus({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
            },
        );
        return () => {
            cancelled = true;
        };
    }, [directory, git, revision, retryNonce]);

    React.useEffect(() => {
        if (!findReveal || findKeyPrefix === undefined || !findReveal.key.startsWith(findKeyPrefix)) return;
        const nestedPath = findReveal.key.slice(findKeyPrefix.length);
        setExpandedFiles((previous) => (previous.has(nestedPath) ? previous : new Set(previous).add(nestedPath)));
    }, [findKeyPrefix, findReveal]);

    const toggleFile = React.useCallback((path: string) => {
        setExpandedFiles((previous) => {
            const next = new Set(previous);
            if (!next.delete(path)) next.add(path);
            return next;
        });
    }, []);

    const openAsProject = React.useCallback(async () => {
        const project = await addProject(directory);
        if (!project) {
            toast.error(t('diffView.nestedRepository.openFailed'));
            return;
        }
        openNewSessionDraft({ selectedProjectId: project.id, directoryOverride: project.path });
    }, [addProject, directory, openNewSessionDraft, t]);

    return (
        <div className="flex flex-col gap-2 py-3">
            <div className="flex items-center gap-3 px-3">
                <div className="min-w-0 flex-1">
                    <div className="typography-ui-label font-semibold text-foreground">
                        {t('diffView.unavailable.nestedRepositoryTitle')}
                    </div>
                    <div className="typography-meta text-muted-foreground">
                        {t('diffView.nestedRepository.description')}
                    </div>
                </div>
                <Tooltip>
                    <TooltipTrigger asChild>
                        <Button variant="outline" size="sm" className="shrink-0" onClick={() => void openAsProject()}>
                            {t('diffView.nestedRepository.openAsProject')}
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent sideOffset={6}>{t('contextTooltips.diff.openAsProject')}</TooltipContent>
                </Tooltip>
            </div>
            {status.kind === 'loading' ? (
                <div className="flex items-center justify-center gap-2 px-4 py-4 typography-meta text-muted-foreground">
                    <Icon name="loader-4" className="size-4 animate-spin" />
                    {t('diffView.nestedRepository.loading')}
                </div>
            ) : null}
            {status.kind === 'error' ? (
                <div className="flex flex-col items-center gap-2 px-4 py-4">
                    <div className="typography-ui-label font-semibold text-foreground">
                        {t('diffView.nestedRepository.loadFailed')}
                    </div>
                    <div className="typography-meta text-muted-foreground max-w-[32rem] text-center">{status.message}</div>
                    <button
                        type="button"
                        className="typography-ui-label text-primary hover:underline"
                        onClick={() => setRetryNonce((nonce) => nonce + 1)}
                    >
                        {t('diffView.actions.retry')}
                    </button>
                </div>
            ) : null}
            {status.kind === 'ready' && status.files.length === 0 ? (
                <div className="px-3 typography-meta text-muted-foreground">{t('diffView.nestedRepository.noChanges')}</div>
            ) : null}
            {status.kind === 'ready' && status.files.length > 0 ? (
                <ul className="flex flex-col">
                    {status.files.map((nestedFile) => {
                        const isOpen = expandedFiles.has(nestedFile.path);
                        const descriptor = describeChange(nestedFile);
                        return (
                            <li key={nestedFile.path}>
                                <button
                                    type="button"
                                    aria-expanded={isOpen}
                                    onClick={() => toggleFile(nestedFile.path)}
                                    className="flex w-full items-center gap-2 px-3 py-1 text-start text-foreground/80 transition-colors hover:text-foreground"
                                    title={nestedFile.path}
                                >
                                    <Icon name={isOpen ? 'arrow-down-s' : 'arrow-right-s'} className="size-4 shrink-0 text-muted-foreground" />
                                    <span
                                        className="typography-micro font-semibold w-4 shrink-0 text-center uppercase"
                                        style={{ color: descriptor.color }}
                                        title={t(descriptor.descriptionKey)}
                                        aria-label={t(descriptor.descriptionKey)}
                                    >
                                        {descriptor.code}
                                    </span>
                                    <FileTypeIcon filePath={nestedFile.path} className="size-3.5 shrink-0" />
                                    <span
                                        className="oc-ui-start-align min-w-0 flex-1 truncate typography-meta"
                                        style={{ direction: 'rtl', unicodeBidi: 'plaintext' }}
                                    >
                                        {nestedFile.path}
                                    </span>
                                    {formatDiffTotals(nestedFile.insertions, nestedFile.deletions)}
                                </button>
                                {isOpen ? (
                                    <NestedRepositoryFileDiff
                                        directory={directory}
                                        file={nestedFile}
                                        revision={revision}
                                        renderSideBySide={renderSideBySide}
                                        wrapLines={wrapLines}
                                        hideWhitespace={hideWhitespace}
                                        findKeyPrefix={findKeyPrefix}
                                        registerViewerRef={registerViewerRef}
                                        onFindWordRequest={onFindWordRequest}
                                        findReveal={findReveal?.key === `${findKeyPrefix}${nestedFile.path}` ? findReveal : null}
                                    />
                                ) : null}
                            </li>
                        );
                    })}
                </ul>
            ) : null}
        </div>
    );
});
