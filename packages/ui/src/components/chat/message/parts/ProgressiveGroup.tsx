import { isSkillTool, toolDescription } from '@/lib/opencode/tools';
import React from 'react';
import { useMobileAppActions } from '@/apps/mobileAppContext';
import { cn } from '@/lib/utils';
import type { TurnActivityRecord as TurnActivityPart } from '../../lib/turns/types';
import type { Metadata, ToolInput, ToolPart as ToolPartType } from '@/lib/opencode/model';
import { MinDurationShineText } from './MinDurationShineText';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { Text } from '@/components/ui/text';
import { getToolIcon } from './toolPresentation';
import { getToolMetadata, isImageFile } from '@/lib/toolHelpers';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { useDeviceInfo } from '@/lib/device';
import { useGuestToolPresentation } from '@/lib/guests/tool-presentation';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSkillsStore } from '@/stores/useSkillsStore';
import { areRenderRelevantPartsEqual } from '../renderCompare';
import { getExternalFaviconUrl } from '@/lib/url';
import { getDirectoryForFilePath, getRelativeFilePath, isFilePathWithinDirectory, normalizeFilePath, toAbsoluteFilePath } from '@/lib/path-utils';

const TOOL_ROW_TEXT_CLASS = '!text-[length:var(--text-meta)] !leading-5 sm:!leading-6 tracking-normal';
const TOOL_ROW_TITLE_CLASS = cn('typography-meta font-medium', TOOL_ROW_TEXT_CLASS);
const TOOL_ROW_DESCRIPTION_CLASS = cn('typography-meta', TOOL_ROW_TEXT_CLASS);

const ExternalLinkFavicon: React.FC<{ href: string }> = ({ href }) => {
    const [failed, setFailed] = React.useState(false);
    const faviconUrl = React.useMemo(() => getExternalFaviconUrl(href), [href]);

    if (!faviconUrl || failed) {
        return null;
    }

    return (
        <span className="inline-flex size-[18px] flex-shrink-0 items-center justify-center rounded oc-tile-inset">
            <img
                src={faviconUrl}
                alt=""
                aria-hidden="true"
                loading="lazy"
                decoding="async"
                className="size-3.5 rounded-sm"
                onError={() => setFailed(true)}
            />
        </span>
    );
};

const isActivityRunning = (activity: TurnActivityPart): boolean => {
    if (activity.kind !== 'tool') return false;
    const part = activity.part as ToolPartType;
    const status = (part.state?.status as string) || undefined;
    const isFinalized = status === 'completed' || status === 'error' || status === 'aborted' || status === 'failed' || status === 'timeout' || status === 'cancelled';
    if (isFinalized) {
        return false;
    }
    if (status === 'running' || status === 'pending' || status === 'started') {
        return true;
    }
    return typeof activity.endedAt !== 'number';
};

/**
 * Extract a short filename from a tool part's input (for aggregation display).
 */
const getToolFileName = (activity: TurnActivityPart): string | null => {
    const part = activity.part as ToolPartType;
    const state = part.state as { input?: Record<string, unknown>; metadata?: Record<string, unknown> } | undefined;
    const input = state?.input;
    const metadata = state?.metadata;

    const filePath =
        (input?.filePath as string) ||
        (input?.file_path as string) ||
        (input?.path as string) ||
        (metadata?.filePath as string) ||
        (metadata?.file_path as string) ||
        (metadata?.path as string);

    if (typeof filePath === 'string' && filePath.trim().length > 0) {
        const lastSlash = filePath.lastIndexOf('/');
        return lastSlash >= 0 ? filePath.slice(lastSlash + 1) : filePath;
    }

    return null;
};

const getToolFilePath = (activity: TurnActivityPart): string | null => {
    const part = activity.part as ToolPartType;
    const state = part.state as { input?: Record<string, unknown>; metadata?: Record<string, unknown> } | undefined;
    const input = state?.input;
    const metadata = state?.metadata;

    const filePath =
        (input?.filePath as string) ||
        (input?.file_path as string) ||
        (input?.path as string) ||
        (metadata?.filePath as string) ||
        (metadata?.file_path as string) ||
        (metadata?.path as string);

    return typeof filePath === 'string' && filePath.trim().length > 0 ? filePath : null;
};

