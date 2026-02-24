import React from 'react';
import { RiAddLine, RiArrowDownLine, RiArrowGoBackLine, RiArrowLeftLine, RiArrowRightLine, RiArrowUpLine, RiCloseLine, RiCommandLine } from '@remixicon/react';

import { useSessionStore } from '@/stores/useSessionStore';
import { useTerminalStore } from '@/stores/useTerminalStore';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { type TerminalStreamEvent } from '@/lib/api/types';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useFontPreferences } from '@/hooks/useFontPreferences';
import { CODE_FONT_OPTION_MAP, DEFAULT_MONO_FONT } from '@/lib/fontOptions';
import { convertThemeToXterm } from '@/lib/terminalTheme';
import { TerminalViewport, type TerminalController } from '@/components/terminal/TerminalViewport';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';
import { Button } from '@/components/ui/button';
import { useDeviceInfo } from '@/lib/device';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { primeTerminalInputTransport } from '@/lib/terminalApi';

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
        maxRetries: 0,
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
    const { terminal, runtime } = useRuntimeAPIs();
    const { currentTheme } = useThemeSystem();
    const { monoFont } = useFontPreferences();
    const terminalFontSize = useUIStore(state => state.terminalFontSize);
    const { isMobile, hasTouchInput } = useDeviceInfo();
    // Tabs are supported for web + desktop runtimes (not VSCode).
    const enableTabs = !isMobile && runtime.platform !== 'vscode';
    const showTerminalQuickKeysOnDesktop = useUIStore((state) => state.showTerminalQuickKeysOnDesktop);
    const showQuickKeys = isMobile || showTerminalQuickKeysOnDesktop;

    const { currentSessionId, newSessionDraft } = useSessionStore();
    const hasActiveContext = currentSessionId !== null || newSessionDraft?.open === true;

    const effectiveDirectory = useEffectiveDirectory() ?? null;
    const terminalStore = useTerminalStore();
    const terminalSessions = terminalStore.sessions;
    const terminalHydrated = terminalStore.hasHydrated;
    const ensureDirectory = terminalStore.ensureDirectory;
    const createTab = terminalStore.createTab;
    const setActiveTab = terminalStore.setActiveTab;
    const closeTab = terminalStore.closeTab;
    const setTabSessionId = terminalStore.setTabSessionId;
    const setConnecting = terminalStore.setConnecting;
    const appendToBuffer = terminalStore.appendToBuffer;

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

    const terminalSessionId = activeTab?.terminalSessionId ?? null;
    const bufferChunks = activeTab?.bufferChunks ?? [];
    const isConnecting = activeTab?.isConnecting ?? false;

    const [connectionError, setConnectionError] = React.useState<string | null>(null);
    const [isFatalError, setIsFatalError] = React.useState(false);
    const [activeModifier, setActiveModifier] = React.useState<Modifier | null>(null);
    const [isRestarting, setIsRestarting] = React.useState(false);
    const keyboardAvoidTargetId = React.useId();

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
                                terminalControllerRef.current?.focus();

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
                                const attempt = event.attempt ?? 0;
                                const maxAttempts = event.maxAttempts ?? 3;
                                setConnectionError(`Reconnecting (${attempt}/${maxAttempts})...`);
                                setIsFatalError(false);
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
                                appendToBuffer(
                                    directory,
                                    tabId,
                                    `\r\n[Process exited${
                                        exitCode !== null ? ` with code ${exitCode}` : ''
                                    }${signal !== null ? ` (signal ${signal})` : ''}]\r\n`
                                );
                                setTabSessionId(directory, tabId, null);
                                setConnecting(directory, tabId, false);
                                setConnectionError('Terminal session ended');
                                setIsFatalError(false);
                                disconnectStream();
                                break;
                            }
                        }
                    },
                    onError: (error, fatal) => {
                        if (activeTerminalIdRef.current !== terminalId) {
                            return;
                        }

                        const errorMsg = fatal
                            ? `Connection failed: ${error.message}`
                            : error.message || 'Terminal stream connection error';

                        setConnectionError(errorMsg);
                        setIsFatalError(!!fatal);

                        if (fatal) {
                            setConnecting(directory, tabId, false);
                            setTabSessionId(directory, tabId, null);
                            disconnectStream();
                        }
                    },
                },
                streamOptions
            );

            streamCleanupRef.current = () => {
                subscription.close();
                activeTerminalIdRef.current = null;
            };
        },
        [appendToBuffer, disconnectStream, setConnecting, setTabSessionId, terminal]
    );

    React.useEffect(() => {
        let cancelled = false;

        if (!terminalHydrated || !hasOpenedTerminalViewport) {
            return;
        }

        if (!effectiveDirectory) {
            setConnectionError(
                hasActiveContext
                    ? 'No working directory available for terminal.'
                    : 'Select a session to open the terminal.'
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

            const shouldNudgeExisting =
                Boolean(terminalId) &&
                rehydratedTerminalIdsRef.current.has(terminalId as string) &&
                (tab?.bufferLength ?? 0) === 0 &&
                (tab?.bufferChunks?.length ?? 0) === 0;

            const isRehydratedSession =
                Boolean(terminalId) && rehydratedTerminalIdsRef.current.has(terminalId as string);

            if (!terminalId) {
                setConnectionError(null);
                setIsFatalError(false);
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
                                : 'Failed to start terminal session'
                        );
                        setIsFatalError(true);
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
        activeTabId,
        hasOpenedTerminalViewport,
        enableTabs,
        terminalHydrated,
        ensureDirectory,
        setConnecting,
        setTabSessionId,
        startStream,
        disconnectStream,
        terminal,
    ]);

    React.useEffect(() => {
        if (!isTerminalVisible) {
            return;
        }

        if (typeof window === 'undefined') {
            terminalControllerRef.current?.focus();
            return;
        }

        const rafId = window.requestAnimationFrame(() => {
            terminalControllerRef.current?.focus();
        });

        return () => {
            window.cancelAnimationFrame(rafId);
        };
    }, [activeTabId, isTerminalVisible]);

    const handleRestart = React.useCallback(async () => {
        if (!effectiveDirectory) return;
        if (isRestarting) return;

        const state = useTerminalStore.getState().getDirectoryState(effectiveDirectory);
        const tabId = isMobile
            ? (state?.tabs[0]?.id ?? null)
            : (activeTabId ?? state?.activeTabId ?? state?.tabs[0]?.id ?? null);
        if (!tabId) return;

        setIsRestarting(true);
        setConnectionError(null);
        setIsFatalError(false);

        disconnectStream();

        try {
            await closeTab(effectiveDirectory, tabId);
        } catch (error) {
            setConnectionError(error instanceof Error ? error.message : 'Failed to restart terminal');
            setIsFatalError(true);
        } finally {
            setIsRestarting(false);
        }
    }, [activeTabId, closeTab, disconnectStream, effectiveDirectory, isMobile, isRestarting]);

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
        disconnectStream();
    }, [createTab, disconnectStream, effectiveDirectory, setActiveTab]);

    const handleSelectTab = React.useCallback(
        (tabId: string) => {
            if (!effectiveDirectory) return;
            setActiveTab(effectiveDirectory, tabId);
            setConnectionError(null);
            setIsFatalError(false);
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
            void closeTab(effectiveDirectory, tabId);
        },
        [activeTabId, closeTab, disconnectStream, effectiveDirectory]
    );


    const handleViewportInput = React.useCallback(
        (data: string) => {
            if (!data) {
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
                setConnectionError(error instanceof Error ? error.message : 'Failed to send input');
            });

            if (modifierConsumed) {
                setActiveModifier(null);
                terminalControllerRef.current?.focus();
            }
        },
        [activeModifier, setActiveModifier, terminal]
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

    const viewportSessionKey = terminalSessionId ?? terminalSessionKey;

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
                controller.focus();
            });
            const timeoutIds = [220, 400].map((delay) => window.setTimeout(fitOnce, delay));
            return () => {
                window.cancelAnimationFrame(rafId);
                timeoutIds.forEach((id) => window.clearTimeout(id));
            };
        }
        fitOnce();
    }, [isTerminalVisible, terminalSessionKey, terminalSessionId]);

    if (!hasActiveContext) {
        return (
            <div className="flex h-full items-center justify-center p-4 text-center text-sm text-muted-foreground">
                Select a session to open the terminal
            </div>
        );
    }

    if (!effectiveDirectory) {
        return (
            <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center text-sm text-muted-foreground">
                <p>No working directory available for this session.</p>
                <button
                    onClick={handleRestart}
                    className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
                >
                    Retry
                </button>
            </div>
        );
    }

    const quickKeysDisabled = !terminalSessionId || isConnecting || isRestarting;
    const shouldRenderViewport = isMobile ? isTerminalVisible : hasOpenedTerminalViewport;
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
                Esc
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
                <span className="sr-only">Tab</span>
            </Button>
            <Button
                type="button"
                size="sm"
                variant="outline"
                className={cn(
                    "h-6 w-9 p-0",
                    activeModifier === 'ctrl'
                        ? 'border-[var(--primary-base)] text-[var(--primary-base)] bg-[var(--primary-base)]/10 hover:text-[var(--primary-base)]'
                        : undefined
                )}
                onClick={() => handleModifierToggle('ctrl')}
                disabled={quickKeysDisabled}
            >
                <span className="text-xs font-medium">Ctrl</span>
                <span className="sr-only">Control modifier</span>
            </Button>
            <Button
                type="button"
                size="sm"
                variant="outline"
                className={cn(
                    "h-6 w-9 p-0",
                    activeModifier === 'cmd'
                        ? 'border-[var(--primary-base)] text-[var(--primary-base)] bg-[var(--primary-base)]/10 hover:text-[var(--primary-base)]'
                        : undefined
                )}
                onClick={() => handleModifierToggle('cmd')}
                disabled={quickKeysDisabled}
            >
                <RiCommandLine size={16} />
                <span className="sr-only">Command modifier</span>
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
                <span className="sr-only">Arrow up</span>
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
                <span className="sr-only">Arrow left</span>
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
                <span className="sr-only">Arrow down</span>
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
                <span className="sr-only">Arrow right</span>
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
                <span className="sr-only">Enter</span>
            </Button>
        </>
    );

    return (
        <div className="flex h-full flex-col overflow-hidden bg-[var(--surface-background)]">
            <div className="sticky top-0 z-20 shrink-0 bg-[var(--surface-background)] px-5 py-2 text-xs">
                {enableTabs && directoryTerminalState ? (
                    <div className="mt-2 pl-1 pr-1 flex items-center gap-2">
                        <div className="min-w-0 flex-1 overflow-x-auto pb-1">
                            <div className="flex w-max items-center gap-1 pr-1">
                                {directoryTerminalState.tabs.map((tab) => {
                                    const isActive = tab.id === activeTabId;
                                    return (
                                        <div
                                            key={tab.id}
                                            className={cn(
                                                'group flex items-center gap-1 rounded-md border px-2 py-1 text-xs whitespace-nowrap',
                                                isActive
                                                    ? 'bg-[var(--interactive-selection)] border-[var(--primary-muted)] text-[var(--interactive-selection-foreground)]'
                                                    : 'bg-transparent border-[var(--interactive-border)] text-[var(--surface-muted-foreground)] hover:bg-[var(--interactive-hover)] hover:text-[var(--surface-foreground)]'
                                            )}
                                        >
                                            <button
                                                type="button"
                                                onClick={() => handleSelectTab(tab.id)}
                                                className="max-w-[10rem] truncate text-left"
                                                title={tab.label}
                                            >
                                                {tab.label}
                                            </button>
                                            <button
                                                type="button"
                                                className={cn(
                                                    'rounded-sm p-0.5 text-[var(--surface-muted-foreground)] hover:text-[var(--surface-foreground)]',
                                                    !isActive && 'opacity-0 group-hover:opacity-100'
                                                )}
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    handleCloseTab(tab.id);
                                                }}
                                                title="Close tab"
                                            >
                                                <RiCloseLine size={14} />
                                            </button>
                                        </div>
                                    );
                                })}

                                <button
                                    type="button"
                                    onClick={handleCreateTab}
                                    className="ml-1 flex h-7 w-7 items-center justify-center rounded-md border border-[var(--interactive-border)] bg-transparent text-[var(--surface-muted-foreground)] hover:bg-[var(--interactive-hover)] hover:text-[var(--surface-foreground)]"
                                    title="New tab"
                                >
                                    <RiAddLine size={16} />
                                </button>
                            </div>
                        </div>

                        {!isMobile && showQuickKeys ? (
                            <div className="flex shrink-0 items-center gap-1 overflow-x-auto pb-1">
                                {quickKeysControls}
                            </div>
                        ) : null}
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
                id={keyboardAvoidTargetId}
                data-keyboard-avoid="true"
            >
                <div className="h-full w-full box-border pl-7 pr-5 pt-3 pb-4">
                    {shouldRenderViewport ? (
                        isMobile ? (
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
                                keyboardAvoidTargetId={keyboardAvoidTargetId}
                            />
                        ) : (
                            <ScrollableOverlay outerClassName="h-full" className="h-full w-full" disableHorizontal>
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
                                    keyboardAvoidTargetId={keyboardAvoidTargetId}
                                />
                            </ScrollableOverlay>
                        )
                    ) : null}
                </div>
                {connectionError && (
                    <div className="absolute inset-x-0 bottom-0 bg-[var(--status-error-background)] px-3 py-2 text-xs text-[var(--status-error-foreground)] flex items-center justify-between gap-2">
                        <span>{connectionError}</span>
                        {isFatalError && isMobile && (
                            <Button
                                size="sm"
                                variant="secondary"
                                className="h-6 px-2 py-0 text-xs"
                                onClick={handleHardRestart}
                                disabled={isRestarting}
                                title="Force kill and create fresh session"
                                type="button"
                            >
                                Hard Restart
                            </Button>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
};
