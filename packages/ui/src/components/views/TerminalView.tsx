import React from 'react';

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
import { Icon } from "@/components/icon/Icon";
import { useDeviceInfo } from '@/lib/device';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { extractTerminalPreviewUrl, isTerminalPreviewUrlAvailable } from '@/lib/terminalPreview';
import { useI18n } from '@/lib/i18n';
import { PROJECT_ACTION_ICON_MAP, type ProjectActionIconKey } from '@/lib/projectActions';
import { useInlineCommentDraftStore } from '@/stores/useInlineCommentDraftStore';
import { applyTerminalModifier, terminalControlCharacter, terminalSequenceForKey, type TerminalModifier as Modifier, type TerminalQuickKey as MobileKey } from '@/lib/terminalInput';

type TerminalViewProps = {
    visible?: boolean;
};

export const TerminalView: React.FC<TerminalViewProps> = ({ visible }) => {
    const { t } = useI18n();
    const { terminal, runtime } = useRuntimeAPIs();
    const { currentTheme } = useThemeSystem();
    const terminalAppearanceRef = React.useRef<{ themeMode: 'light' | 'dark'; terminalBackground: string; terminalForeground: string }>({ themeMode: 'dark', terminalBackground: '', terminalForeground: '' });
    terminalAppearanceRef.current = { themeMode: currentTheme.metadata.variant === 'light' ? 'light' : 'dark', terminalBackground: currentTheme.colors.surface.background, terminalForeground: currentTheme.colors.syntax.base.foreground };
    const { monoFont } = useFontPreferences();
    const terminalFontSize = useUIStore(state => state.terminalFontSize);
    const terminalShell = useUIStore(state => state.terminalShell);
    const terminalLoginShell = useUIStore(state => state.terminalLoginShells.includes(state.terminalShell));
    const bottomTerminalHeight = useUIStore((state) => state.bottomTerminalHeight);
    const isBottomTerminalExpanded = useUIStore((state) => state.isBottomTerminalExpanded);
    const { isMobile, isTablet, hasTouchOnlyPointer } = useDeviceInfo();
    const isTouchTerminal = isMobile || isTablet;
    const useTouchTerminalInput = (isTouchTerminal || hasTouchOnlyPointer) && runtime.platform === 'web';
    // Tabs are supported for web + desktop runtimes, including mobile (not VSCode).
    const enableTabs = runtime.platform !== 'vscode';
    const showTerminalQuickKeysOnDesktop = useUIStore((state) => state.showTerminalQuickKeysOnDesktop);
    const showQuickKeys = isTouchTerminal || showTerminalQuickKeysOnDesktop;

    const currentSessionId = useSessionUIStore((s) => s.currentSessionId);
    const newSessionDraft = useSessionUIStore((s) => s.newSessionDraft);
    const hasActiveContext = currentSessionId !== null || newSessionDraft?.open === true;

    const effectiveDirectory = useEffectiveDirectory() ?? null;
    const directoryTerminalState = useTerminalStore((s) => effectiveDirectory ? s.sessions.get(effectiveDirectory) : undefined);
    const terminalHydrated = useTerminalStore((s) => s.hasHydrated);
    const ensureDirectory = useTerminalStore((s) => s.ensureDirectory);
    const createTab = useTerminalStore((s) => s.createTab);
    const setActiveTab = useTerminalStore((s) => s.setActiveTab);
    const closeTab = useTerminalStore((s) => s.closeTab);
    const setTabSessionId = useTerminalStore((s) => s.setTabSessionId);
    const setTabLifecycle = useTerminalStore((s) => s.setTabLifecycle);
    const setConnecting = useTerminalStore((s) => s.setConnecting);
    const appendToBuffer = useTerminalStore((s) => s.appendToBuffer);
    const replaceBuffer = useTerminalStore((s) => s.replaceBuffer);
    const setTabPreviewUrl = useTerminalStore((s) => s.setTabPreviewUrl);
    const addContextDraft = useInlineCommentDraftStore((s) => s.addDraft);

    const openContextPreview = useUIStore((state) => state.openContextPreview);

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
                const tabIconName = tab.iconKey ? PROJECT_ACTION_ICON_MAP[tab.iconKey as ProjectActionIconKey] ?? 'terminal' : 'terminal';
                return <Icon name={tabIconName} className="h-4 w-4" />;
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
    const [hasViewportSize, setHasViewportSize] = React.useState(false);

    const streamCleanupRef = React.useRef<(() => void) | null>(null);
    const activeTerminalIdRef = React.useRef<string | null>(null);
    const activeTabIdRef = React.useRef<string | null>(activeTabId);
    const terminalIdRef = React.useRef<string | null>(terminalSessionId);
    const directoryRef = React.useRef<string | null>(effectiveDirectory);
    const terminalControllerRef = React.useRef<TerminalController | null>(null);
    const lastViewportSizeRef = React.useRef<{ cols: number; rows: number } | null>(null);
    const isTerminalVisibleRef = React.useRef(false);
    const previewScanTailRef = React.useRef('');
    const pendingPreviewProbeUrlsRef = React.useRef<Set<string>>(new Set());
    const previewProbeGenerationRef = React.useRef(0);

    const resetTerminalPreviewScan = React.useCallback(() => {
        previewScanTailRef.current = '';
        pendingPreviewProbeUrlsRef.current.clear();
        previewProbeGenerationRef.current += 1;
    }, []);

    const focusTerminalWhenWindowActive = React.useCallback(() => {
        if (useTouchTerminalInput) {
            return;
        }
        if (typeof document !== 'undefined' && !document.hasFocus()) {
            return;
        }
        terminalControllerRef.current?.focus();
    }, [useTouchTerminalInput]);

    const focusTerminalController = React.useCallback(() => {
        if (useTouchTerminalInput) {
            return;
        }
        terminalControllerRef.current?.focus();
    }, [useTouchTerminalInput]);

    const activeMainTab = useUIStore((state) => state.activeMainTab);
    const isBottomTerminalOpen = useUIStore((state) => state.isBottomTerminalOpen);
    const setBottomTerminalOpen = useUIStore((state) => state.setBottomTerminalOpen);
    const setBottomTerminalExpanded = useUIStore((state) => state.setBottomTerminalExpanded);
    const isTerminalActive = activeMainTab === 'terminal';
    const isTerminalVisible = visible ?? (isTerminalActive || isBottomTerminalOpen);
    const [hasOpenedTerminalViewport, setHasOpenedTerminalViewport] = React.useState(isTerminalVisible);

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
        if (!terminalSessionId || !terminal.updateAppearance) return;
        void terminal.updateAppearance(terminalSessionId, terminalAppearanceRef.current).catch(() => {});
    }, [currentTheme.colors.surface.background, currentTheme.colors.syntax.base.foreground, currentTheme.metadata.variant, terminal, terminalSessionId]);

    React.useEffect(() => {
        activeTabIdRef.current = activeTabId;
        resetTerminalPreviewScan();
    }, [activeTabId, resetTerminalPreviewScan]);

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

    const scanTerminalPreviewOutput = React.useCallback(
        (directory: string, tabId: string, data: string) => {
            if (!data) {
                return;
            }

            const combined = `${previewScanTailRef.current}${data}`.replace(/\r\n|\r/g, '\n');
            const lines = combined.split('\n');
            const completeText = combined.endsWith('\n')
                ? lines.join('\n')
                : lines.slice(0, -1).join('\n');
            previewScanTailRef.current = combined.endsWith('\n') ? '' : (lines[lines.length - 1] ?? '').slice(-1024);

            if (!completeText) {
                return;
            }

            const candidate = extractTerminalPreviewUrl(completeText);
            if (!candidate || pendingPreviewProbeUrlsRef.current.has(candidate)) {
                return;
            }

            const probeGeneration = previewProbeGenerationRef.current;
            pendingPreviewProbeUrlsRef.current.add(candidate);
            void isTerminalPreviewUrlAvailable(candidate).then((available) => {
                pendingPreviewProbeUrlsRef.current.delete(candidate);
                if (!available || previewProbeGenerationRef.current !== probeGeneration) {
                    return;
                }

                const currentTab = useTerminalStore.getState().getDirectoryState(directory)?.tabs.find((tab) => tab.id === tabId);
                if (!currentTab || currentTab.previewUrlLocked || currentTab.previewUrl === candidate) {
                    return;
                }

                setTabPreviewUrl(directory, tabId, candidate, { locked: false, autoOpened: false });
            });
        },
        [setTabPreviewUrl]
    );

    const startStream = React.useCallback(
        (
            directory: string,
            tabId: string,
            terminalId: string
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
                            case 'snapshot': {
                                setConnecting(directory, tabId, false);
                                setConnectionError(null);
                                setIsFatalError(false);
                                setIsReconnectPending(false);
                                focusTerminalWhenWindowActive();

                                replaceBuffer(directory, tabId, event.data ?? '', event.sequence ?? 0);
                                scanTerminalPreviewOutput(directory, tabId, event.data ?? '');
                                if (event.status === 'exited') setTabLifecycle(directory, tabId, 'exited');
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
                                    appendToBuffer(directory, tabId, event.data, event.sequence, event.replayData);
                                    scanTerminalPreviewOutput(directory, tabId, event.data);
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
                        if (error.code === 'SESSION_NOT_FOUND') {
                            const currentTab = useTerminalStore.getState().getDirectoryState(directory)?.tabs.find((tab) => tab.id === tabId);
                            if (!currentTab?.label?.startsWith('Action:')) {
                                setConnectionError(null);
                                setIsFatalError(false);
                                setConnecting(directory, tabId, false);
                                setTabSessionId(directory, tabId, null);
                                setTabLifecycle(directory, tabId, 'idle');
                                disconnectStream();
                                return;
                            }
                        }
                        setConnectionError(
                            t('terminalView.error.connectionFailed', { message: error.message })
                        );
                        setIsFatalError(true);
                        setConnecting(directory, tabId, false);
                        setTabLifecycle(directory, tabId, 'exited');
                        setTabSessionId(directory, tabId, null);
                        disconnectStream();
                    },
                }
            );

            streamCleanupRef.current = () => {
                subscription.close();
                activeTerminalIdRef.current = null;
            };
        },
        [
            appendToBuffer,
            replaceBuffer,
            disconnectStream,
            focusTerminalWhenWindowActive,
            scanTerminalPreviewOutput,
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

            const existingState = useTerminalStore.getState().getDirectoryState(directory);
            if (!existingState) {
                ensureDirectory(directory);
                return;
            }

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

            if (!terminalId) {
                if (terminalLifecycle === 'exited') {
                    setConnecting(directory, tabId, false);
                    return;
                }

                if (isActionTab && hasBufferedOutput) {
                    setConnecting(directory, tabId, false);
                    return;
                }

                const size = lastViewportSizeRef.current;
                if (!size && isTerminalVisibleRef.current) {
                    return;
                }

                setConnectionError(null);
                setIsFatalError(false);
                setIsReconnectPending(false);
                setConnecting(directory, tabId, true);
                try {
                    const session = await terminal.createSession({
                        cwd: directory,
                        sessionId: tabId,
                        cols: size?.cols,
                        rows: size?.rows,
                        shell: terminalShell,
                        loginShell: terminalLoginShell,
                        ...terminalAppearanceRef.current,
                    });

                    const stillActive =
                        !cancelled &&
                        directoryRef.current === directory &&
                        activeTabIdRef.current === tabId;

                    const owningTab = useTerminalStore.getState().getDirectoryState(directory)?.tabs.find((entry) => entry.id === tabId);
                    if (!owningTab) {
                        try {
                            await terminal.close(session.sessionId);
                        } catch { /* ignored */ }
                        return;
                    }

                    setTabSessionId(directory, tabId, session.sessionId);
                    if (!stillActive) return;
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

            startStream(directory, tabId, terminalId);
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
        hasViewportSize,
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
        terminalLoginShell,
        terminalShell,
    ]);

    React.useEffect(() => {
        if (!isTerminalVisible || useTouchTerminalInput) {
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
    }, [activeTabId, focusTerminalWhenWindowActive, isTerminalVisible, useTouchTerminalInput]);

    const handleRestart = React.useCallback(async () => {
        if (!effectiveDirectory) return;
        if (isRestarting) return;

        const state = useTerminalStore.getState().getDirectoryState(effectiveDirectory);
        const tabId = enableTabs
            ? (activeTabId ?? state?.activeTabId ?? state?.tabs[0]?.id ?? null)
            : (state?.tabs[0]?.id ?? null);
        if (!tabId) return;
        const originalSessionId = state?.tabs.find((tab) => tab.id === tabId)?.terminalSessionId ?? null;
        if (!originalSessionId || !terminal.restartSession) return;

        setIsRestarting(true);
        setConnectionError(null);
        setIsFatalError(false);
        setIsReconnectPending(false);

        disconnectStream();
        resetTerminalPreviewScan();

        try {
            const size = lastViewportSizeRef.current ?? { cols: 80, rows: 24 };
            const restarted = await terminal.restartSession(originalSessionId, { cwd: effectiveDirectory, shell: terminalShell, loginShell: terminalLoginShell, ...size, ...terminalAppearanceRef.current });
            const owningTab = useTerminalStore.getState().getDirectoryState(effectiveDirectory)?.tabs.find((tab) => tab.id === tabId);
            if (owningTab?.terminalSessionId !== originalSessionId) return;
            setTabSessionId(effectiveDirectory, tabId, restarted.sessionId);
            setTabLifecycle(effectiveDirectory, tabId, 'running');
            if (directoryRef.current !== effectiveDirectory || activeTabIdRef.current !== tabId) return;
            terminalIdRef.current = restarted.sessionId;
            startStream(effectiveDirectory, tabId, restarted.sessionId);
        } catch (error) {
            const owningTab = useTerminalStore.getState().getDirectoryState(effectiveDirectory)?.tabs.find((tab) => tab.id === tabId);
            if (
                owningTab?.terminalSessionId !== originalSessionId
                || directoryRef.current !== effectiveDirectory
                || activeTabIdRef.current !== tabId
            ) return;
            setConnectionError(
                error instanceof Error ? error.message : t('terminalView.error.restartFailed')
            );
            setIsFatalError(false);
            setIsReconnectPending(false);
            terminalIdRef.current = originalSessionId;
            startStream(effectiveDirectory, tabId, originalSessionId);
        } finally {
            setIsRestarting(false);
        }
    }, [activeTabId, disconnectStream, effectiveDirectory, enableTabs, isRestarting, resetTerminalPreviewScan, setTabLifecycle, setTabSessionId, startStream, t, terminal, terminalLoginShell, terminalShell]);

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

    const handleAttachSelection = React.useCallback(() => {
        const selection = terminalControllerRef.current?.getSelection();
        const sessionKey = currentSessionId ?? (newSessionDraft?.open ? 'draft' : null);
        if (!selection || !sessionKey || !activeTab) return;
        addContextDraft({
            sessionKey,
            source: 'terminal',
            fileLabel: activeTab.label,
            startLine: selection.startLine,
            endLine: selection.endLine,
            code: selection.text,
            language: activeTab.terminalSessionId ?? activeTab.id,
            text: '',
        });
    }, [activeTab, addContextDraft, currentSessionId, newSessionDraft?.open]);

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
            const sessionId = useTerminalStore.getState().getDirectoryState(effectiveDirectory)?.tabs.find((tab) => tab.id === tabId)?.terminalSessionId;
            void (async () => {
                if (sessionId) await terminal.close(sessionId);
                closeTab(effectiveDirectory, tabId);
            })().catch((error) => setConnectionError(error instanceof Error ? error.message : t('terminalView.error.sessionEnded')));
        },
        [activeTabId, closeTab, disconnectStream, effectiveDirectory, t, terminal]
    );

    const handleViewportInput = React.useCallback(
        (data: string) => {
            if (!data || isReconnectPending) {
                return;
            }

            let payload = data;
            let modifierConsumed = false;

            if (activeModifier && data.length > 0) {
                payload = applyTerminalModifier(data, activeModifier);
                modifierConsumed = true;
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
                focusTerminalController();
            }
        },
        [activeModifier, focusTerminalController, isReconnectPending, setActiveModifier, t, terminal]
    );

    const handleViewportResize = React.useCallback(
        (cols: number, rows: number) => {
            const previous = lastViewportSizeRef.current;
            if (!previous) {
                lastViewportSizeRef.current = { cols, rows };
                if (!terminalIdRef.current) setHasViewportSize(true);
            } else if (previous.cols !== cols || previous.rows !== rows) {
                lastViewportSizeRef.current = { cols, rows };
            }
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
            focusTerminalController();
        },
        [focusTerminalController, setActiveModifier]
    );

    const handleMobileKeyPress = React.useCallback(
        (key: MobileKey) => {
            const sequence = terminalSequenceForKey(key, activeModifier);
            if (!sequence) {
                return;
            }
            handleViewportInput(sequence);
            setActiveModifier(null);
            focusTerminalController();
        },
        [activeModifier, focusTerminalController, handleViewportInput, setActiveModifier]
    );

    const QUICK_KEY_MAP = React.useMemo<Record<string, MobileKey>>(() => ({
        Tab: 'tab', Enter: 'enter', ArrowUp: 'arrow-up', ArrowDown: 'arrow-down',
        ArrowLeft: 'arrow-left', ArrowRight: 'arrow-right', Escape: 'esc',
    }), []);

    const handleQuickKeyDown = React.useCallback((event: KeyboardEvent) => {
        if (event.repeat) return;
        const rawKey = event.key;
        if (!rawKey || rawKey === 'Control' || rawKey === 'Meta' || rawKey === 'Alt' || rawKey === 'Shift') return;

        const normalizedKey = rawKey.length === 1 ? rawKey.toLowerCase() : rawKey;
        if (normalizedKey in QUICK_KEY_MAP) {
            event.preventDefault();
            event.stopPropagation();
            handleMobileKeyPress(QUICK_KEY_MAP[normalizedKey]);
            return;
        }

        if (activeModifier !== 'ctrl') return;

        const code = event.code ?? '';
        const upperKey =
            rawKey.length === 1 && /[a-zA-Z]/.test(rawKey)
                ? rawKey.toUpperCase()
                : (code.startsWith('Key') && code.length === 4 ? code.slice(3).toUpperCase() : null);

        if (upperKey && upperKey.length === 1 && upperKey >= 'A' && upperKey <= 'Z') {
            const controlCode = terminalControlCharacter(upperKey);
            if (!controlCode) return;
            event.preventDefault();
            event.stopPropagation();
            handleViewportInput(controlCode);
            setActiveModifier(null);
            focusTerminalController();
        }
    }, [activeModifier, focusTerminalController, handleMobileKeyPress, handleViewportInput, QUICK_KEY_MAP, setActiveModifier]);

    React.useEffect(() => {
        if (!showQuickKeys || !activeModifier || !terminalSessionId) return;
        window.addEventListener('keydown', handleQuickKeyDown);
        return () => window.removeEventListener('keydown', handleQuickKeyDown);
    }, [activeModifier, handleQuickKeyDown, showQuickKeys, terminalSessionId]);

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

    const terminalViewportKey = React.useMemo(() => {
        const directoryPart = effectiveDirectory ?? 'no-dir';
        const tabPart = activeTabId ?? 'no-tab';
        const terminalPart = terminalSessionId ?? 'no-terminal';
        return `${directoryPart}::${tabPart}::${terminalPart}`;
    }, [effectiveDirectory, activeTabId, terminalSessionId]);

    React.useEffect(() => {
        if (!isTerminalVisible || useTouchTerminalInput) {
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
    }, [focusTerminalWhenWindowActive, isTerminalVisible, useTouchTerminalInput, terminalViewportKey, terminalSessionId]);

    React.useEffect(() => {
        if (!isTerminalVisible || !useTouchTerminalInput) return;
        let fitFrame: number | null = null;
        const handleKeyboardSettled = () => {
            if (fitFrame !== null) window.cancelAnimationFrame(fitFrame);
            fitFrame = window.requestAnimationFrame(() => {
                fitFrame = null;
                terminalControllerRef.current?.fit();
            });
        };
        window.addEventListener('oc:keyboard-settled', handleKeyboardSettled);
        return () => {
            window.removeEventListener('oc:keyboard-settled', handleKeyboardSettled);
            if (fitFrame !== null) window.cancelAnimationFrame(fitFrame);
        };
    }, [isTerminalVisible, terminalViewportKey, useTouchTerminalInput]);

    React.useEffect(() => {
        if (useTouchTerminalInput || !isTerminalVisible || !isBottomTerminalOpen) {
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
            const timeoutIds = [320].map((delay) => window.setTimeout(fitOnce, delay));
            return () => {
                window.cancelAnimationFrame(rafId);
                timeoutIds.forEach((id) => window.clearTimeout(id));
            };
        }

        fitOnce();
    }, [bottomTerminalHeight, isBottomTerminalExpanded, isBottomTerminalOpen, isTerminalVisible, useTouchTerminalInput]);

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
    const shouldRenderViewport = hasOpenedTerminalViewport;
    const showBottomDockControls = !isTouchTerminal && isBottomTerminalOpen && !isTerminalActive;
    const quickKeySize: 'lg' | 'xs' = isTouchTerminal ? 'lg' : 'xs';
    const quickKeyIconClass = isTouchTerminal ? 'w-10 p-0' : 'w-9 p-0';
    const preserveTerminalFocus = (event: React.PointerEvent<HTMLButtonElement>) => {
        if (isTouchTerminal) event.preventDefault();
    };
    const quickKeysControls = (
        <>
            <Button
                type="button"
                size={quickKeySize}
                variant="outline"
                onPointerDown={preserveTerminalFocus}
                onClick={() => handleMobileKeyPress('esc')}
                disabled={quickKeysDisabled}
            >
                {t('terminalView.quickKeys.escape')}
            </Button>
            <Button
                type="button"
                size={quickKeySize}
                variant="outline"
                className={quickKeyIconClass}
                onPointerDown={preserveTerminalFocus}
                onClick={() => handleMobileKeyPress('tab')}
                disabled={quickKeysDisabled}
            >
                <Icon name="arrow-right" className="h-4 w-4" />
                <span className="sr-only">{t('terminalView.quickKeys.tabAria')}</span>
            </Button>
            <Button
                type="button"
                size={quickKeySize}
                variant="chip"
                aria-pressed={activeModifier === 'ctrl'}
                className={isTouchTerminal ? 'px-3' : 'px-2'}
                onPointerDown={preserveTerminalFocus}
                onClick={() => handleModifierToggle('ctrl')}
                disabled={quickKeysDisabled}
            >
                <span className="text-xs font-medium">{t('terminalView.quickKeys.controlLabel')}</span>
                <span className="sr-only">{t('terminalView.quickKeys.controlModifierAria')}</span>
            </Button>
            <Button
                type="button"
                size={quickKeySize}
                variant="chip"
                aria-pressed={activeModifier === 'alt'}
                className={isTouchTerminal ? 'px-3' : 'px-2'}
                onPointerDown={preserveTerminalFocus}
                onClick={() => handleModifierToggle('alt')}
                disabled={quickKeysDisabled}
            >
                <span className="text-xs font-medium">{t('terminalView.quickKeys.altLabel')}</span>
                <span className="sr-only">{t('terminalView.quickKeys.altModifierAria')}</span>
            </Button>
            <Button
                type="button"
                size={quickKeySize}
                variant="outline"
                className={quickKeyIconClass}
                onPointerDown={preserveTerminalFocus}
                onClick={() => handleMobileKeyPress('arrow-up')}
                disabled={quickKeysDisabled}
            >
                <Icon name="arrow-up"/>
                <span className="sr-only">{t('terminalView.quickKeys.arrowUpAria')}</span>
            </Button>
            <Button
                type="button"
                size={quickKeySize}
                variant="outline"
                className={quickKeyIconClass}
                onPointerDown={preserveTerminalFocus}
                onClick={() => handleMobileKeyPress('arrow-left')}
                disabled={quickKeysDisabled}
            >
                <Icon name="arrow-left"/>
                <span className="sr-only">{t('terminalView.quickKeys.arrowLeftAria')}</span>
            </Button>
            <Button
                type="button"
                size={quickKeySize}
                variant="outline"
                className={quickKeyIconClass}
                onPointerDown={preserveTerminalFocus}
                onClick={() => handleMobileKeyPress('arrow-down')}
                disabled={quickKeysDisabled}
            >
                <Icon name="arrow-down"/>
                <span className="sr-only">{t('terminalView.quickKeys.arrowDownAria')}</span>
            </Button>
            <Button
                type="button"
                size={quickKeySize}
                variant="outline"
                className={quickKeyIconClass}
                onPointerDown={preserveTerminalFocus}
                onClick={() => handleMobileKeyPress('arrow-right')}
                disabled={quickKeysDisabled}
            >
                <Icon name="arrow-right"/>
                <span className="sr-only">{t('terminalView.quickKeys.arrowRightAria')}</span>
            </Button>
            <Button
                type="button"
                size={quickKeySize}
                variant="outline"
                className={quickKeyIconClass}
                onPointerDown={preserveTerminalFocus}
                onClick={() => handleMobileKeyPress('enter')}
                disabled={quickKeysDisabled}
            >
                <Icon name="arrow-go-back"/>
                <span className="sr-only">{t('terminalView.quickKeys.enterAria')}</span>
            </Button>
        </>
    );

    return (
        <div className="flex h-full flex-col overflow-hidden bg-[var(--surface-background)]">
            <div className={cn('app-region-no-drag sticky top-0 z-20 shrink-0 bg-[var(--surface-background)] text-xs', isTouchTerminal ? 'px-3 py-1.5' : 'pl-3 pr-1.5 py-1')}>
                {enableTabs && directoryTerminalState ? (
                    <div className="flex items-center gap-2 pl-1 pr-1">
                        <div className={cn('min-w-0 flex-1', isTouchTerminal ? 'h-8' : 'h-7')}>
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
                            className={cn('shrink-0', isTouchTerminal ? 'h-8 w-8 p-0' : 'h-7 w-7 p-0')}
                            onClick={handleCreateTab}
                            title={t('terminalView.tabs.newTabTitle')}
                        >
                            <Icon name="add" className={`${isTouchTerminal ? 'h-[18px] w-[18px]' : 'h-4 w-4'}`}/>
                        </Button>

                        <div className="flex shrink-0 items-center gap-1 overflow-visible">
                            <Button type="button" size="xs" variant="ghost" className="h-7 w-7 p-0" onClick={() => void handleRestart()} disabled={isRestarting} title={t('terminalView.actions.restart')} aria-label={t('terminalView.actions.restart')}>
                                <Icon name="restart" className="h-4 w-4" />
                            </Button>
                            <Button
                                type="button"
                                size="xs"
                                variant="ghost"
                                className="h-7 w-7 p-0"
                                onClick={handleAttachSelection}
                                title={t('terminalView.actions.attachSelection')}
                                aria-label={t('terminalView.actions.attachSelection')}
                            >
                                <Icon name="attachment-2" className="h-4 w-4" />
                            </Button>
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
                                    <Icon name="global" className="h-3.5 w-3.5 shrink-0" />
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
                                        {isBottomTerminalExpanded ? <Icon name="fullscreen-exit" className="h-4 w-4" /> : <Icon name="fullscreen" className="h-4 w-4" />}
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
                                        <Icon name="close" className="h-4 w-4" />
                                    </Button>
                                </>
                            ) : null}
                        </div>
                    </div>
                ) : null}

                {!isTouchTerminal && showQuickKeys && enableTabs && directoryTerminalState ? (
                    <div className="mt-2 flex flex-wrap items-center gap-1 pl-1 pr-1">
                        {quickKeysControls}
                    </div>
                ) : null}

                {!isTouchTerminal && showQuickKeys && (!enableTabs || !directoryTerminalState) ? (
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
                            key={terminalViewportKey}
                            ref={(controller) => {
                                terminalControllerRef.current = controller;
                            }}
                            sessionKey={terminalViewportKey}
                            chunks={bufferChunks}
                            onInput={handleViewportInput}
                            onResize={handleViewportResize}
                            theme={xtermTheme}
                            fontFamily={resolvedFontStack}
                            fontSize={terminalFontSize}
                            enableTouchScroll={useTouchTerminalInput}
                            autoFocus={!useTouchTerminalInput && isTerminalVisible}
                            isVisible={isTerminalVisible}
                        />
                    ) : null}
                </div>
                {!isReconnectPending && connectionError && (
                    <div className="absolute inset-x-0 bottom-0 bg-[var(--status-error-background)] px-3 py-2 text-xs text-[var(--status-error-foreground)] flex items-center justify-between gap-2">
                        <span>{connectionError}</span>
                        {isFatalError && isTouchTerminal && (
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
            {isTouchTerminal && showQuickKeys ? (
                <div className="shrink-0 overflow-x-auto border-t border-border/40 bg-[var(--surface-background)] px-2 pt-1.5 pb-[max(0.375rem,calc(var(--oc-app-bottom-safe,0px)-var(--oc-keyboard-inset,0px)))] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                    <div className="flex min-w-max items-center gap-1.5">
                        {quickKeysControls}
                    </div>
                </div>
            ) : null}
        </div>
    );
};
