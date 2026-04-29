import React from 'react';
import { RiAddLine, RiArrowDownLine, RiArrowGoBackLine, RiArrowLeftLine, RiArrowRightLine, RiArrowUpLine, RiCloseLine, RiCommandLine, RiFullscreenExitLine, RiFullscreenLine, RiGlobalLine, RiTerminalLine } from '@remixicon/react';

import { useSessionUIStore } from '@/sync/session-ui-store';
import { useTerminalStore } from '@/stores/useTerminalStore';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { type TerminalStreamEvent } from '@/lib/api/types';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useFontPreferences } from '@/hooks/useFontPreferences';
import { CODE_FONT_OPTION_MAP, DEFAULT_MONO_FONT } from '@/lib/fontOptions';
import { convertThemeToXterm } from '@/lib/terminalTheme';
import { TerminalViewport, type TerminalController } from '@/components/terminal/TerminalViewport';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';
import { Button } from '@/components/ui/button';
import { SortableTabsStrip } from '@/components/ui/sortable-tabs-strip';
import { useDeviceInfo } from '@/lib/device';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { primeTerminalInputTransport } from '@/lib/terminalApi';
import { useI18n } from '@/lib/i18n';
import { PROJECT_ACTION_ICON_MAP, type ProjectActionIconKey } from '@/lib/projectActions';

type Modifier = 'ctrl' | 'cmd';
type MobileKey =
    | 'esc'
    | 'tab'
    | 'enter'
    | 'arrow-up'
    | 'arrow-down'
    | 'arrow-left'
    | 'arrow-right';

const BASE_KEY_SEQUENCES: Record<MobileKey, string> = {
    esc: '\u001b',
    tab: '\t',
    enter: '\r',
    'arrow-up': '\u001b[A',
    'arrow-down': '\u001b[B',
    'arrow-left': '\u001b[D',
    'arrow-right': '\u001b[C',
};

const MODIFIER_ARROW_SUFFIX: Record<Modifier, string> = {
    ctrl: '5',
    cmd: '3',
};


const STREAM_OPTIONS = {
    retry: {
        maxRetries: 3,
        initialDelayMs: 500,
        maxDelayMs: 8000,
    },
    connectionTimeoutMs: 10_000,
};

const REHYDRATED_STREAM_OPTIONS = {
    retry: {
        ...STREAM_OPTIONS.retry,
        initialDelayMs: 200,
        maxDelayMs: 500,
    },
    connectionTimeoutMs: 1_500,
};

const getSequenceForKey = (key: MobileKey, modifier: Modifier | null): string | null => {
    if (modifier) {
        switch (key) {
            case 'arrow-up':
                return `\u001b[1;${MODIFIER_ARROW_SUFFIX[modifier]}A`;
            case 'arrow-down':
                return `\u001b[1;${MODIFIER_ARROW_SUFFIX[modifier]}B`;
            case 'arrow-right':
                return `\u001b[1;${MODIFIER_ARROW_SUFFIX[modifier]}C`;
            case 'arrow-left':
                return `\u001b[1;${MODIFIER_ARROW_SUFFIX[modifier]}D`;
            default:
                break;
        }
    }

    return BASE_KEY_SEQUENCES[key] ?? null;
};

