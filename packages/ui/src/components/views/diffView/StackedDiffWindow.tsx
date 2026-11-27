import React from 'react';
import { useIntersectionRows } from '@/hooks/useIntersectionRows';
import { useLiveRowReport } from '@/hooks/useStackedLiveRows';
import type { FileEntry } from './types';

export const STACKED_DIFF_WINDOW_THRESHOLD = 1000;
const OVERSCAN_PX = 400;

interface StackedDiffWindowProps {
    files: FileEntry[];
    windowed: boolean;
    scrollRef: React.RefObject<HTMLElement | null>;
    expandedFiles: ReadonlySet<string>;
    pinnedFiles: ReadonlySet<string>;
    registerPlaceholder: (path: string, node: HTMLDivElement | null) => void;
    onActivate: (path: string, expanded: boolean) => void;
    onLiveChange?: (path: string, live: boolean) => void;
    renderEntry: (file: FileEntry, handles: StackedEntryHandles) => React.ReactNode;
}

export type StackedEntryHandles = {
    retentionRef: React.Ref<boolean>;
    headerRef: React.Ref<HTMLDivElement>;
};

const RenderEntryContext = React.createContext<StackedDiffWindowProps['renderEntry']>(() => null);

function LiveEntry({ file, ...handles }: StackedEntryHandles & {
    file: FileEntry;
}) {
    const renderEntry = React.useContext(RenderEntryContext);
    return renderEntry(file, handles);
}

export function StackedDiffWindow({ files, scrollRef, windowed, renderEntry, ...entries }: StackedDiffWindowProps) {
    const observeRow = useIntersectionRows(scrollRef, windowed, OVERSCAN_PX);
    const handledPointerRelease = React.useRef(false);
    const markPointerReleaseHandled = React.useCallback(() => { handledPointerRelease.current = true; }, []);

    return (
        <RenderEntryContext.Provider value={renderEntry}>
            <div
                className="contents"
                data-stacked-diff-rows=""
                onPointerDownCapture={() => { handledPointerRelease.current = false; }}
                onClickCapture={(event) => {
                    if (!handledPointerRelease.current || event.detail === 0) return;
                    handledPointerRelease.current = false;
                    event.preventDefault();
                    event.stopPropagation();
                }}
            >
                {files.map((file) => (
                    <StackedDiffRow
                        key={file.path}
                        file={file}
                        windowed={windowed}
                        expanded={entries.expandedFiles.has(file.path)}
                        keepMounted={entries.pinnedFiles.has(file.path)}
                        registerPlaceholder={entries.registerPlaceholder}
                        onActivate={entries.onActivate}
                        onLiveChange={entries.onLiveChange}
                        observeRow={observeRow}
                        markPointerReleaseHandled={markPointerReleaseHandled}
                    />
                ))}
            </div>
        </RenderEntryContext.Provider>
    );
}

const StackedDiffRow = React.memo(function StackedDiffRow({
    file, windowed, expanded, keepMounted, registerPlaceholder, onActivate, onLiveChange, observeRow, markPointerReleaseHandled,
}: Pick<StackedDiffWindowProps, 'registerPlaceholder' | 'onActivate' | 'onLiveChange'> & {
    file: FileEntry;
    windowed: boolean;
    expanded: boolean;
    keepMounted: boolean;
    observeRow: ReturnType<typeof useIntersectionRows>;
    markPointerReleaseHandled: () => void;
}) {
    const [near, setNear] = React.useState(false);
    const [focused, setFocused] = React.useState(false);
    const [pressed, setPressed] = React.useState(false);
    const [keepEntry, setKeepEntry] = React.useState(false);
    const requestedFocus = React.useRef(false);
    const retentionRef = React.useCallback((keep: boolean | null) => {
        if (keep !== null) setKeepEntry(keep);
    }, []);
    const headerRef = React.useCallback((node: HTMLDivElement | null) => {
        if (!node || !requestedFocus.current) return;
        requestedFocus.current = false;
        node.focus({ preventScroll: true });
    }, []);
    const setRow = React.useCallback((node: HTMLDivElement | null) => {
        if (!node) return;
        registerPlaceholder(file.path, node);
        const unobserve = observeRow(node, setNear);
        return () => {
            registerPlaceholder(file.path, null);
            unobserve();
        };
    }, [file.path, observeRow, registerPlaceholder]);
    const live = !pressed && (!windowed || focused || near || keepMounted || keepEntry);
    useLiveRowReport(file.path, windowed && live, onLiveChange);

    return (
        <div
            ref={setRow}
            className="scroll-mt-9"
            data-stacked-diff-path={file.path}
            onFocusCapture={() => setFocused(true)}
            onBlurCapture={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
            }}
        >
            {live ? (
                <LiveEntry file={file} retentionRef={retentionRef} headerRef={headerRef} />
            ) : (
                <>
                    <button
                        type="button"
                        dir="auto"
                        aria-expanded={expanded}
                        className="block h-9 w-full truncate px-3 text-start typography-ui-label text-muted-foreground [@media(hover:none)]:min-h-11"
                        onPointerDown={(event) => {
                            if (event.button !== 0 || !event.isPrimary) return;
                            event.currentTarget.setPointerCapture(event.pointerId);
                            setPressed(true);
                        }}
                        onPointerUp={(event) => {
                            if (event.button !== 0 || !event.isPrimary || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
                            markPointerReleaseHandled();
                            setPressed(false);
                            const { top, right, bottom, left } = event.currentTarget.getBoundingClientRect();
                            if (event.clientX < left || event.clientX >= right || event.clientY < top || event.clientY >= bottom) return;
                            onActivate(file.path, !expanded);
                            event.currentTarget.focus({ preventScroll: true });
                        }}
                        onPointerCancel={() => setPressed(false)}
                        onLostPointerCapture={() => setPressed(false)}
                        onMouseDown={(event) => event.preventDefault()}
                        onFocus={() => { requestedFocus.current = true; }}
                        onClick={(event) => {
                            onActivate(file.path, !expanded);
                            event.currentTarget.focus({ preventScroll: true });
                        }}
                    >
                        {file.path}
                    </button>
                    {expanded && <div className="h-40" />}
                </>
            )}
        </div>
    );
});