const getToolSkillDirectory = (activity: TurnActivityPart): string | null => {
    const part = activity.part as ToolPartType;
    const state = part.state as { metadata?: Record<string, unknown> } | undefined;
    const dir = state?.metadata?.dir;

    return typeof dir === 'string' && dir.trim().length > 0 ? dir : null;
};

const getToolReadOffset = (activity: TurnActivityPart): number | undefined => {
    const part = activity.part as ToolPartType;
    const state = part.state as { input?: Record<string, unknown>; metadata?: Record<string, unknown> } | undefined;
    const input = state?.input;
    const metadata = state?.metadata;

    const rawOffset =
        (typeof input?.offset === 'number' && Number.isFinite(input.offset) ? input.offset : undefined)
        ?? (typeof input?.line === 'number' && Number.isFinite(input.line) ? input.line : undefined)
        ?? (typeof metadata?.offset === 'number' && Number.isFinite(metadata.offset) ? metadata.offset : undefined)
        ?? (typeof metadata?.line === 'number' && Number.isFinite(metadata.line) ? metadata.line : undefined);

    if (typeof rawOffset !== 'number' || rawOffset <= 0) {
        return undefined;
    }

    return Math.floor(rawOffset);
};

const renderReadFilePath = (displayPath: string, animate = true) => {
    const lastSlash = displayPath.lastIndexOf('/');

    if (lastSlash === -1) {
        return (
            <Text
                variant={animate ? 'generate-effect' : 'static'}
                className={cn('min-w-0 flex-1 truncate whitespace-nowrap', TOOL_ROW_DESCRIPTION_CLASS)}
                style={{ color: 'var(--tools-title)' }}
                title={displayPath}
            >
                {displayPath}
            </Text>
        );
    }

    const dir = displayPath.slice(0, lastSlash);
    const name = displayPath.slice(lastSlash + 1);
    const hasAbsoluteRoot = dir.startsWith('/');
    const displayDir = hasAbsoluteRoot ? dir.slice(1) : dir;

    return (
        <span dir="ltr" className={cn('min-w-0 inline-flex max-w-full flex-1 items-baseline overflow-hidden', TOOL_ROW_DESCRIPTION_CLASS)} title={displayPath}>
            {hasAbsoluteRoot ? <span className="flex-shrink-0" style={{ color: 'var(--tools-description)' }}>/</span> : null}
            <span
                className="oc-ui-start-align min-w-0 shrink truncate whitespace-nowrap"
                style={{
                    color: 'var(--tools-description)',
                    direction: 'rtl',
                    unicodeBidi: 'plaintext',
                }}
            >
                {displayDir}
            </span>
            <span className="flex-shrink-0" style={{ color: 'var(--tools-description)' }}>/</span>
            <Text
                variant={animate ? 'generate-effect' : 'static'}
                className="flex-shrink-0"
                style={{ color: 'var(--tools-title)' }}
            >
                {name}
            </Text>
        </span>
    );
};

const resolveSkillFilePath = (skillPathOrDir: string): string => {
    const normalizedPath = normalizeFilePath(skillPathOrDir);
    if (!normalizedPath) {
        return '';
    }

    return normalizedPath.toLowerCase().endsWith('/skill.md') ? normalizedPath : `${normalizedPath}/SKILL.md`;
};

/**
 * Short description for a static tool row (aggregation display). Tool naming
 * and per-tool input fields live in `@/lib/opencode/tools`; this only trims
 * the result to the row's width and falls back to a bare file name.
 */
const SHORT_DESCRIPTION_MAX = 50;

const getToolShortDescription = (activity: TurnActivityPart): string | null => {
    const part = activity.part as ToolPartType;
    const state = part.state as { input?: ToolInput; metadata?: Metadata } | undefined;
    const described = toolDescription(part.tool, state?.input, state?.metadata);

    if (described?.kind === 'text') {
        return described.value.length > SHORT_DESCRIPTION_MAX
            ? `${described.value.slice(0, SHORT_DESCRIPTION_MAX)}...`
            : described.value;
    }
    return getToolFileName(activity);
};