export const TerminalView: React.FC = () => {
    const { t } = useI18n();
    const { terminal, runtime } = useRuntimeAPIs();
    const { currentTheme } = useThemeSystem();
    const { monoFont } = useFontPreferences();
    const terminalFontSize = useUIStore(state => state.terminalFontSize);
    const bottomTerminalHeight = useUIStore((state) => state.bottomTerminalHeight);
    const isBottomTerminalExpanded = useUIStore((state) => state.isBottomTerminalExpanded);
    const { isMobile, hasTouchInput } = useDeviceInfo();
    // Tabs are supported for web + desktop runtimes, including mobile (not VSCode).
    const enableTabs = runtime.platform !== 'vscode';
    const showTerminalQuickKeysOnDesktop = useUIStore((state) => state.showTerminalQuickKeysOnDesktop);
    const showQuickKeys = isMobile || showTerminalQuickKeysOnDesktop;

    const currentSessionId = useSessionUIStore((s) => s.currentSessionId);
    const newSessionDraft = useSessionUIStore((s) => s.newSessionDraft);
    const hasActiveContext = currentSessionId !== null || newSessionDraft?.open === true;

    const effectiveDirectory = useEffectiveDirectory() ?? null;
    const terminalSessions = useTerminalStore((s) => s.sessions);
    const terminalHydrated = useTerminalStore((s) => s.hasHydrated);
    const ensureDirectory = useTerminalStore((s) => s.ensureDirectory);
    const createTab = useTerminalStore((s) => s.createTab);
    const setActiveTab = useTerminalStore((s) => s.setActiveTab);
    const closeTab = useTerminalStore((s) => s.closeTab);
    const setTabSessionId = useTerminalStore((s) => s.setTabSessionId);
    const setTabLifecycle = useTerminalStore((s) => s.setTabLifecycle);
    const setConnecting = useTerminalStore((s) => s.setConnecting);
    const appendToBuffer = useTerminalStore((s) => s.appendToBuffer);

    const openContextPreview = useUIStore((state) => state.openContextPreview);

    const directoryTerminalState = React.useMemo(() => {
        if (!effectiveDirectory) return undefined;
        return terminalSessions.get(effectiveDirectory);
    }, [terminalSessions, effectiveDirectory]);

    const activeTabId = React.useMemo(() => {
        if (!directoryTerminalState) return null;
        if (enableTabs) {
            return directoryTerminalState.activeTabId ?? directoryTerminalState.tabs[0]?.id ?? null;
        }
        return directoryTerminalState.tabs[0]?.id ?? null;
    }, [directoryTerminalState, enableTabs]);

    const activeTab = React.useMemo(() => {
        if (!directoryTerminalState) return undefined;
        if (!activeTabId) return directoryTerminalState.tabs[0];
        return (
            directoryTerminalState.tabs.find((tab) => tab.id === activeTabId) ??
            directoryTerminalState.tabs[0]
        );
    }, [directoryTerminalState, activeTabId]);

    const terminalTabItems = React.useMemo(() => {
        return (directoryTerminalState?.tabs ?? []).map((tab) => ({
            icon: (() => {
                const Icon = tab.iconKey ? PROJECT_ACTION_ICON_MAP[tab.iconKey as ProjectActionIconKey] ?? RiTerminalLine : RiTerminalLine;
                return <Icon className="h-4 w-4" />;
            })(),
            id: tab.id,
            label: tab.label,
            title: tab.label,
            closeLabel: t('terminalView.tabs.closeTabTitle'),
        }));
    }, [directoryTerminalState?.tabs, t]);

    const terminalSessionId = activeTab?.terminalSessionId ?? null;
    const terminalLifecycle = activeTab?.lifecycle ?? 'idle';
    const bufferChunks = activeTab?.bufferChunks ?? [];
    const isConnecting = activeTab?.isConnecting ?? false;
    const previewUrl = activeTab?.previewUrl ?? null;

    const [connectionError, setConnectionError] = React.useState<string | null>(null);
    const [isFatalError, setIsFatalError] = React.useState(false);
    const [isReconnectPending, setIsReconnectPending] = React.useState(false);
    const [activeModifier, setActiveModifier] = React.useState<Modifier | null>(null);
    const [isRestarting, setIsRestarting] = React.useState(false);
    const [viewportLayoutVersion, setViewportLayoutVersion] = React.useState(0);

    const streamCleanupRef = React.useRef<(() => void) | null>(null);
    const activeTerminalIdRef = React.useRef<string | null>(null);
    const activeTabIdRef = React.useRef<string | null>(activeTabId);
    const terminalIdRef = React.useRef<string | null>(terminalSessionId);
    const directoryRef = React.useRef<string | null>(effectiveDirectory);
    const terminalControllerRef = React.useRef<TerminalController | null>(null);
    const lastViewportSizeRef = React.useRef<{ cols: number; rows: number } | null>(null);
    const isTerminalVisibleRef = React.useRef(false);
    const nudgeOnConnectTerminalIdRef = React.useRef<string | null>(null);
    const rehydratedTerminalIdsRef = React.useRef<Set<string>>(new Set());
    const rehydratedSnapshotTakenRef = React.useRef(false);

    const focusTerminalWhenWindowActive = React.useCallback(() => {
        if (typeof document !== 'undefined' && !document.hasFocus()) {
            return;
        }
        terminalControllerRef.current?.focus();
    }, []);

    React.useEffect(() => {
        if (!terminalHydrated) {
            return;
        }

        if (rehydratedSnapshotTakenRef.current) {
            return;
        }
        rehydratedSnapshotTakenRef.current = true;

        const ids = new Set<string>();
        for (const [, dirState] of useTerminalStore.getState().sessions.entries()) {
            for (const tab of dirState.tabs) {
                if (tab.terminalSessionId) {
                    ids.add(tab.terminalSessionId);
                }
            }
        }
        rehydratedTerminalIdsRef.current = ids;
    }, [terminalHydrated]);

    const activeMainTab = useUIStore((state) => state.activeMainTab);
    const isBottomTerminalOpen = useUIStore((state) => state.isBottomTerminalOpen);
    const setBottomTerminalOpen = useUIStore((state) => state.setBottomTerminalOpen);
    const setBottomTerminalExpanded = useUIStore((state) => state.setBottomTerminalExpanded);
    const isTerminalActive = activeMainTab === 'terminal';
    const isTerminalVisible = isTerminalActive || isBottomTerminalOpen;
    const [hasOpenedTerminalViewport, setHasOpenedTerminalViewport] = React.useState(isTerminalVisible);

    React.useEffect(() => {
        if (!isTerminalVisible || runtime.platform === 'vscode') {
            return;
        }

        primeTerminalInputTransport();
    }, [isTerminalVisible, runtime.platform]);

    React.useEffect(() => {
        if (isTerminalVisible) {
            setHasOpenedTerminalViewport(true);
        }
    }, [isTerminalVisible]);

    React.useEffect(() => {
        isTerminalVisibleRef.current = isTerminalVisible;
    }, [isTerminalVisible]);

    React.useEffect(() => {
        terminalIdRef.current = terminalSessionId;
    }, [terminalSessionId]);

    React.useEffect(() => {
        activeTabIdRef.current = activeTabId;
    }, [activeTabId]);

    React.useEffect(() => {
        directoryRef.current = effectiveDirectory;
    }, [effectiveDirectory]);

    React.useEffect(() => {
        if (!showQuickKeys && activeModifier !== null) {
            setActiveModifier(null);
        }
    }, [showQuickKeys, activeModifier, setActiveModifier]);

    React.useEffect(() => {
        if (!terminalSessionId && activeModifier !== null) {
            setActiveModifier(null);
        }
    }, [terminalSessionId, activeModifier, setActiveModifier]);

    const disconnectStream = React.useCallback(() => {
        streamCleanupRef.current?.();
        streamCleanupRef.current = null;
        activeTerminalIdRef.current = null;
        setIsReconnectPending(false);
    }, []);

    React.useEffect(
        () => () => {
            disconnectStream();
            terminalIdRef.current = null;
        },
        [disconnectStream]
    );

    const startStream = React.useCallback(
        (
            directory: string,
            tabId: string,
            terminalId: string,
            streamOptions = STREAM_OPTIONS
        ) => {
            if (activeTerminalIdRef.current === terminalId) {
                return;
            }

            disconnectStream();

            // Mark active before connect so early events aren't dropped.
            activeTerminalIdRef.current = terminalId;

            const subscription = terminal.connect(
                terminalId,
                {
                    onEvent: (event: TerminalStreamEvent) => {
                        if (activeTerminalIdRef.current !== terminalId) {
                            return;
                        }

                        switch (event.type) {
                            case 'connected': {
                                setConnecting(directory, tabId, false);
                                setConnectionError(null);
                                setIsFatalError(false);
                                setIsReconnectPending(false);
                                focusTerminalWhenWindowActive();

                                // After a reload, buffer is empty and a reused PTY can look "stuck"
                                // until the first output arrives. Nudge with a newline once.
                                if (nudgeOnConnectTerminalIdRef.current === terminalId) {
                                    nudgeOnConnectTerminalIdRef.current = null;
                                    void terminal.sendInput(terminalId, '\r').catch(() => {
                                        // ignore
                                    });
                                }
                                break;
                            }
                            case 'reconnecting': {
                                void event;
                                setConnectionError(null);
                                setIsFatalError(false);
                                setIsReconnectPending(true);
                                break;
                            }
                            case 'data': {
                                if (event.data) {
                                    appendToBuffer(directory, tabId, event.data);
                                }
                                break;
                            }
                            case 'exit': {
                                const exitCode =
                                    typeof event.exitCode === 'number' ? event.exitCode : null;
                                const signal = typeof event.signal === 'number' ? event.signal : null;
                                const currentTab = useTerminalStore.getState()
                                    .getDirectoryState(directory)
                                    ?.tabs.find((t) => t.id === tabId);
                                const isActionTab = Boolean(currentTab?.label?.startsWith('Action:'));
                                appendToBuffer(
                                    directory,
                                    tabId,
                                    t('terminalView.stream.processExitedMessage', {
                                        exitCodeSegment:
                                            exitCode !== null
                                                ? t('terminalView.stream.processExitedWithCode', { exitCode })
                                                : '',
                                        signalSegment:
                                            signal !== null
                                                ? t('terminalView.stream.processExitedWithSignal', { signal })
                                                : '',
                                    })
                                );
                                setTabLifecycle(directory, tabId, 'exited');
                                setTabSessionId(directory, tabId, null);
                                setConnecting(directory, tabId, false);
                                setConnectionError(isActionTab ? null : t('terminalView.error.sessionEnded'));
                                setIsFatalError(false);
                                setIsReconnectPending(false);
                                disconnectStream();
                                break;
                            }
                        }
                    },
                    onError: (error, fatal) => {
                        if (activeTerminalIdRef.current !== terminalId) {
                            return;
                        }

                        if (!fatal) {
                            setConnectionError(null);
                            setIsFatalError(false);
                            return;
                        }

                        setIsReconnectPending(false);
                        setConnectionError(
                            t('terminalView.error.connectionFailed', { message: error.message })
                        );
                        setIsFatalError(true);
                        setConnecting(directory, tabId, false);
                        setTabLifecycle(directory, tabId, 'exited');
                        setTabSessionId(directory, tabId, null);
                        disconnectStream();
                    },
                },
                streamOptions
            );

            streamCleanupRef.current = () => {
                subscription.close();
                activeTerminalIdRef.current = null;
            };
        },
        [
            appendToBuffer,
            disconnectStream,
            focusTerminalWhenWindowActive,
            setConnecting,
            setTabLifecycle,
            setTabSessionId,
            t,
            terminal,
        ]
    );

    React.useEffect(() => {
        let cancelled = false;

        if (!terminalHydrated || !hasOpenedTerminalViewport) {
            return;
        }

        if (!effectiveDirectory) {
            setConnectionError(
                hasActiveContext
                    ? t('terminalView.empty.noWorkingDirectory')
                    : t('terminalView.empty.selectSession')
            );
            disconnectStream();
            return;
        }

        const ensureSession = async () => {
            const directory = effectiveDirectory;
            if (!directoryRef.current || directoryRef.current !== directory) return;

            ensureDirectory(directory);

            const state = useTerminalStore.getState().getDirectoryState(directory);
            if (!state || state.tabs.length === 0) {
                return;
            }

            const tabId = enableTabs
                ? (state.activeTabId ?? state.tabs[0]?.id ?? null)
                : (state.tabs[0]?.id ?? null);
            if (!tabId) {
                return;
            }

            const tab = state.tabs.find((t) => t.id === tabId) ?? state.tabs[0];
            let terminalId = tab?.terminalSessionId ?? null;
            const terminalLifecycle = tab?.lifecycle ?? 'idle';
            const isActionTab = Boolean(tab?.label?.startsWith('Action:'));
            const hasBufferedOutput = (tab?.bufferLength ?? 0) > 0 || (tab?.bufferChunks?.length ?? 0) > 0;

            const shouldNudgeExisting =
                Boolean(terminalId) &&
                rehydratedTerminalIdsRef.current.has(terminalId as string) &&
                (tab?.bufferLength ?? 0) === 0 &&
                (tab?.bufferChunks?.length ?? 0) === 0;

            const isRehydratedSession =
                Boolean(terminalId) && rehydratedTerminalIdsRef.current.has(terminalId as string);

            if (!terminalId) {
                if (terminalLifecycle === 'exited') {
                    setConnecting(directory, tabId, false);
                    return;
                }

                if (isActionTab && hasBufferedOutput) {
                    setConnecting(directory, tabId, false);
                    return;
                }

                setConnectionError(null);
                setIsFatalError(false);
                setIsReconnectPending(false);
                setConnecting(directory, tabId, true);
                try {
                    const size = lastViewportSizeRef.current;
                    const session = await terminal.createSession({
                        cwd: directory,
                        cols: size?.cols,
                        rows: size?.rows,
                    });

                    const stillActive =
                        !cancelled &&
                        directoryRef.current === directory &&
                        activeTabIdRef.current === tabId;

                    if (!stillActive) {
                        try {
                            await terminal.close(session.sessionId);
                        } catch { /* ignored */ }
                        return;
                    }

                    setTabSessionId(directory, tabId, session.sessionId);
                    terminalId = session.sessionId;
                } catch (error) {
                    if (!cancelled) {
                        setConnectionError(
                            error instanceof Error
                                ? error.message
                                : t('terminalView.error.startSessionFailed')
                        );
                        setIsFatalError(true);
                        setIsReconnectPending(false);
                        setConnecting(directory, tabId, false);
                    }
                    return;
                }
            }

            if (!terminalId || cancelled) return;

            terminalIdRef.current = terminalId;

            if (isRehydratedSession) {
                rehydratedTerminalIdsRef.current.delete(terminalId);
            }

            if (shouldNudgeExisting) {
                nudgeOnConnectTerminalIdRef.current = terminalId;
            }
            startStream(
                directory,
                tabId,
                terminalId,
                isRehydratedSession ? REHYDRATED_STREAM_OPTIONS : STREAM_OPTIONS
            );
        };

        void ensureSession();

        return () => {
            cancelled = true;
            terminalIdRef.current = null;
            disconnectStream();
        };
    }, [
        hasActiveContext,
        effectiveDirectory,
        terminalSessionId,
        terminalLifecycle,
        activeTabId,
        hasOpenedTerminalViewport,
        enableTabs,
        terminalHydrated,
        ensureDirectory,
        setConnecting,
        setTabLifecycle,
        setTabSessionId,
        startStream,
        disconnectStream,
        t,
        terminal,
    ]);

    React.useEffect(() => {
        if (!isTerminalVisible) {
            return;
        }

        if (typeof window === 'undefined') {
            focusTerminalWhenWindowActive();
            return;
        }

        const rafId = window.requestAnimationFrame(() => {
            focusTerminalWhenWindowActive();
        });

        return () => {
            window.cancelAnimationFrame(rafId);
        };
    }, [activeTabId, focusTerminalWhenWindowActive, isTerminalVisible]);

    const handleRestart = React.useCallback(async () => {
        if (!effectiveDirectory) return;
        if (isRestarting) return;

        const state = useTerminalStore.getState().getDirectoryState(effectiveDirectory);
        const tabId = enableTabs
            ? (activeTabId ?? state?.activeTabId ?? state?.tabs[0]?.id ?? null)
            : (state?.tabs[0]?.id ?? null);
        if (!tabId) return;

        setIsRestarting(true);
        setConnectionError(null);
        setIsFatalError(false);
        setIsReconnectPending(false);

        disconnectStream();

        try {
            await closeTab(effectiveDirectory, tabId);
        } catch (error) {
            setConnectionError(
                error instanceof Error ? error.message : t('terminalView.error.restartFailed')
            );
            setIsFatalError(true);
            setIsReconnectPending(false);
        } finally {
            setIsRestarting(false);
        }
    }, [activeTabId, closeTab, disconnectStream, effectiveDirectory, enableTabs, isRestarting, t]);

    const handleHardRestart = React.useCallback(async () => {
        // Keep semantics: “close tab -> new clean tab”.
        await handleRestart();
    }, [handleRestart]);

    const handleCreateTab = React.useCallback(() => {
        if (!effectiveDirectory) return;
        const tabId = createTab(effectiveDirectory);
        setActiveTab(effectiveDirectory, tabId);
        setConnectionError(null);
        setIsFatalError(false);
        setIsReconnectPending(false);
        disconnectStream();
    }, [createTab, disconnectStream, effectiveDirectory, setActiveTab]);

    const handleSelectTab = React.useCallback(
        (tabId: string) => {
            if (!effectiveDirectory) return;
            setActiveTab(effectiveDirectory, tabId);
            setConnectionError(null);
            setIsFatalError(false);
            setIsReconnectPending(false);
            disconnectStream();
        },
        [disconnectStream, effectiveDirectory, setActiveTab]
    );

    const handleCloseTab = React.useCallback(
        (tabId: string) => {
            if (!effectiveDirectory) return;

            if (tabId === activeTabId) {
                disconnectStream();
            }

            setConnectionError(null);
            setIsFatalError(false);
            setIsReconnectPending(false);
            void closeTab(effectiveDirectory, tabId);
        },
        [activeTabId, closeTab, disconnectStream, effectiveDirectory]
    );


    const handleViewportInput = React.useCallback(
        (data: string) => {
            if (!data || isReconnectPending) {
                return;
            }

            let payload = data;
            let modifierConsumed = false;

            if (activeModifier && data.length > 0) {
                const firstChar = data[0];
                if (firstChar.length === 1 && /[a-zA-Z]/.test(firstChar)) {
                    const upper = firstChar.toUpperCase();
                    if (activeModifier === 'ctrl' || activeModifier === 'cmd') {
                        payload = String.fromCharCode(upper.charCodeAt(0) & 0b11111);
                        modifierConsumed = true;
                    }
                }

                if (!modifierConsumed) {
                    modifierConsumed = true;
                }
            }

            const terminalId = terminalIdRef.current;
            if (!terminalId) return;

            void terminal.sendInput(terminalId, payload).catch((error) => {
                if (!isReconnectPending) {
                    setConnectionError(
                        error instanceof Error ? error.message : t('terminalView.error.sendInputFailed')
                    );
                }
            });

            if (modifierConsumed) {
                setActiveModifier(null);
                terminalControllerRef.current?.focus();
            }
        },
        [activeModifier, isReconnectPending, setActiveModifier, t, terminal]
    );

    const handleViewportResize = React.useCallback(
        (cols: number, rows: number) => {
            lastViewportSizeRef.current = { cols, rows };
            if (!isTerminalVisibleRef.current) {
                return;
            }
            const terminalId = terminalIdRef.current;
            if (!terminalId) return;
            void terminal.resize({ sessionId: terminalId, cols, rows }).catch(() => {

            });
        },
        [terminal]
    );

    const handleModifierToggle = React.useCallback(
        (modifier: Modifier) => {
            setActiveModifier((current) => (current === modifier ? null : modifier));
            terminalControllerRef.current?.focus();
        },
        [setActiveModifier]
    );

    const handleMobileKeyPress = React.useCallback(
        (key: MobileKey) => {
            const sequence = getSequenceForKey(key, activeModifier);
            if (!sequence) {
                return;
            }
            handleViewportInput(sequence);
            setActiveModifier(null);
            terminalControllerRef.current?.focus();
        },
        [activeModifier, handleViewportInput, setActiveModifier]
    );

    React.useEffect(() => {
        if (!showQuickKeys || !activeModifier || !terminalSessionId) {
            return;
        }

        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.repeat) {
                return;
            }

            const rawKey = event.key;
            if (!rawKey) {
                return;
            }

            if (rawKey === 'Control' || rawKey === 'Meta' || rawKey === 'Alt' || rawKey === 'Shift') {
                return;
            }

            const normalizedKey = rawKey.length === 1 ? rawKey.toLowerCase() : rawKey;
            const code = event.code ?? '';
            const upperFromCode =
                code.startsWith('Key') && code.length === 4
                    ? code.slice(3).toUpperCase()
                    : null;
            const upperKey =
                rawKey.length === 1 && /[a-zA-Z]/.test(rawKey)
                    ? rawKey.toUpperCase()
                    : upperFromCode;

            const toMobileKey: Record<string, MobileKey> = {
                Tab: 'tab',
                Enter: 'enter',
                ArrowUp: 'arrow-up',
                ArrowDown: 'arrow-down',
                ArrowLeft: 'arrow-left',
                ArrowRight: 'arrow-right',
                Escape: 'esc',
                tab: 'tab',
                enter: 'enter',
                arrowup: 'arrow-up',
                arrowdown: 'arrow-down',
                arrowleft: 'arrow-left',
                arrowright: 'arrow-right',
                escape: 'esc',
            };

            if (normalizedKey in toMobileKey) {
                event.preventDefault();
                event.stopPropagation();
                handleMobileKeyPress(toMobileKey[normalizedKey]);
                return;
            }

            if (activeModifier === 'ctrl' && upperKey && upperKey.length === 1) {
                if (upperKey >= 'A' && upperKey <= 'Z') {
                    const controlCode = String.fromCharCode(upperKey.charCodeAt(0) & 0b11111);
                    event.preventDefault();
                    event.stopPropagation();
                    handleViewportInput(controlCode);
                    setActiveModifier(null);
                    terminalControllerRef.current?.focus();
                }
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => {
            window.removeEventListener('keydown', handleKeyDown);
        };
    }, [
        activeModifier,
        handleMobileKeyPress,
        handleViewportInput,
        showQuickKeys,
        setActiveModifier,
        terminalSessionId,
    ]);

    const resolvedFontStack = React.useMemo(() => {
        const defaultStack = CODE_FONT_OPTION_MAP[DEFAULT_MONO_FONT].stack;
        if (typeof window === 'undefined') {
            const fallbackDefinition =
                CODE_FONT_OPTION_MAP[monoFont] ?? CODE_FONT_OPTION_MAP[DEFAULT_MONO_FONT];
            return fallbackDefinition.stack;
        }

        const root = window.getComputedStyle(document.documentElement);
        const cssStack = root.getPropertyValue('--font-family-mono');
        if (cssStack && cssStack.trim().length > 0) {
            return cssStack.trim();
        }

        const definition =
            CODE_FONT_OPTION_MAP[monoFont] ?? CODE_FONT_OPTION_MAP[DEFAULT_MONO_FONT];
        return definition.stack ?? defaultStack;
    }, [monoFont]);

    const xtermTheme = React.useMemo(() => convertThemeToXterm(currentTheme), [currentTheme]);

    const terminalSessionKey = React.useMemo(() => {
        const directoryPart = effectiveDirectory ?? 'no-dir';
        const tabPart = activeTabId ?? 'no-tab';
        const terminalPart = terminalSessionId ?? `pending-${tabPart}`;
        return `${directoryPart}::${tabPart}::${terminalPart}`;
    }, [effectiveDirectory, activeTabId, terminalSessionId]);

    const viewportSessionKey = React.useMemo(() => {
        const base = terminalSessionId ?? terminalSessionKey;
        return `${base}::layout-${viewportLayoutVersion}`;
    }, [terminalSessionId, terminalSessionKey, viewportLayoutVersion]);

    React.useEffect(() => {
        if (isMobile || !isBottomTerminalOpen || !isTerminalVisible) {
            return;
        }

        if (typeof window === 'undefined') {
            setViewportLayoutVersion((value) => value + 1);
            return;
        }

        const timeoutId = window.setTimeout(() => {
            setViewportLayoutVersion((value) => value + 1);
        }, 140);

        return () => {
            window.clearTimeout(timeoutId);
        };
    }, [bottomTerminalHeight, isBottomTerminalExpanded, isBottomTerminalOpen, isMobile, isTerminalVisible]);

    React.useEffect(() => {
        if (!isTerminalVisible) {
            return;
        }
        const controller = terminalControllerRef.current;
        if (!controller) {
            return;
        }
        const fitOnce = () => {
            controller.fit();
        };
        if (typeof window !== 'undefined') {
            const rafId = window.requestAnimationFrame(() => {
                fitOnce();
                focusTerminalWhenWindowActive();
            });
            const timeoutIds = [220, 400].map((delay) => window.setTimeout(fitOnce, delay));
            return () => {
                window.cancelAnimationFrame(rafId);
                timeoutIds.forEach((id) => window.clearTimeout(id));
            };
        }
        fitOnce();
    }, [focusTerminalWhenWindowActive, isTerminalVisible, terminalSessionKey, terminalSessionId]);

    React.useEffect(() => {
        if (isMobile || !isTerminalVisible || !isBottomTerminalOpen) {
            return;
        }

        const controller = terminalControllerRef.current;
        if (!controller) {
            return;
        }

        const fitOnce = () => {
            controller.fit();
        };

        if (typeof window !== 'undefined') {
            const rafId = window.requestAnimationFrame(() => {
                fitOnce();
            });
            const timeoutIds = [0, 80, 180, 320].map((delay) => window.setTimeout(fitOnce, delay));
            return () => {
                window.cancelAnimationFrame(rafId);
                timeoutIds.forEach((id) => window.clearTimeout(id));
            };
        }

        fitOnce();
    }, [bottomTerminalHeight, isBottomTerminalExpanded, isBottomTerminalOpen, isMobile, isTerminalVisible]);

    if (!hasActiveContext) {
        return (
            <div className="flex h-full items-center justify-center p-4 text-center text-sm text-muted-foreground">
                {t('terminalView.empty.selectSession')}
            </div>
        );
    }

    if (!effectiveDirectory) {
        return (
            <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center text-sm text-muted-foreground">
                <p>{t('terminalView.empty.noWorkingDirectoryForSession')}</p>
                <button
                    onClick={handleRestart}
                    className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
                >
                    {t('terminalView.actions.retry')}
                </button>
            </div>
        );
    }

    const quickKeysDisabled = !terminalSessionId || isConnecting || isRestarting || isReconnectPending;
    const shouldRenderViewport = isMobile ? isTerminalVisible : hasOpenedTerminalViewport;
    const showBottomDockControls = !isMobile && isBottomTerminalOpen && !isTerminalActive;
    const quickKeysControls = (
        <>
            <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-6 px-2 text-xs"
                onClick={() => handleMobileKeyPress('esc')}
                disabled={quickKeysDisabled}
            >
                {t('terminalView.quickKeys.escape')}
            </Button>
            <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-6 w-9 p-0"
                onClick={() => handleMobileKeyPress('tab')}
                disabled={quickKeysDisabled}
            >
                <RiArrowRightLine size={16} />
                <span className="sr-only">{t('terminalView.quickKeys.tabAria')}</span>
            </Button>
            <Button
                type="button"
                size="sm"
                variant="chip"
                aria-pressed={activeModifier === 'ctrl'}
                className="h-6 w-9 p-0"
                onClick={() => handleModifierToggle('ctrl')}
                disabled={quickKeysDisabled}
            >
                <span className="text-xs font-medium">{t('terminalView.quickKeys.controlLabel')}</span>
                <span className="sr-only">{t('terminalView.quickKeys.controlModifierAria')}</span>
            </Button>
            <Button
                type="button"
                size="sm"
                variant="chip"
                aria-pressed={activeModifier === 'cmd'}
                className="h-6 w-9 p-0"
                onClick={() => handleModifierToggle('cmd')}
                disabled={quickKeysDisabled}
            >
                <RiCommandLine size={16} />
                <span className="sr-only">{t('terminalView.quickKeys.commandModifierAria')}</span>
            </Button>
            <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-6 w-9 p-0"
                onClick={() => handleMobileKeyPress('arrow-up')}
                disabled={quickKeysDisabled}
            >
                <RiArrowUpLine size={16} />
                <span className="sr-only">{t('terminalView.quickKeys.arrowUpAria')}</span>
            </Button>
            <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-6 w-9 p-0"
                onClick={() => handleMobileKeyPress('arrow-left')}
                disabled={quickKeysDisabled}
            >
                <RiArrowLeftLine size={16} />
                <span className="sr-only">{t('terminalView.quickKeys.arrowLeftAria')}</span>
            </Button>
            <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-6 w-9 p-0"
                onClick={() => handleMobileKeyPress('arrow-down')}
                disabled={quickKeysDisabled}
            >
                <RiArrowDownLine size={16} />
                <span className="sr-only">{t('terminalView.quickKeys.arrowDownAria')}</span>
            </Button>
            <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-6 w-9 p-0"
                onClick={() => handleMobileKeyPress('arrow-right')}
                disabled={quickKeysDisabled}
            >
                <RiArrowRightLine size={16} />
                <span className="sr-only">{t('terminalView.quickKeys.arrowRightAria')}</span>
            </Button>
            <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-6 w-9 p-0"
                onClick={() => handleMobileKeyPress('enter')}
                disabled={quickKeysDisabled}
            >
                <RiArrowGoBackLine size={16} />
                <span className="sr-only">{t('terminalView.quickKeys.enterAria')}</span>
            </Button>
        </>
    );

    return (
        <div className="flex h-full flex-col overflow-hidden bg-[var(--surface-background)]">
            <div className={cn('app-region-no-drag sticky top-0 z-20 shrink-0 bg-[var(--surface-background)] text-xs', isMobile ? 'pl-3 pr-1.5 py-1' : 'pl-3 pr-1.5 py-1')}>
                {enableTabs && directoryTerminalState ? (
                    <div className="flex items-center gap-2 pl-1 pr-1">
                        <div className={cn('min-w-0 flex-1', isMobile ? 'h-8' : 'h-7')}>
                            <SortableTabsStrip
                                items={terminalTabItems}
                                activeId={activeTabId}
                                onSelect={handleSelectTab}
                                onClose={handleCloseTab}
                                layoutMode="scrollable"
                                variant="default"
                                className="h-full bg-transparent"
                            />
                        </div>

                        <Button
                            type="button"
                            size="xs"
                            variant="ghost"
                            className={cn('shrink-0', isMobile ? 'h-8 w-8 p-0' : 'h-7 w-7 p-0')}
                            onClick={handleCreateTab}
                            title={t('terminalView.tabs.newTabTitle')}
                        >
                            <RiAddLine size={isMobile ? 18 : 16} />
                        </Button>

                        <div className="flex shrink-0 items-center gap-1 overflow-visible">
                            {previewUrl ? (
                                <Button
                                    type="button"
                                    size="xs"
                                    variant="outline"
                                    className="h-6 shrink-0 gap-1 px-2"
                                    onClick={() => {
                                        if (!effectiveDirectory) return;
                                        openContextPreview(effectiveDirectory, previewUrl);
                                    }}
                                    title={t('terminalView.preview.openTitle')}
                                >
                                    <RiGlobalLine className="h-3.5 w-3.5 shrink-0" />
                                    <span className="whitespace-nowrap">{t('terminalView.preview.open')}</span>
                                </Button>
                            ) : null}
                            {showBottomDockControls ? (
                                <>
                                    <Button
                                        type="button"
                                        size="xs"
                                        variant="ghost"
                                        onClick={() => setBottomTerminalExpanded(!isBottomTerminalExpanded)}
                                        className={cn('shrink-0 p-0', isMobile ? 'h-8 w-8' : 'h-7 w-7')}
                                        title={isBottomTerminalExpanded ? t('terminalView.bottomDock.restoreTitle') : t('terminalView.bottomDock.expandTitle')}
                                        aria-label={isBottomTerminalExpanded ? t('terminalView.bottomDock.restoreAria') : t('terminalView.bottomDock.expandAria')}
                                    >
                                        {isBottomTerminalExpanded ? <RiFullscreenExitLine className="h-4 w-4" /> : <RiFullscreenLine className="h-4 w-4" />}
                                    </Button>
                                    <Button
                                        type="button"
                                        size="xs"
                                        variant="ghost"
                                        onClick={() => setBottomTerminalOpen(false)}
                                        className={cn('shrink-0 p-0', isMobile ? 'h-8 w-8' : 'h-7 w-7')}
                                        title={t('terminalView.bottomDock.closeTitle')}
                                        aria-label={t('terminalView.bottomDock.closeAria')}
                                    >
                                        <RiCloseLine className="h-4 w-4" />
                                    </Button>
                                </>
                            ) : null}
                        </div>
                    </div>
                ) : null}

                {!isMobile && showQuickKeys && enableTabs && directoryTerminalState ? (
                    <div className="mt-2 flex flex-wrap items-center gap-1 pl-1 pr-1">
                        {quickKeysControls}
                    </div>
                ) : null}

                {showQuickKeys && (isMobile || !enableTabs || !directoryTerminalState) ? (
                    <div className="mt-2 flex flex-wrap items-center gap-1">
                        {quickKeysControls}
                    </div>
                ) : null}
            </div>

            <div
                className="relative flex-1 overflow-hidden"
                style={{ backgroundColor: xtermTheme.background }}
            >
                <div className="h-full w-full box-border pl-4 pr-1.5 pt-3 pb-4">
                    {shouldRenderViewport ? (
                        <TerminalViewport
                            key={viewportSessionKey}
                            ref={(controller) => {
                                terminalControllerRef.current = controller;
                            }}
                            sessionKey={viewportSessionKey}
                            chunks={bufferChunks}
                            onInput={handleViewportInput}
                            onResize={handleViewportResize}
                            theme={xtermTheme}
                            fontFamily={resolvedFontStack}
                            fontSize={terminalFontSize}
                            enableTouchScroll={hasTouchInput}
                            autoFocus={isTerminalVisible}
                        />
                    ) : null}
                </div>
                {!isReconnectPending && connectionError && (
                    <div className="absolute inset-x-0 bottom-0 bg-[var(--status-error-background)] px-3 py-2 text-xs text-[var(--status-error-foreground)] flex items-center justify-between gap-2">
                        <span>{connectionError}</span>
                        {isFatalError && isMobile && (
                            <Button
                                size="sm"
                                variant="secondary"
                                className="h-6 px-2 py-0 text-xs"
                                onClick={handleHardRestart}
                                disabled={isRestarting}
                                title={t('terminalView.actions.hardRestartTitle')}
                                type="button"
                            >
                                {t('terminalView.actions.hardRestart')}
                            </Button>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
};