/**
 * Render a static aggregated tool row.
 * Shows: [icon] DisplayName file1.tsx file2.tsx ...
 */
const areActivityListsEqual = (left: TurnActivityPart[], right: TurnActivityPart[]): boolean => {
    if (left === right) {
        return true;
    }

    if (left.length !== right.length) {
        return false;
    }

    for (let index = 0; index < left.length; index += 1) {
        const leftActivity = left[index];
        const rightActivity = right[index];

        if (leftActivity.id !== rightActivity.id) {
            return false;
        }

        if (leftActivity.kind !== rightActivity.kind || leftActivity.endedAt !== rightActivity.endedAt) {
            return false;
        }

        if (!areRenderRelevantPartsEqual([leftActivity.part], [rightActivity.part])) {
            return false;
        }
    }

    return true;
};

const StaticToolRowInner: React.FC<{
    toolName: string;
    activities: TurnActivityPart[];
    animateTailText: boolean;
}> = ({ toolName, activities, animateTailText }) => {
    const showToolFileIcons = useUIStore((state) => state.showToolFileIcons);
    const { t } = useI18n();
    const { isMobile } = useDeviceInfo();
    // Grouped rows share one normalized name; the registry wants the full
    // name OpenCode reported, which every activity in the group carries.
    const firstPart = activities[0]?.part;
    const presentation = useGuestToolPresentation(firstPart?.type === 'tool' ? firstPart.tool : null);
    const displayName = presentation?.name ?? getToolMetadata(toolName).displayName;
    const icon = getToolIcon(toolName, presentation);
    const isReadGroup = toolName.toLowerCase() === 'read';
    const runtime = React.useContext(RuntimeAPIContext);
    const mobileActions = useMobileAppActions();
    const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
    const skills = useSkillsStore((state) => state.skills);
    const hasRunningActivity = React.useMemo(() => activities.some((activity) => isActivityRunning(activity)), [activities]);
    const skillByName = React.useMemo(() => new Map(skills.map((skill) => [skill.name, skill])), [skills]);

    const descriptions = React.useMemo(() => {
        const descs: string[] = [];
        for (const activity of activities) {
            const desc = getToolShortDescription(activity);
            if (desc && !descs.includes(desc)) {
                descs.push(desc);
            }
        }
        return descs;
    }, [activities]);

    const skillEntries = React.useMemo(() => {
        if (!isSkillTool(toolName)) return [] as Array<{ name: string; path: string }>;

        const entries: Array<{ name: string; path: string }> = [];
        for (const activity of activities) {
            const name = getToolShortDescription(activity);
            if (!name) continue;

            const skill = skillByName.get(name);
            const rawPath = skill?.path || getToolSkillDirectory(activity);
            const path = rawPath ? resolveSkillFilePath(rawPath) : '';
            if (!path || entries.some((entry) => entry.name === name && entry.path === path)) continue;
            entries.push({ name, path });
        }

        return entries;
    }, [activities, skillByName, toolName]);

    const readFileEntries = React.useMemo(() => {
        if (!isReadGroup) return [] as Array<{ path: string; displayPath: string; offset?: number }>;

        const entries: Array<{ path: string; displayPath: string; offset?: number }> = [];
        for (const activity of activities) {
            const filePath = getToolFilePath(activity);
            const offset = getToolReadOffset(activity);
            if (!filePath) continue;
            if (entries.some((entry) => entry.path === filePath)) continue;
            const displayPath = getRelativeFilePath(filePath, currentDirectory);
            if (!displayPath) continue;
            entries.push({ path: filePath, displayPath, offset });
        }
        return entries;
    }, [activities, currentDirectory, isReadGroup]);

    const handleFileClick = React.useCallback((filePath: string, offset?: number) => {
        const absolutePath = toAbsoluteFilePath(currentDirectory, filePath);
        if (!absolutePath) {
            return;
        }

        if (runtime?.editor) {
            void runtime.editor.openFile(absolutePath, offset);
            return;
        }

        // Dedicated mobile app: stage the same pending file focus/navigation
        // desktop uses, then surface the Files pane (workspace drawer tab),
        // which consumes it.
        if (mobileActions) {
            const uiStore = useUIStore.getState();
            const contextDirectory = currentDirectory || getDirectoryForFilePath(currentDirectory, absolutePath);
            if (offset && Number.isFinite(offset)) {
                uiStore.openContextFileAtLine(contextDirectory, absolutePath, Math.max(1, Math.trunc(offset)), 1);
            } else {
                uiStore.openContextFile(contextDirectory, absolutePath);
            }
            mobileActions.openFiles();
            return;
        }

        if (!isFilePathWithinDirectory(absolutePath, currentDirectory)) {
            const uiStore = useUIStore.getState();
            const contextDirectory = currentDirectory || getDirectoryForFilePath(currentDirectory, absolutePath);
            if (offset && Number.isFinite(offset)) {
                uiStore.openContextFileAtLine(contextDirectory, absolutePath, Math.max(1, Math.trunc(offset)), 1);
                return;
            }
            uiStore.openContextFile(contextDirectory, absolutePath);
            return;
        }

        const uiStore = useUIStore.getState();
        const contextDirectory = getDirectoryForFilePath(currentDirectory, absolutePath);
        if (offset && Number.isFinite(offset)) {
            uiStore.openContextFileAtLine(contextDirectory, absolutePath, Math.max(1, Math.trunc(offset)), 1);
            return;
        }
        uiStore.openContextFile(contextDirectory, absolutePath);
    }, [currentDirectory, mobileActions, runtime]);

    // An image opens straight into the expanded panel to be looked at closely.
    // Only where the file opens in the context panel: VS Code opens an editor
    // tab and mobile a full-screen pane, where the path itself already does it.
    const canOpenImageExpanded = !runtime?.editor && !mobileActions && !isMobile;
    const handleOpenImageExpanded = React.useCallback((filePath: string) => {
        const absolutePath = toAbsoluteFilePath(currentDirectory, filePath);
        if (!absolutePath) return;
        const contextDirectory = isFilePathWithinDirectory(absolutePath, currentDirectory)
            ? getDirectoryForFilePath(currentDirectory, absolutePath)
            : currentDirectory || getDirectoryForFilePath(currentDirectory, absolutePath);
        useUIStore.getState().openContextFile(contextDirectory, absolutePath, { expanded: true });
    }, [currentDirectory]);

    const normalizedToolName = toolName.toLowerCase();
    const isSearchGroup = normalizedToolName === 'grep'
        || normalizedToolName === 'search'
        || normalizedToolName === 'find'
        || normalizedToolName === 'ripgrep'
        || normalizedToolName === 'glob';
    const isFetchGroup = normalizedToolName === 'webfetch' || normalizedToolName === 'fetch' || normalizedToolName === 'curl' || normalizedToolName === 'wget';
    const isSkillGroup = isSkillTool(normalizedToolName);

    return (
        <div
            // oc-static-tool-row: on touch devices mobile.css raises this to the
            // same 36px floor the [role="button"] expandable/reasoning rows get,
            // so static and expandable rows have identical rhythm.
            className={cn(
                'oc-static-tool-row flex w-full items-center gap-x-1.5 pe-2 ps-px py-1.5 rounded-xl min-w-0'
            )}
        >
            <div className="inline-flex h-5 items-center flex-shrink-0" style={{ color: 'var(--tools-icon)' }}>
                {icon}
            </div>
            <MinDurationShineText
                active={hasRunningActivity}
                minDurationMs={1000}
                className={cn(TOOL_ROW_TITLE_CLASS, 'inline-flex items-center flex-shrink-0 opacity-85')}
                style={{ color: 'var(--tools-title)' }}
                title={displayName}
            >
                {displayName}
            </MinDurationShineText>
            {isReadGroup && readFileEntries.length > 0
                ? readFileEntries.map((entry) => (
                    <React.Fragment key={entry.path}>
                        {canOpenImageExpanded && isImageFile(entry.path) ? (
                            <button
                                type="button"
                                onClick={(event) => {
                                    event.preventDefault();
                                    event.stopPropagation();
                                    handleOpenImageExpanded(entry.path);
                                }}
                                className={cn(
                                    'flex-shrink-0 inline-flex h-4 w-4 items-center justify-center rounded transition-opacity hover:bg-interactive-hover',
                                    'opacity-60 hover:opacity-100 focus-visible:opacity-100',
                                )}
                                style={{ color: 'var(--tools-icon)' }}
                                title={t('chat.toolPart.openImageExpanded')}
                                aria-label={t('chat.toolPart.openImageExpanded')}
                            >
                                <Icon name="fullscreen" className="h-3 w-3" />
                            </button>
                        ) : null}
                        <button
                            type="button"
                            onClick={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                handleFileClick(entry.path, entry.offset);
                            }}
                            className={cn('inline-flex !min-h-0 items-center justify-start gap-1 min-w-0 flex-1 text-start hover:opacity-90', TOOL_ROW_DESCRIPTION_CLASS)}
                            style={{ color: 'var(--tools-description)' }}
                            title={entry.offset ? `${entry.displayPath}:${entry.offset}` : entry.displayPath}
                        >
                            {showToolFileIcons ? <FileTypeIcon filePath={entry.path} className="h-3.5 w-3.5" /> : null}
                            {renderReadFilePath(entry.displayPath, animateTailText)}
                        </button>
                    </React.Fragment>
                ))
                : null}
            {isSearchGroup && descriptions.length > 0
                ? descriptions.map((desc, index) => (
                    <span key={`${desc}-${index}`} className="inline-flex min-w-0 flex-1">
                        <Text
                            variant={animateTailText ? 'generate-effect' : 'static'}
                            className={cn('min-w-0 flex-1 truncate whitespace-nowrap', TOOL_ROW_DESCRIPTION_CLASS)}
                            style={{ color: 'var(--tools-description)' }}
                            title={desc}
                        >
                            "{desc}"
                        </Text>
                    </span>
                ))
                : null}
            {isFetchGroup && descriptions.length > 0
                ? descriptions.map((url, index) => (
                    <a
                        key={`${url}-${index}`}
                        href={url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={cn(
                            'min-w-0 flex-1 inline-flex items-center gap-1.5 underline decoration-[color:var(--status-info)] underline-offset-2 hover:opacity-90',
                            'truncate whitespace-nowrap', TOOL_ROW_DESCRIPTION_CLASS
                        )}
                        style={{ color: 'var(--status-info)' }}
                        title={url}
                    >
                        <ExternalLinkFavicon href={url} />
                        <span className="min-w-0 truncate">{url}</span>
                    </a>
                ))
                : null}
            {isSkillGroup && skillEntries.length > 0
                ? skillEntries.map((entry, index) => (
                    <button
                        key={`${entry.name}-${entry.path}-${index}`}
                        type="button"
                        onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            handleFileClick(entry.path);
                        }}
                        className={cn('!min-h-0 min-w-0 flex-1 truncate whitespace-nowrap text-start hover:opacity-90', TOOL_ROW_DESCRIPTION_CLASS)}
                        style={{ color: 'var(--tools-description)' }}
                        title={entry.path}
                    >
                        {entry.name}
                    </button>
                ))
                : null}
            {!isReadGroup && !isSearchGroup && !isFetchGroup && !isSkillGroup && descriptions.length > 0 ? (
                <Text
                    variant={animateTailText ? 'generate-effect' : 'static'}
                    className={cn('min-w-0 flex-1 truncate whitespace-nowrap', TOOL_ROW_DESCRIPTION_CLASS)}
                    style={{ color: 'var(--tools-description)' }}
                >
                    {descriptions.join(' ')}
                </Text>
            ) : null}
        </div>
    );
};

export const StaticToolRow = React.memo(StaticToolRowInner, (prev, next) => {
    return prev.toolName === next.toolName
        && prev.animateTailText === next.animateTailText
        && areActivityListsEqual(prev.activities, next.activities);
});
