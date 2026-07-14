import React from 'react';
import { runtimeFetch } from '@/lib/runtime-fetch';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import type { ThemeMode } from '@/types/theme';
import { useUIStore, type ChatMessageWidthMode } from '@/stores/useUIStore';
import { useMessageQueueStore, type FollowUpBehavior } from '@/stores/messageQueueStore';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { NumberInput } from '@/components/ui/number-input';
import { Radio } from '@/components/ui/radio';
import { Input } from '@/components/ui/input';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { Icon } from "@/components/icon/Icon";
import { invokeDesktop, isDesktopShell, isVSCodeRuntime, isWebRuntime } from '@/lib/desktop';
import { useDeviceInfo } from '@/lib/device';
import { usePwaDetection } from '@/hooks/usePwaDetection';
import { updateDesktopSettings } from '@/lib/persistence';
import { CODE_FONT_OPTIONS, DEFAULT_MONO_FONT, DEFAULT_UI_FONT, UI_FONT_OPTIONS, type MonoFontOption, type UiFontOption } from '@/lib/fontOptions';
import { useI18n, type Locale } from '@/lib/i18n';
import { useConfigStore } from '@/stores/useConfigStore';
import { normalizeMobileKeyboardMode, supportsMobileKeyboardResizeContent, type MobileKeyboardMode } from '@/lib/mobileKeyboardMode';
import { getStoredMobileLayoutPreference, setStoredMobileLayoutPreference, type MobileLayoutPreference } from '@/lib/mobileLayoutPreference';
import {
    setDirectoryShowHidden,
    useDirectoryShowHidden,
} from '@/lib/directoryShowHidden';

interface Option<T extends string> {
    id: T;
    labelKey: string;
    descriptionKey?: string;
}

const THEME_MODE_OPTIONS: Array<{ value: ThemeMode; labelKey: string }> = [
    {
        value: 'system',
        labelKey: 'settings.openchamber.visual.option.themeMode.system',
    },
    {
        value: 'light',
        labelKey: 'settings.openchamber.visual.option.themeMode.light',
    },
    {
        value: 'dark',
        labelKey: 'settings.openchamber.visual.option.themeMode.dark',
    },
];

const DIFF_LAYOUT_OPTIONS: Option<'dynamic' | 'inline' | 'side-by-side'>[] = [
    {
        id: 'dynamic',
        labelKey: 'settings.openchamber.visual.option.diffLayout.dynamic.label',
        descriptionKey: 'settings.openchamber.visual.option.diffLayout.dynamic.description',
    },
    {
        id: 'inline',
        labelKey: 'settings.openchamber.visual.option.diffLayout.inline.label',
        descriptionKey: 'settings.openchamber.visual.option.diffLayout.inline.description',
    },
    {
        id: 'side-by-side',
        labelKey: 'settings.openchamber.visual.option.diffLayout.sideBySide.label',
        descriptionKey: 'settings.openchamber.visual.option.diffLayout.sideBySide.description',
    },
];

const MERMAID_RENDERING_OPTIONS: Option<'svg' | 'ascii'>[] = [
    {
        id: 'svg',
        labelKey: 'settings.openchamber.visual.option.mermaidRendering.svg.label',
        descriptionKey: 'settings.openchamber.visual.option.mermaidRendering.svg.description',
    },
    {
        id: 'ascii',
        labelKey: 'settings.openchamber.visual.option.mermaidRendering.ascii.label',
        descriptionKey: 'settings.openchamber.visual.option.mermaidRendering.ascii.description',
    },
];

const DEFAULT_PWA_INSTALL_NAME = 'OpenChamber - AI Coding Assistant';
const PWA_ORIENTATION_OPTIONS: Option<'system' | 'portrait' | 'landscape'>[] = [
    {
        id: 'system',
        labelKey: 'settings.openchamber.visual.option.pwaOrientation.system.label',
        descriptionKey: 'settings.openchamber.visual.option.pwaOrientation.system.description',
    },
    {
        id: 'portrait',
        labelKey: 'settings.openchamber.visual.option.pwaOrientation.portrait.label',
        descriptionKey: 'settings.openchamber.visual.option.pwaOrientation.portrait.description',
    },
    {
        id: 'landscape',
        labelKey: 'settings.openchamber.visual.option.pwaOrientation.landscape.label',
        descriptionKey: 'settings.openchamber.visual.option.pwaOrientation.landscape.description',
    },
];

const MOBILE_KEYBOARD_MODE_OPTIONS: Option<MobileKeyboardMode>[] = [
    {
        id: 'native',
        labelKey: 'settings.openchamber.visual.option.mobileKeyboardMode.native.label',
        descriptionKey: 'settings.openchamber.visual.option.mobileKeyboardMode.native.description',
    },
    {
        id: 'resize-content',
        labelKey: 'settings.openchamber.visual.option.mobileKeyboardMode.resizeContent.label',
        descriptionKey: 'settings.openchamber.visual.option.mobileKeyboardMode.resizeContent.description',
    },
];

const MOBILE_LAYOUT_OPTIONS: Array<{ value: MobileLayoutPreference; labelKey: string }> = [
    {
        value: 'default',
        labelKey: 'settings.openchamber.visual.option.mobileLayout.default',
    },
    {
        value: 'new',
        labelKey: 'settings.openchamber.visual.option.mobileLayout.new',
    },
];

type PwaInstallNameWindow = Window & {
    __OPENCHAMBER_SET_PWA_INSTALL_NAME__?: (value: string) => string;
    __OPENCHAMBER_SET_PWA_ORIENTATION__?: (value: 'system' | 'portrait' | 'landscape') => 'system' | 'portrait' | 'landscape';
    __OPENCHAMBER_UPDATE_PWA_MANIFEST__?: () => void;
};

const normalizePwaOrientation = (value: unknown): 'system' | 'portrait' | 'landscape' => {
    return value === 'portrait' || value === 'landscape' ? value : 'system';
};

const USER_MESSAGE_RENDERING_OPTIONS: Option<'markdown' | 'plain'>[] = [
    {
        id: 'markdown',
        labelKey: 'settings.openchamber.visual.option.userMessageRendering.markdown.label',
        descriptionKey: 'settings.openchamber.visual.option.userMessageRendering.markdown.description',
    },
    {
        id: 'plain',
        labelKey: 'settings.openchamber.visual.option.userMessageRendering.plain.label',
        descriptionKey: 'settings.openchamber.visual.option.userMessageRendering.plain.description',
    },
];

const CHAT_MESSAGE_WIDTH_OPTIONS: Option<ChatMessageWidthMode>[] = [
    {
        id: 'narrow',
        labelKey: 'settings.openchamber.visual.option.chatMessageWidth.narrow.label',
    },
    {
        id: 'wide',
        labelKey: 'settings.openchamber.visual.option.chatMessageWidth.wide.label',
    },
    {
        id: 'fluid',
        labelKey: 'settings.openchamber.visual.option.chatMessageWidth.fluid.label',
    },
];

const CHAT_RENDER_MODE_OPTIONS: Option<'sorted' | 'live'>[] = [
    {
        id: 'sorted',
        labelKey: 'settings.openchamber.visual.option.chatRenderMode.sorted.label',
        descriptionKey: 'settings.openchamber.visual.option.chatRenderMode.sorted.description',
    },
    {
        id: 'live',
        labelKey: 'settings.openchamber.visual.option.chatRenderMode.live.label',
        descriptionKey: 'settings.openchamber.visual.option.chatRenderMode.live.description',
    },
];

const MESSAGE_STREAM_TRANSPORT_OPTIONS: Option<'auto' | 'ws' | 'sse'>[] = [
    {
        id: 'auto',
        labelKey: 'settings.openchamber.visual.option.messageTransport.auto.label',
        descriptionKey: 'settings.openchamber.visual.option.messageTransport.auto.description',
    },
    {
        id: 'ws',
        labelKey: 'settings.openchamber.visual.option.messageTransport.ws.label',
        descriptionKey: 'settings.openchamber.visual.option.messageTransport.ws.description',
    },
    {
        id: 'sse',
        labelKey: 'settings.openchamber.visual.option.messageTransport.sse.label',
        descriptionKey: 'settings.openchamber.visual.option.messageTransport.sse.description',
    },
];

const ACTIVITY_RENDER_MODE_OPTIONS: Option<'collapsed' | 'summary'>[] = [
    {
        id: 'collapsed',
        labelKey: 'settings.openchamber.visual.option.activityRenderMode.collapsed.label',
        descriptionKey: 'settings.openchamber.visual.option.activityRenderMode.collapsed.description',
    },
    {
        id: 'summary',
        labelKey: 'settings.openchamber.visual.option.activityRenderMode.summary.label',
        descriptionKey: 'settings.openchamber.visual.option.activityRenderMode.summary.description',
    },
];

const TIME_FORMAT_OPTIONS: Option<'auto' | '12h' | '24h'>[] = [
    {
        id: 'auto',
        labelKey: 'settings.openchamber.visual.option.timeFormat.auto.label',
        descriptionKey: 'settings.openchamber.visual.option.timeFormat.auto.description',
    },
    {
        id: '24h',
        labelKey: 'settings.openchamber.visual.option.timeFormat.24h.label',
        descriptionKey: 'settings.openchamber.visual.option.timeFormat.24h.description',
    },
    {
        id: '12h',
        labelKey: 'settings.openchamber.visual.option.timeFormat.12h.label',
        descriptionKey: 'settings.openchamber.visual.option.timeFormat.12h.description',
    },
];

const WEEK_START_OPTIONS: Option<'auto' | 'monday' | 'sunday'>[] = [
    {
        id: 'auto',
        labelKey: 'settings.openchamber.visual.option.weekStart.auto.label',
        descriptionKey: 'settings.openchamber.visual.option.weekStart.auto.description',
    },
    {
        id: 'monday',
        labelKey: 'settings.openchamber.visual.option.weekStart.monday.label',
    },
    {
        id: 'sunday',
        labelKey: 'settings.openchamber.visual.option.weekStart.sunday.label',
    },
];

const FOLLOW_UP_BEHAVIOR_OPTIONS: Option<FollowUpBehavior>[] = [
    {
        id: 'steer',
        labelKey: 'settings.openchamber.visual.option.followUpBehavior.steer.label',
    },
    {
        id: 'queue',
        labelKey: 'settings.openchamber.visual.option.followUpBehavior.queue.label',
    },
];

const normalizeUserMessageRenderingMode = (mode: unknown): 'markdown' | 'plain' => {
    return mode === 'markdown' ? 'markdown' : 'plain';
};

type VisibleSetting = 'sessionAssist' | 'sessionGoal' | 'theme' | 'pwaInstallName' | 'pwaOrientation' | 'mobileKeyboardMode' | 'timeFormat' | 'weekStart' | 'fontSize' | 'terminalFontSize' | 'editorFontSize' | 'spacing' | 'inputBarOffset' | 'mermaidRendering' | 'userMessageRendering' | 'chatRenderMode' | 'messageTransport' | 'activityRenderMode' | 'collapsibleUserMessages' | 'stickyUserHeader' | 'promptNavigatorEnabled' | 'chatMessageWidth' | 'codeBlockLineWrap' | 'splitAssistantMessageActions' | 'subagentReadOnlyBanner' | 'diffLayout' | 'mobileStatusBar' | 'dotfiles' | 'fileViewerPreview' | 'reasoning' | 'showToolFileIcons' | 'showTurnChangedFiles' | 'expandedTools' | 'followUpBehavior' | 'terminalQuickKeys' | 'fileEditorKeymap' | 'persistDraft' | 'inputSpellcheck' | 'reportUsage' | 'expandedEditorToolbar';

interface OpenChamberVisualSettingsProps {
    /** Which settings to show. If undefined, shows all. */
    visibleSettings?: VisibleSetting[];
}

export const OpenChamberVisualSettings: React.FC<OpenChamberVisualSettingsProps> = ({ visibleSettings }) => {
    const { locale, locales, setLocale, label, t } = useI18n();
    const tUnsafe = React.useCallback((key: string) => t(key as Parameters<typeof t>[0]), [t]);
    const { isMobile } = useDeviceInfo();
    const { browserTab } = usePwaDetection();
    const directoryShowHidden = useDirectoryShowHidden();
    const showReasoningTraces = useUIStore(state => state.showReasoningTraces);
    const sessionRecapEnabled = useUIStore(state => state.sessionRecapEnabled);
    const sessionSuggestionEnabled = useUIStore(state => state.sessionSuggestionEnabled);
    const setSessionRecapEnabled = useUIStore(state => state.setSessionRecapEnabled);
    const setSessionSuggestionEnabled = useUIStore(state => state.setSessionSuggestionEnabled);
    const sessionGoalEnabled = useUIStore(state => state.sessionGoalEnabled);
    const setSessionGoalEnabled = useUIStore(state => state.setSessionGoalEnabled);
    const sessionGoalDefaultBudgetEnabled = useUIStore(state => state.sessionGoalDefaultBudgetEnabled);
    const setSessionGoalDefaultBudgetEnabled = useUIStore(state => state.setSessionGoalDefaultBudgetEnabled);
    const sessionGoalDefaultBudget = useUIStore(state => state.sessionGoalDefaultBudget);
    const setSessionGoalDefaultBudget = useUIStore(state => state.setSessionGoalDefaultBudget);
    const setShowReasoningTraces = useUIStore(state => state.setShowReasoningTraces);
    const collapsibleThinkingBlocks = useUIStore(state => state.collapsibleThinkingBlocks);
    const setCollapsibleThinkingBlocks = useUIStore(state => state.setCollapsibleThinkingBlocks);

    const mermaidRenderingMode = useUIStore(state => state.mermaidRenderingMode);
    const setMermaidRenderingMode = useUIStore(state => state.setMermaidRenderingMode);
    const userMessageRenderingMode = useUIStore(state => state.userMessageRenderingMode);
    const setUserMessageRenderingMode = useUIStore(state => state.setUserMessageRenderingMode);
    const collapsibleUserMessages = useUIStore(state => state.collapsibleUserMessages);
    const setCollapsibleUserMessages = useUIStore(state => state.setCollapsibleUserMessages);
    const stickyUserHeader = useUIStore(state => state.stickyUserHeader);
    const promptNavigatorEnabled = useUIStore(state => state.promptNavigatorEnabled);
    const setStickyUserHeader = useUIStore(state => state.setStickyUserHeader);
    const setPromptNavigatorEnabled = useUIStore(state => state.setPromptNavigatorEnabled);
    const expandedEditorToolbar = useUIStore(state => state.expandedEditorToolbar);
    const setExpandedEditorToolbar = useUIStore(state => state.setExpandedEditorToolbar);
    const chatMessageWidthMode = useUIStore(state => state.chatMessageWidthMode);
    const setChatMessageWidthMode = useUIStore(state => state.setChatMessageWidthMode);
    const codeBlockLineWrap = useUIStore(state => state.codeBlockLineWrap);
    const setCodeBlockLineWrap = useUIStore(state => state.setCodeBlockLineWrap);
    const chatRenderMode = useUIStore(state => state.chatRenderMode);
    const setChatRenderMode = useUIStore(state => state.setChatRenderMode);
    const activityRenderMode = useUIStore(state => state.activityRenderMode);
    const setActivityRenderMode = useUIStore(state => state.setActivityRenderMode);
    const fontSize = useUIStore(state => state.fontSize);
    const setFontSize = useUIStore(state => state.setFontSize);
    const terminalFontSize = useUIStore(state => state.terminalFontSize);
    const setTerminalFontSize = useUIStore(state => state.setTerminalFontSize);
    const editorFontSize = useUIStore(state => state.editorFontSize);
    const setEditorFontSize = useUIStore(state => state.setEditorFontSize);
    const uiFont = useUIStore(state => state.uiFont);
    const setUiFont = useUIStore(state => state.setUiFont);
    const monoFont = useUIStore(state => state.monoFont);
    const setMonoFont = useUIStore(state => state.setMonoFont);
    const padding = useUIStore(state => state.padding);
    const setPadding = useUIStore(state => state.setPadding);
    const inputBarOffset = useUIStore(state => state.inputBarOffset);
    const setInputBarOffset = useUIStore(state => state.setInputBarOffset);
    const mobileKeyboardMode = useUIStore(state => state.mobileKeyboardMode);
    const setMobileKeyboardMode = useUIStore(state => state.setMobileKeyboardMode);
    const diffLayoutPreference = useUIStore(state => state.diffLayoutPreference);
    const setDiffLayoutPreference = useUIStore(state => state.setDiffLayoutPreference);
    const showTerminalQuickKeysOnDesktop = useUIStore(state => state.showTerminalQuickKeysOnDesktop);
    const setShowTerminalQuickKeysOnDesktop = useUIStore(state => state.setShowTerminalQuickKeysOnDesktop);
    const fileEditorKeymap = useUIStore(state => state.fileEditorKeymap);
    const setFileEditorKeymap = useUIStore(state => state.setFileEditorKeymap);
    const followUpBehavior = useMessageQueueStore(state => state.followUpBehavior);
    const setFollowUpBehavior = useMessageQueueStore(state => state.setFollowUpBehavior);
    const persistChatDraft = useUIStore(state => state.persistChatDraft);
    const setPersistChatDraft = useUIStore(state => state.setPersistChatDraft);
    const inputSpellcheckEnabled = useUIStore(state => state.inputSpellcheckEnabled);
    const setInputSpellcheckEnabled = useUIStore(state => state.setInputSpellcheckEnabled);
    const showToolFileIcons = useUIStore(state => state.showToolFileIcons);
    const setShowToolFileIcons = useUIStore(state => state.setShowToolFileIcons);
    const showTurnChangedFiles = useUIStore(state => state.showTurnChangedFiles);
    const setShowTurnChangedFiles = useUIStore(state => state.setShowTurnChangedFiles);
    const showExpandedBashTools = useUIStore(state => state.showExpandedBashTools);
    const setShowExpandedBashTools = useUIStore(state => state.setShowExpandedBashTools);
    const showExpandedEditTools = useUIStore(state => state.showExpandedEditTools);
    const setShowExpandedEditTools = useUIStore(state => state.setShowExpandedEditTools);
    const timeFormatPreference = useUIStore(state => state.timeFormatPreference);
    const setTimeFormatPreference = useUIStore(state => state.setTimeFormatPreference);
    const weekStartPreference = useUIStore(state => state.weekStartPreference);
    const setWeekStartPreference = useUIStore(state => state.setWeekStartPreference);
    const showSplitAssistantMessageActions = useUIStore(state => state.showSplitAssistantMessageActions);
    const setShowSplitAssistantMessageActions = useUIStore(state => state.setShowSplitAssistantMessageActions);
    const allowPromptingSubagentSessions = useUIStore(state => state.allowPromptingSubagentSessions);
    const setAllowPromptingSubagentSessions = useUIStore(state => state.setAllowPromptingSubagentSessions);
    const messageStreamTransport = useConfigStore((state) => state.settingsMessageStreamTransport);
    const setMessageStreamTransport = useConfigStore((state) => state.setSettingsMessageStreamTransport);
    const effectiveMessageStreamTransport = messageStreamTransport;
    const settingsDefaultFileViewerPreview = useConfigStore((state) => state.settingsDefaultFileViewerPreview);
    const setSettingsDefaultFileViewerPreview = useConfigStore((state) => state.setSettingsDefaultFileViewerPreview);
    const isSettingsDialogOpen = useUIStore(state => state.isSettingsDialogOpen);
    const {
        themeMode,
        setThemeMode,
        availableThemes,
        customThemesLoading,
        reloadCustomThemes,
        lightThemeId,
        darkThemeId,
        setLightThemePreference,
        setDarkThemePreference,
    } = useThemeSystem();

    const [themesReloading, setThemesReloading] = React.useState(false);

    // macOS-desktop-only vibrancy toggle. Changing it needs a full relaunch
    // (vibrancy is a window-creation option), so we persist + restart on save.
    const macVibrancySupported = React.useMemo(
        () => isDesktopShell() && typeof window !== 'undefined' && window.__OPENCHAMBER_ELECTRON__?.macVibrancySupported === true,
        [],
    );
    const macVibrancyEnabled = typeof window !== 'undefined' && window.__OPENCHAMBER_ELECTRON__?.macVibrancy === true;
    const [vibrancyChecked, setVibrancyChecked] = React.useState(macVibrancyEnabled);
    const [vibrancyRestarting, setVibrancyRestarting] = React.useState(false);

    // macOS-desktop-only dock badge that counts chats with unseen activity.
    // The tray sync (mac-only) pumps the count to the main process, so the
    // toggle is offered only where it actually has an effect. No relaunch needed.
    const dockBadgeSupported = React.useMemo(
        () => isDesktopShell() && typeof window !== 'undefined'
            && (window as unknown as { __OPENCHAMBER_PLATFORM__?: string }).__OPENCHAMBER_PLATFORM__ === 'darwin',
        [],
    );
    const dockBadgeEnabled = useUIStore(state => state.dockBadgeEnabled);
    const setDockBadgeEnabled = useUIStore(state => state.setDockBadgeEnabled);
    const [chatRenderPreviewTick, setChatRenderPreviewTick] = React.useState(0);
    const reportUsage = useUIStore(state => state.reportUsage);
    const setReportUsage = useUIStore(state => state.setReportUsage);

    // Sync reportUsage changes to server settings
    const handleReportUsageChange = React.useCallback((enabled: boolean) => {
        setReportUsage(enabled);
        void updateDesktopSettings({ reportUsage: enabled });
    }, [setReportUsage]);

    const shouldAnimateChatPreview = isSettingsDialogOpen
        && (visibleSettings ? visibleSettings.includes('chatRenderMode') : true);

    React.useEffect(() => {
        if (!shouldAnimateChatPreview) {
            return;
        }

        // Use requestAnimationFrame for smoother animation without setInterval overhead
        let rafId: number | null = null;
        let lastTime = Date.now();
        
        const tick = () => {
            const now = Date.now();
            // Update every ~420ms
            if (now - lastTime >= 420) {
                setChatRenderPreviewTick((prev) => (prev + 1) % 24);
                lastTime = now;
            }
            rafId = requestAnimationFrame(tick);
        };
        
        // Only run when visible
        if (typeof document === 'undefined' || document.visibilityState === 'visible') {
            rafId = requestAnimationFrame(tick);
        }
        
        const onVisibility = () => {
            if (document.visibilityState === 'visible' && rafId === null) {
                rafId = requestAnimationFrame(tick);
            } else if (document.visibilityState !== 'visible' && rafId !== null) {
                cancelAnimationFrame(rafId);
                rafId = null;
            }
        };
        
        document.addEventListener('visibilitychange', onVisibility);

        return () => {
            document.removeEventListener('visibilitychange', onVisibility);
            if (rafId !== null) {
                cancelAnimationFrame(rafId);
            }
        };
    }, [shouldAnimateChatPreview]);

    const handleUserMessageRenderingModeChange = React.useCallback((mode: 'markdown' | 'plain') => {
        setUserMessageRenderingMode(mode);
        void updateDesktopSettings({ userMessageRenderingMode: mode });
    }, [setUserMessageRenderingMode]);

    const handleStickyUserHeaderChange = React.useCallback((enabled: boolean) => {
        setStickyUserHeader(enabled);
        void updateDesktopSettings({ stickyUserHeader: enabled });
    }, [setStickyUserHeader]);

    const handlePromptNavigatorEnabledChange = React.useCallback((enabled: boolean) => {
        setPromptNavigatorEnabled(enabled);
        void updateDesktopSettings({ promptNavigatorEnabled: enabled });
    }, [setPromptNavigatorEnabled]);

    const handleExpandedEditorToolbarChange = React.useCallback((enabled: boolean) => {
        setExpandedEditorToolbar(enabled);
        void updateDesktopSettings({ expandedEditorToolbar: enabled });
    }, [setExpandedEditorToolbar]);

    const handleCollapsibleUserMessagesChange = React.useCallback((enabled: boolean) => {
        setCollapsibleUserMessages(enabled);
        void updateDesktopSettings({ collapsibleUserMessages: enabled });
    }, [setCollapsibleUserMessages]);

    const handleChatMessageWidthChange = React.useCallback((mode: ChatMessageWidthMode) => {
        setChatMessageWidthMode(mode);
        void updateDesktopSettings({ chatMessageWidthMode: mode });
    }, [setChatMessageWidthMode]);

    const handleShowSplitAssistantMessageActionsChange = React.useCallback((enabled: boolean) => {
        setShowSplitAssistantMessageActions(enabled);
        void updateDesktopSettings({ showSplitAssistantMessageActions: enabled });
    }, [setShowSplitAssistantMessageActions]);

    const handleInputSpellcheckChange = React.useCallback((enabled: boolean) => {
        setInputSpellcheckEnabled(enabled);
        void updateDesktopSettings({ inputSpellcheckEnabled: enabled });
    }, [setInputSpellcheckEnabled]);

    const handleChatRenderModeChange = React.useCallback((mode: 'sorted' | 'live') => {
        setChatRenderMode(mode);
        void updateDesktopSettings({ chatRenderMode: mode });
    }, [setChatRenderMode]);

    const handleMessageStreamTransportChange = React.useCallback((mode: 'auto' | 'ws' | 'sse') => {
        setMessageStreamTransport(mode);
        void updateDesktopSettings({ messageStreamTransport: mode });
    }, [setMessageStreamTransport]);

    const handleActivityRenderModeChange = React.useCallback((mode: 'collapsed' | 'summary') => {
        setActivityRenderMode(mode);
        void updateDesktopSettings({ activityRenderMode: mode });
    }, [setActivityRenderMode]);

    const handleMermaidRenderingModeChange = React.useCallback((mode: 'svg' | 'ascii') => {
        setMermaidRenderingMode(mode);
        void updateDesktopSettings({ mermaidRenderingMode: mode });
    }, [setMermaidRenderingMode]);

    const handleShowToolFileIconsChange = React.useCallback((enabled: boolean) => {
        setShowToolFileIcons(enabled);
        void updateDesktopSettings({ showToolFileIcons: enabled });
    }, [setShowToolFileIcons]);

    const handleShowTurnChangedFilesChange = React.useCallback((enabled: boolean) => {
        setShowTurnChangedFiles(enabled);
        void updateDesktopSettings({ showTurnChangedFiles: enabled });
    }, [setShowTurnChangedFiles]);

    const handleFileViewerPreviewChange = React.useCallback((enabled: boolean) => {
        setSettingsDefaultFileViewerPreview(enabled);
        void updateDesktopSettings({ defaultFileViewerPreview: enabled });
        window.dispatchEvent(new CustomEvent('openchamber:file-viewer-preview-mode-changed', { detail: { enabled } }));
    }, [setSettingsDefaultFileViewerPreview]);

    const handleShowExpandedBashToolsChange = React.useCallback((enabled: boolean) => {
        setShowExpandedBashTools(enabled);
        void updateDesktopSettings({ showExpandedBashTools: enabled });
    }, [setShowExpandedBashTools]);

    const handleShowExpandedEditToolsChange = React.useCallback((enabled: boolean) => {
        setShowExpandedEditTools(enabled);
        void updateDesktopSettings({ showExpandedEditTools: enabled });
    }, [setShowExpandedEditTools]);

    const handleTimeFormatPreferenceChange = React.useCallback((value: 'auto' | '12h' | '24h') => {
        setTimeFormatPreference(value);
        void updateDesktopSettings({ timeFormatPreference: value });
    }, [setTimeFormatPreference]);

    const handleWeekStartPreferenceChange = React.useCallback((value: 'auto' | 'monday' | 'sunday') => {
        setWeekStartPreference(value);
        void updateDesktopSettings({ weekStartPreference: value });
    }, [setWeekStartPreference]);

    const lightThemes = React.useMemo(
        () => availableThemes
            .filter((theme) => theme.metadata.variant === 'light')
            .sort((a, b) => a.metadata.name.localeCompare(b.metadata.name)),
        [availableThemes],
    );

    const darkThemes = React.useMemo(
        () => availableThemes
            .filter((theme) => theme.metadata.variant === 'dark')
            .sort((a, b) => a.metadata.name.localeCompare(b.metadata.name)),
        [availableThemes],
    );

    const selectedLightTheme = React.useMemo(
        () => lightThemes.find((theme) => theme.metadata.id === lightThemeId) ?? lightThemes[0],
        [lightThemes, lightThemeId],
    );

    const selectedDarkTheme = React.useMemo(
        () => darkThemes.find((theme) => theme.metadata.id === darkThemeId) ?? darkThemes[0],
        [darkThemes, darkThemeId],
    );

    const formatThemeLabel = React.useCallback((themeName: string, variant: 'light' | 'dark') => {
        const suffix = variant === 'dark' ? ' Dark' : ' Light';
        return themeName.endsWith(suffix) ? themeName.slice(0, -suffix.length) : themeName;
    }, []);

    const shouldShow = (setting: VisibleSetting): boolean => {
        if (!visibleSettings) return true;
        return visibleSettings.includes(setting);
    };

    const isVSCode = isVSCodeRuntime();
    const hasThemeSettings = shouldShow('theme') && !isVSCode;
    const hasLocalizationSettings = shouldShow('theme') || shouldShow('timeFormat') || shouldShow('weekStart');
    const showMobileLayoutSetting = isMobile && isWebRuntime() && !isDesktopShell() && !isVSCode;
    const hasAppearanceSettings = isVSCode
        ? hasLocalizationSettings
        : (shouldShow('theme') || showMobileLayoutSetting || shouldShow('pwaInstallName') || shouldShow('pwaOrientation') || shouldShow('timeFormat') || shouldShow('weekStart'));
    const hasLayoutSettings = shouldShow('fontSize') || shouldShow('terminalFontSize') || shouldShow('editorFontSize') || shouldShow('spacing') || shouldShow('inputBarOffset');
    const hasNavigationSettings = (shouldShow('terminalQuickKeys') && !isMobile) || shouldShow('fileEditorKeymap') || shouldShow('expandedEditorToolbar');
    const hasBehaviorSettings = shouldShow('mermaidRendering')
        || shouldShow('userMessageRendering')
        || shouldShow('chatRenderMode')
        || shouldShow('messageTransport')
        || (shouldShow('activityRenderMode') && chatRenderMode === 'sorted')
        || shouldShow('collapsibleUserMessages')
        || shouldShow('stickyUserHeader')
        || shouldShow('chatMessageWidth')
        || (shouldShow('promptNavigatorEnabled') && !isVSCode)
        || shouldShow('codeBlockLineWrap')
        || shouldShow('splitAssistantMessageActions')
        || shouldShow('subagentReadOnlyBanner')
        || shouldShow('diffLayout')
        || shouldShow('dotfiles')
        || shouldShow('fileViewerPreview')
        || shouldShow('reasoning')
        || shouldShow('followUpBehavior')
        || shouldShow('persistDraft')
        || shouldShow('showToolFileIcons')
        || shouldShow('expandedTools')
        || (!isMobile && shouldShow('inputSpellcheck'));

    const showPwaInstallNameSetting = shouldShow('pwaInstallName') && isWebRuntime() && browserTab && !isDesktopShell() && !isVSCode;
    const showPwaOrientationSetting = shouldShow('pwaOrientation') && isWebRuntime() && !isDesktopShell() && !isVSCode;
    const showMobileKeyboardModeSetting = shouldShow('mobileKeyboardMode') && isWebRuntime() && !isDesktopShell() && !isVSCode && supportsMobileKeyboardResizeContent();
    const [mobileLayoutPreference, setMobileLayoutPreference] = React.useState<MobileLayoutPreference>(() => getStoredMobileLayoutPreference());
    const [pwaInstallName, setPwaInstallName] = React.useState('');
    const [pwaOrientation, setPwaOrientation] = React.useState<'system' | 'portrait' | 'landscape'>('system');
    const selectedTimeFormatLabel = React.useMemo(() => {
        const option = TIME_FORMAT_OPTIONS.find((item) => item.id === timeFormatPreference);
        return tUnsafe(option?.labelKey ?? 'settings.openchamber.visual.option.timeFormat.auto.label');
    }, [timeFormatPreference, tUnsafe]);
    const selectedWeekStartLabel = React.useMemo(() => {
        const option = WEEK_START_OPTIONS.find((item) => item.id === weekStartPreference);
        return tUnsafe(option?.labelKey ?? 'settings.openchamber.visual.option.weekStart.auto.label');
    }, [weekStartPreference, tUnsafe]);
    const selectedPwaOrientationLabel = React.useMemo(() => {
        const option = PWA_ORIENTATION_OPTIONS.find((item) => item.id === pwaOrientation);
        return option ? tUnsafe(option.labelKey) : undefined;
    }, [pwaOrientation, tUnsafe]);
    const selectedMobileKeyboardModeLabel = React.useMemo(() => {
        const option = MOBILE_KEYBOARD_MODE_OPTIONS.find((item) => item.id === mobileKeyboardMode);
        return option ? tUnsafe(option.labelKey) : undefined;
    }, [mobileKeyboardMode, tUnsafe]);

    const handleMobileLayoutPreferenceChange = React.useCallback((value: MobileLayoutPreference) => {
        if (value === mobileLayoutPreference) {
            return;
        }

        setMobileLayoutPreference(value);
        setStoredMobileLayoutPreference(value);
        window.location.reload();
    }, [mobileLayoutPreference]);

    const applyPwaInstallName = React.useCallback(async (value: string) => {
        if (typeof window === 'undefined') {
            return;
        }

        const win = window as PwaInstallNameWindow;
        const normalized = value.trim().replace(/\s+/g, ' ').slice(0, 64);
        const persistedValue = normalized;

        await updateDesktopSettings({ pwaAppName: persistedValue });

        if (typeof win.__OPENCHAMBER_SET_PWA_INSTALL_NAME__ === 'function') {
            const resolved = win.__OPENCHAMBER_SET_PWA_INSTALL_NAME__(persistedValue);
            setPwaInstallName(resolved);
            return;
        }

        setPwaInstallName(persistedValue || DEFAULT_PWA_INSTALL_NAME);
        win.__OPENCHAMBER_UPDATE_PWA_MANIFEST__?.();
    }, []);

    const applyPwaOrientation = React.useCallback(async (value: 'system' | 'portrait' | 'landscape') => {
        if (typeof window === 'undefined') {
            return;
        }

        const win = window as PwaInstallNameWindow;
        const normalized = normalizePwaOrientation(value);

        await updateDesktopSettings({ pwaOrientation: normalized });

        if (typeof win.__OPENCHAMBER_SET_PWA_ORIENTATION__ === 'function') {
            const resolved = win.__OPENCHAMBER_SET_PWA_ORIENTATION__(normalized);
            setPwaOrientation(resolved);
            return;
        }

        setPwaOrientation(normalized);
        win.__OPENCHAMBER_UPDATE_PWA_MANIFEST__?.();
    }, []);

    React.useEffect(() => {
        if (typeof window === 'undefined' || (!showPwaInstallNameSetting && !showPwaOrientationSetting && !showMobileKeyboardModeSetting)) {
            return;
        }

        let cancelled = false;

        const loadPwaInstallName = async () => {
            try {
                const response = await runtimeFetch('/api/config/settings', {
                    method: 'GET',
                    headers: { Accept: 'application/json' },
                    cache: 'no-store',
                });

                if (!response.ok) {
                    if (!cancelled) {
                        setPwaInstallName(DEFAULT_PWA_INSTALL_NAME);
                    }
                    return;
                }

                const settings = await response.json().catch(() => ({}));
                const raw = typeof settings?.pwaAppName === 'string' ? settings.pwaAppName : '';
                const normalized = raw.trim().replace(/\s+/g, ' ').slice(0, 64);
                const orientation = normalizePwaOrientation(settings?.pwaOrientation);
                const nextMobileKeyboardMode = normalizeMobileKeyboardMode(settings?.mobileKeyboardMode);

                if (!cancelled) {
                    if (showPwaInstallNameSetting) {
                        setPwaInstallName(normalized || DEFAULT_PWA_INSTALL_NAME);
                    }
                    if (showPwaOrientationSetting) {
                        setPwaOrientation(orientation);
                    }
                    if (showMobileKeyboardModeSetting) {
                        setMobileKeyboardMode(nextMobileKeyboardMode);
                    }
                }
            } catch {
                if (!cancelled) {
                    if (showPwaInstallNameSetting) {
                        setPwaInstallName(DEFAULT_PWA_INSTALL_NAME);
                    }
                    if (showPwaOrientationSetting) {
                        setPwaOrientation('system');
                    }
                    if (showMobileKeyboardModeSetting) {
                        setMobileKeyboardMode('native');
                    }
                }
            }
        };

        void loadPwaInstallName();

        return () => {
            cancelled = true;
        };
    }, [setMobileKeyboardMode, showMobileKeyboardModeSetting, showPwaInstallNameSetting, showPwaOrientationSetting]);

    return (
        <div className="space-y-8">

                {/* --- Appearance & Themes --- */}
                {hasAppearanceSettings && (
                    <div className="mb-8 space-y-6">
                        {hasThemeSettings && (
                            <section className="px-2 pb-2 pt-0 space-y-2">
                                <div className="flex min-w-0 flex-col gap-1.5">
                                    <span className="typography-ui-header font-medium text-foreground">{t('settings.openchamber.visual.section.colorMode')}</span>
                                    <div className="flex flex-wrap items-center gap-1">
                                        {THEME_MODE_OPTIONS.map((option) => (
                                            <Button
                                                key={option.value}
                                                variant="chip"
                                                size="xs"
                                                aria-pressed={themeMode === option.value}
                                                className="!font-normal"
                                                onClick={() => setThemeMode(option.value)}
                                            >
                                                {tUnsafe(option.labelKey)}
                                            </Button>
                                        ))}
                                    </div>
                                </div>

                                {showMobileLayoutSetting && (
                                    <div className="flex min-w-0 flex-col gap-1.5 py-1.5">
                                        <span className="typography-ui-header font-medium text-foreground">{t('settings.openchamber.visual.section.mobileLayout')}</span>
                                        <div className="flex flex-wrap items-center gap-1">
                                            {MOBILE_LAYOUT_OPTIONS.map((option) => (
                                                <Button
                                                    key={option.value}
                                                    variant="chip"
                                                    size="xs"
                                                    aria-pressed={mobileLayoutPreference === option.value}
                                                    className="!font-normal"
                                                    onClick={() => handleMobileLayoutPreferenceChange(option.value)}
                                                >
                                                    {tUnsafe(option.labelKey)}
                                                </Button>
                                            ))}
                                        </div>
                                    </div>
                                )}

                                <div className="grid grid-cols-1 gap-2 py-1.5 md:grid-cols-[14rem_auto] md:gap-x-8 md:gap-y-2">
                                    <div data-settings-item="appearance.light-theme" className="flex min-w-0 items-center gap-2">
                                        <span className="typography-ui-label text-foreground shrink-0">{t('settings.openchamber.visual.field.lightTheme')}</span>
                                        <Select value={selectedLightTheme?.metadata.id ?? ''} onValueChange={setLightThemePreference}>
                                            <SelectTrigger aria-label={t('settings.openchamber.visual.field.selectLightThemeAria')} className="w-fit">
                                                <SelectValue placeholder={t('settings.openchamber.visual.field.selectThemePlaceholder')}>
                                                    {selectedLightTheme
                                                        ? formatThemeLabel(selectedLightTheme.metadata.name, 'light')
                                                        : undefined}
                                                </SelectValue>
                                            </SelectTrigger>
                                            <SelectContent>
                                                {lightThemes.map((theme) => (
                                                    <SelectItem key={theme.metadata.id} value={theme.metadata.id}>
                                                        {formatThemeLabel(theme.metadata.name, 'light')}
                                                    </SelectItem>
                                                ))}
                                            </SelectContent>
                                        </Select>
                                    </div>
                                    <div data-settings-item="appearance.dark-theme" className="flex min-w-0 items-center gap-2">
                                        <span className="typography-ui-label text-foreground shrink-0">{t('settings.openchamber.visual.field.darkTheme')}</span>
                                        <Select value={selectedDarkTheme?.metadata.id ?? ''} onValueChange={setDarkThemePreference}>
                                            <SelectTrigger aria-label={t('settings.openchamber.visual.field.selectDarkThemeAria')} className="w-fit">
                                                <SelectValue placeholder={t('settings.openchamber.visual.field.selectThemePlaceholder')}>
                                                    {selectedDarkTheme
                                                        ? formatThemeLabel(selectedDarkTheme.metadata.name, 'dark')
                                                        : undefined}
                                                </SelectValue>
                                            </SelectTrigger>
                                            <SelectContent>
                                                {darkThemes.map((theme) => (
                                                    <SelectItem key={theme.metadata.id} value={theme.metadata.id}>
                                                        {formatThemeLabel(theme.metadata.name, 'dark')}
                                                    </SelectItem>
                                                ))}
                                            </SelectContent>
                                        </Select>
                                    </div>
                                </div>

                                <div className="flex items-center gap-2 py-1.5">
                                    <button
                                        type="button"
                                        disabled={customThemesLoading || themesReloading}
                                        onClick={() => {
                                            const startedAt = Date.now();
                                            setThemesReloading(true);
                                            void reloadCustomThemes().finally(() => {
                                                const elapsed = Date.now() - startedAt;
                                                if (elapsed < 500) {
                                                    window.setTimeout(() => {
                                                        setThemesReloading(false);
                                                    }, 500 - elapsed);
                                                    return;
                                                }
                                                setThemesReloading(false);
                                            });
                                        }}
                                        className="inline-flex items-center typography-ui-label font-normal text-foreground underline decoration-[1px] underline-offset-2 hover:text-foreground/80 disabled:cursor-not-allowed disabled:text-muted-foreground/60"
                                    >
                                        {themesReloading ? t('settings.openchamber.visual.actions.reloadingThemes') : t('settings.openchamber.visual.actions.reloadThemes')}
                                    </button>
                                    <Tooltip>
                                        <TooltipTrigger asChild>
                                            <button
                                                type="button"
                                                className="flex items-center justify-center rounded-md p-1 text-muted-foreground/70 hover:text-foreground"
                                                aria-label={t('settings.openchamber.visual.field.themeImportInfoAria')}
                                            >
                                                <Icon name="information" className="h-3.5 w-3.5" />
                                            </button>
                                        </TooltipTrigger>
                                        <TooltipContent sideOffset={8}>
                                            {t('settings.openchamber.visual.field.themeImportInfoTooltip')}
                                        </TooltipContent>
                                    </Tooltip>
                                </div>

                                {macVibrancySupported && (
                                    <div data-settings-item="appearance.window-transparency" className="flex flex-col gap-1.5 border-t border-border/40 pt-3">
                                        <div
                                            className="group flex cursor-pointer items-start gap-2 py-0.5"
                                            role="button"
                                            tabIndex={0}
                                            aria-pressed={vibrancyChecked}
                                            onClick={() => { if (!vibrancyRestarting) setVibrancyChecked(!vibrancyChecked); }}
                                            onKeyDown={(event) => {
                                                if (event.key === ' ' || event.key === 'Enter') {
                                                    event.preventDefault();
                                                    if (!vibrancyRestarting) setVibrancyChecked(!vibrancyChecked);
                                                }
                                            }}
                                        >
                                            <Checkbox
                                                checked={vibrancyChecked}
                                                onChange={setVibrancyChecked}
                                                disabled={vibrancyRestarting}
                                                ariaLabel={t('settings.openchamber.visual.field.macVibrancy')}
                                            />
                                            <div className="flex min-w-0 flex-col">
                                                <span className="typography-ui-label text-foreground">
                                                    {t('settings.openchamber.visual.field.macVibrancy')}
                                                </span>
                                                <span className="typography-meta text-muted-foreground">
                                                    {t('settings.openchamber.visual.field.macVibrancyHint')}
                                                </span>
                                            </div>
                                        </div>
                                        {vibrancyChecked !== macVibrancyEnabled && (
                                            <div className="pl-6">
                                                <Button
                                                    variant="outline"
                                                    size="sm"
                                                    disabled={vibrancyRestarting}
                                                    onClick={() => {
                                                        setVibrancyRestarting(true);
                                                        void invokeDesktop('desktop_set_vibrancy', { enabled: vibrancyChecked });
                                                    }}
                                                >
                                                    {vibrancyRestarting
                                                        ? t('settings.openchamber.visual.actions.restarting')
                                                        : t('settings.openchamber.visual.actions.saveAndRestart')}
                                                </Button>
                                            </div>
                                        )}
                                    </div>
                                )}

                                {dockBadgeSupported && (
                                    <div data-settings-item="appearance.dock-badge" className="flex flex-col gap-1.5 border-t border-border/40 pt-3">
                                        <div
                                            className="group flex cursor-pointer items-start gap-2 py-0.5"
                                            role="button"
                                            tabIndex={0}
                                            aria-pressed={dockBadgeEnabled}
                                            onClick={() => setDockBadgeEnabled(!dockBadgeEnabled)}
                                            onKeyDown={(event) => {
                                                if (event.key === ' ' || event.key === 'Enter') {
                                                    event.preventDefault();
                                                    setDockBadgeEnabled(!dockBadgeEnabled);
                                                }
                                            }}
                                        >
                                            <Checkbox
                                                checked={dockBadgeEnabled}
                                                onChange={setDockBadgeEnabled}
                                                ariaLabel={t('settings.openchamber.visual.field.dockBadge')}
                                            />
                                            <div className="flex min-w-0 flex-col">
                                                <span className="typography-ui-label text-foreground">
                                                    {t('settings.openchamber.visual.field.dockBadge')}
                                                </span>
                                                <span className="typography-meta text-muted-foreground">
                                                    {t('settings.openchamber.visual.field.dockBadgeHint')}
                                                </span>
                                            </div>
                                        </div>
                                    </div>
                                )}
                            </section>
                        )}

                        {hasLocalizationSettings && (
                            <section className="px-2 pb-2 pt-0 space-y-2">
                                <h4 className="typography-ui-header font-medium text-foreground">{t('settings.openchamber.visual.section.localization')}</h4>

                                <div data-settings-item="appearance.language" className="grid grid-cols-1 gap-2 py-1.5 md:grid-cols-[14rem_auto] md:gap-x-8 md:gap-y-2">
                                    <div className="flex min-w-0 flex-col">
                                        <span className="typography-ui-label text-foreground shrink-0">{t('settings.appearance.language.label')}</span>
                                        <span className="typography-meta text-muted-foreground">{t('settings.appearance.language.description')}</span>
                                    </div>
                                    <Select value={locale} onValueChange={(value) => setLocale(value as Locale)}>
                                        <SelectTrigger aria-label={t('settings.appearance.language.select')} className="w-fit">
                                            <SelectValue>{label(locale)}</SelectValue>
                                        </SelectTrigger>
                                        <SelectContent>
                                            {locales.map((availableLocale) => (
                                                <SelectItem key={availableLocale} value={availableLocale}>
                                                    {label(availableLocale)}
                                                </SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                </div>

                                {(shouldShow('timeFormat') || shouldShow('weekStart')) && (
                                    <div className="grid grid-cols-1 gap-2 py-1.5 md:grid-cols-[14rem_auto] md:gap-x-8 md:gap-y-2">
                                        {shouldShow('timeFormat') && (
                                            <div data-settings-item="appearance.time-format" className="flex min-w-0 items-center gap-2">
                                                <span className="typography-ui-label text-foreground shrink-0">{t('settings.openchamber.visual.field.timeFormat')}</span>
                                                <Select value={timeFormatPreference} onValueChange={(value: 'auto' | '12h' | '24h') => handleTimeFormatPreferenceChange(value)}>
                                                    <SelectTrigger aria-label={t('settings.openchamber.visual.field.selectTimeFormatAria')} className="w-fit">
                                                        <SelectValue>{selectedTimeFormatLabel}</SelectValue>
                                                    </SelectTrigger>
                                                    <SelectContent>
                                                        {TIME_FORMAT_OPTIONS.map((option) => (
                                                            <SelectItem key={option.id} value={option.id}>{tUnsafe(option.labelKey)}</SelectItem>
                                                        ))}
                                                    </SelectContent>
                                                </Select>
                                            </div>
                                        )}

                                        {shouldShow('weekStart') && (
                                            <div data-settings-item="appearance.week-start" className="flex min-w-0 items-center gap-2">
                                                <span className="typography-ui-label text-foreground shrink-0">{t('settings.openchamber.visual.field.weekStartsOn')}</span>
                                                <Select value={weekStartPreference} onValueChange={(value: 'auto' | 'monday' | 'sunday') => handleWeekStartPreferenceChange(value)}>
                                                    <SelectTrigger aria-label={t('settings.openchamber.visual.field.selectWeekStartAria')} className="w-fit">
                                                        <SelectValue>{selectedWeekStartLabel}</SelectValue>
                                                    </SelectTrigger>
                                                    <SelectContent>
                                                        {WEEK_START_OPTIONS.map((option) => (
                                                            <SelectItem key={option.id} value={option.id}>{tUnsafe(option.labelKey)}</SelectItem>
                                                        ))}
                                                    </SelectContent>
                                                </Select>
                                            </div>
                                        )}
                                    </div>
                                )}
                            </section>
                        )}

                        {(showPwaInstallNameSetting || showPwaOrientationSetting || showMobileKeyboardModeSetting) && (
                            <section className="px-2 pb-2 pt-0 space-y-2">

                            {showPwaInstallNameSetting && (
                                <div data-settings-item="appearance.pwa-install-name" className="py-1.5 space-y-1.5">
                                    <div className="flex min-w-0 flex-col">
                                        <span className="typography-ui-label text-foreground">{t('settings.openchamber.visual.field.installAppName')}</span>
                                        <span className="typography-meta text-muted-foreground">{t('settings.openchamber.visual.field.installAppNameHint')}</span>
                                    </div>
                                    <div className="flex w-full max-w-[28rem] items-center gap-2">
                                        <Input
                                            value={pwaInstallName}
                                            onChange={(event) => {
                                                setPwaInstallName(event.target.value);
                                            }}
                                            onBlur={() => {
                                                void applyPwaInstallName(pwaInstallName);
                                            }}
                                            onKeyDown={(event) => {
                                                if (event.key === 'Enter') {
                                                    event.preventDefault();
                                                    void applyPwaInstallName(pwaInstallName);
                                                }
                                            }}
                                            className="h-7"
                                            maxLength={64}
                                            aria-label={t('settings.openchamber.visual.field.pwaInstallAppNameAria')}
                                        />
                                        <Button size="sm"
                                            type="button"
                                            variant="ghost"
                                            onClick={() => {
                                                setPwaInstallName(DEFAULT_PWA_INSTALL_NAME);
                                                void applyPwaInstallName('');
                                            }}
                                            className="h-7 w-7 px-0 text-muted-foreground hover:text-foreground"
                                            aria-label={t('settings.openchamber.visual.actions.resetInstallAppNameAria')}
                                            title={t('settings.common.actions.reset')}
                                        >
                                            <Icon name="restart" className="h-3.5 w-3.5" />
                                        </Button>
                                    </div>
                                </div>
                            )}

                            {showPwaOrientationSetting && (
                                <div data-settings-item="appearance.pwa-orientation" className="py-1.5 space-y-1.5">
                                    <div className="flex min-w-0 flex-col">
                                        <span className="typography-ui-label text-foreground">{t('settings.openchamber.visual.field.installOrientation')}</span>
                                        <span className="typography-meta text-muted-foreground">{t('settings.openchamber.visual.field.installOrientationHint')}</span>
                                    </div>
                                    <div className="flex w-full max-w-[18rem] items-center gap-2">
                                        <Select
                                            value={pwaOrientation}
                                            onValueChange={(value) => {
                                                const orientation = normalizePwaOrientation(value);
                                                setPwaOrientation(orientation);
                                                void applyPwaOrientation(orientation);
                                            }}
                                        >
                                            <SelectTrigger aria-label={t('settings.openchamber.visual.field.pwaInstallOrientationAria')} className="w-full">
                                                <SelectValue placeholder={t('settings.openchamber.visual.field.selectOrientationPlaceholder')}>
                                                    {selectedPwaOrientationLabel}
                                                </SelectValue>
                                            </SelectTrigger>
                                            <SelectContent>
                                                {PWA_ORIENTATION_OPTIONS.map((option) => (
                                                    <SelectItem key={option.id} value={option.id}>
                                                        {tUnsafe(option.labelKey)}
                                                    </SelectItem>
                                                ))}
                                            </SelectContent>
                                        </Select>
                                        <Button size="sm"
                                            type="button"
                                            variant="ghost"
                                            onClick={() => {
                                                setPwaOrientation('system');
                                                void applyPwaOrientation('system');
                                            }}
                                            disabled={pwaOrientation === 'system'}
                                            className="h-7 w-7 px-0 text-muted-foreground hover:text-foreground"
                                            aria-label={t('settings.openchamber.visual.actions.resetInstallOrientationAria')}
                                            title={t('settings.common.actions.reset')}
                                        >
                                            <Icon name="restart" className="h-3.5 w-3.5" />
                                        </Button>
                                    </div>
                                </div>
                            )}

                            {showMobileKeyboardModeSetting && (
                                <div data-settings-item="appearance.mobile-keyboard-mode" className="py-1.5 space-y-1.5">
                                    <div className="flex min-w-0 flex-col">
                                        <span className="typography-ui-label text-foreground">{t('settings.openchamber.visual.field.mobileKeyboardMode')}</span>
                                        <span className="typography-meta text-muted-foreground">{t('settings.openchamber.visual.field.mobileKeyboardModeHint')}</span>
                                    </div>
                                    <div className="flex w-full max-w-[18rem] items-center gap-2">
                                        <Select
                                            value={mobileKeyboardMode}
                                            onValueChange={(value) => {
                                                const mode = normalizeMobileKeyboardMode(value);
                                                setMobileKeyboardMode(mode);
                                                void updateDesktopSettings({ mobileKeyboardMode: mode });
                                            }}
                                        >
                                            <SelectTrigger aria-label={t('settings.openchamber.visual.field.mobileKeyboardModeAria')} className="w-full">
                                                <SelectValue placeholder={t('settings.openchamber.visual.field.selectMobileKeyboardModePlaceholder')}>
                                                    {selectedMobileKeyboardModeLabel}
                                                </SelectValue>
                                            </SelectTrigger>
                                            <SelectContent>
                                                {MOBILE_KEYBOARD_MODE_OPTIONS.map((option) => (
                                                    <SelectItem key={option.id} value={option.id}>
                                                        {tUnsafe(option.labelKey)}
                                                    </SelectItem>
                                                ))}
                                            </SelectContent>
                                        </Select>
                                        <Button size="sm"
                                            type="button"
                                            variant="ghost"
                                            onClick={() => {
                                                setMobileKeyboardMode('native');
                                                void updateDesktopSettings({ mobileKeyboardMode: 'native' });
                                            }}
                                            disabled={mobileKeyboardMode === 'native'}
                                            className="h-7 w-7 px-0 text-muted-foreground hover:text-foreground"
                                            aria-label={t('settings.openchamber.visual.actions.resetMobileKeyboardModeAria')}
                                            title={t('settings.common.actions.reset')}
                                        >
                                            <Icon name="restart" className="h-3.5 w-3.5" />
                                        </Button>
                                    </div>
                                </div>
                            )}
                            </section>
                        )}
                    </div>
                )}

                {/* --- UI Scaling & Layout --- */}
                {hasLayoutSettings && (
                    <div className="mb-8 space-y-3">
                        <section className="p-2 space-y-0.5">
                            <h4 className="typography-ui-header font-medium text-foreground">{t('settings.openchamber.visual.section.spacingAndLayout')}</h4>
                            <div className="pl-2">

                            {shouldShow('fontSize') && !isMobile && (
                                <div data-settings-item="appearance.interface-font-size" className="flex items-center gap-8 py-1">
                                    <div className="flex min-w-0 flex-col w-56 shrink-0">
                                        <span className="typography-ui-label text-foreground">{t('settings.openchamber.visual.field.interfaceFont')}</span>
                                    </div>
                                    <div className="flex items-center gap-2 w-fit">
                                        <Select value={uiFont} onValueChange={(value) => setUiFont(value as UiFontOption)}>
                                            <SelectTrigger aria-label={t('settings.openchamber.visual.field.selectInterfaceFontAria')} className="w-[13rem]">
                                                <SelectValue>{UI_FONT_OPTIONS.find((option) => option.id === uiFont)?.label}</SelectValue>
                                            </SelectTrigger>
                                            <SelectContent>
                                                {UI_FONT_OPTIONS.map((option) => (
                                                    <SelectItem key={option.id} value={option.id}>
                                                        <span style={{ fontFamily: option.stack }}>{option.label}</span>
                                                    </SelectItem>
                                                ))}
                                            </SelectContent>
                                        </Select>
                                        <Button size="sm"
                                            type="button"
                                            variant="ghost"
                                            onClick={() => setUiFont(DEFAULT_UI_FONT)}
                                            disabled={uiFont === DEFAULT_UI_FONT}
                                            className="h-7 w-7 px-0 text-muted-foreground hover:text-foreground"
                                            aria-label={t('settings.openchamber.visual.actions.resetInterfaceFontAria')}
                                            title={t('settings.common.actions.reset')}
                                        >
                                            <Icon name="restart" className="h-3.5 w-3.5" />
                                        </Button>
                                    </div>
                                </div>
                            )}

                            {shouldShow('terminalFontSize') && (
                                <div className={cn("py-1", isMobile ? "flex flex-col gap-3" : "flex items-center gap-8")}>
                                    <div className={cn("flex min-w-0 flex-col", isMobile ? "w-full" : "w-56 shrink-0")}>
                                        <span className="typography-ui-label text-foreground">{t('settings.openchamber.visual.field.codeFont')}</span>
                                    </div>
                                    <div className={cn("flex items-center gap-2", isMobile ? "w-full" : "w-fit")}>
                                        <Select value={monoFont} onValueChange={(value) => setMonoFont(value as MonoFontOption)}>
                                            <SelectTrigger aria-label={t('settings.openchamber.visual.field.selectCodeFontAria')} className="w-[13rem]">
                                                <SelectValue>{CODE_FONT_OPTIONS.find((option) => option.id === monoFont)?.label}</SelectValue>
                                            </SelectTrigger>
                                            <SelectContent>
                                                {CODE_FONT_OPTIONS.map((option) => (
                                                    <SelectItem key={option.id} value={option.id}>
                                                        <span style={{ fontFamily: option.stack }}>{option.label}</span>
                                                    </SelectItem>
                                                ))}
                                            </SelectContent>
                                        </Select>
                                        <Button size="sm"
                                            type="button"
                                            variant="ghost"
                                            onClick={() => setMonoFont(DEFAULT_MONO_FONT)}
                                            disabled={monoFont === DEFAULT_MONO_FONT}
                                            className="h-7 w-7 px-0 text-muted-foreground hover:text-foreground"
                                            aria-label={t('settings.openchamber.visual.actions.resetCodeFontAria')}
                                            title={t('settings.common.actions.reset')}
                                        >
                                            <Icon name="restart" className="h-3.5 w-3.5" />
                                        </Button>
                                    </div>
                                </div>
                            )}

                            {shouldShow('fontSize') && !isMobile && (
                                <div className="flex items-center gap-8 py-1">
                                    <div className="flex min-w-0 flex-col w-56 shrink-0">
                                        <span className="typography-ui-label text-foreground">{t('settings.openchamber.visual.field.interfaceFontSize')}</span>
                                    </div>
                                    <div className="flex items-center gap-2 w-fit">
                                        <NumberInput
                                            value={fontSize}
                                            onValueChange={setFontSize}
                                            min={50}
                                            max={200}
                                            step={5}
                                            aria-label={t('settings.openchamber.visual.field.fontSizePercentageAria')}
                                            className="w-16"
                                        />
                                        <Button size="sm"
                                            type="button"
                                            variant="ghost"
                                            onClick={() => setFontSize(100)}
                                            disabled={fontSize === 100}
                                            className="h-7 w-7 px-0 text-muted-foreground hover:text-foreground"
                                            aria-label={t('settings.openchamber.visual.actions.resetFontSizeAria')}
                                            title={t('settings.common.actions.reset')}
                                        >
                                            <Icon name="restart" className="h-3.5 w-3.5" />
                                        </Button>
                                    </div>
                                </div>
                            )}

                            {shouldShow('terminalFontSize') && (
                                <div data-settings-item="appearance.terminal-font-size" className={cn("py-1", isMobile ? "flex flex-col gap-3" : "flex items-center gap-8")}>
                                    <div className={cn("flex min-w-0 flex-col", isMobile ? "w-full" : "w-56 shrink-0")}>
                                        <span className="typography-ui-label text-foreground">{t('settings.openchamber.visual.field.terminalFontSize')}</span>
                                    </div>
                                    <div className={cn("flex items-center gap-2", isMobile ? "w-full" : "w-fit")}>
                                        <NumberInput
                                            value={terminalFontSize}
                                            onValueChange={setTerminalFontSize}
                                            min={9}
                                            max={52}
                                            step={1}
                                            className="w-16"
                                        />
                                        <Button size="sm"
                                            type="button"
                                            variant="ghost"
                                            onClick={() => setTerminalFontSize(13)}
                                            disabled={terminalFontSize === 13}
                                            className="h-7 w-7 px-0 text-muted-foreground hover:text-foreground"
                                            aria-label={t('settings.openchamber.visual.actions.resetTerminalFontSizeAria')}
                                            title={t('settings.common.actions.reset')}
                                        >
                                            <Icon name="restart" className="h-3.5 w-3.5" />
                                        </Button>
                                    </div>
                                </div>
                            )}

                            {shouldShow('editorFontSize') && (
                                <div data-settings-item="appearance.editor-font-size" className={cn("py-1", isMobile ? "flex flex-col gap-3" : "flex items-center gap-8")}>
                                    <div className={cn("flex min-w-0 flex-col", isMobile ? "w-full" : "w-56 shrink-0")}>
                                        <span className="typography-ui-label text-foreground">{t('settings.openchamber.visual.field.editorFontSize')}</span>
                                    </div>
                                    <div className={cn("flex items-center gap-2", isMobile ? "w-full" : "w-fit")}>
                                        <NumberInput
                                            value={editorFontSize}
                                            onValueChange={setEditorFontSize}
                                            min={9}
                                            max={32}
                                            step={1}
                                            className="w-16"
                                        />
                                        <Button size="sm"
                                            type="button"
                                            variant="ghost"
                                            onClick={() => setEditorFontSize(13)}
                                            disabled={editorFontSize === 13}
                                            className="h-7 w-7 px-0 text-muted-foreground hover:text-foreground"
                                            aria-label={t('settings.openchamber.visual.actions.resetEditorFontSizeAria')}
                                            title={t('settings.common.actions.reset')}
                                        >
                                            <Icon name="restart" className="h-3.5 w-3.5" />
                                        </Button>
                                    </div>
                                </div>
                            )}

                            {shouldShow('spacing') && (
                                <div data-settings-item="appearance.spacing-density" className={cn("py-1", isMobile ? "flex flex-col gap-3" : "flex items-center gap-8")}>
                                    <div className={cn("flex min-w-0 flex-col", isMobile ? "w-full" : "w-56 shrink-0")}>
                                        <span className="typography-ui-label text-foreground">{t('settings.openchamber.visual.field.spacingDensity')}</span>
                                    </div>
                                    <div className={cn("flex items-center gap-2", isMobile ? "w-full" : "w-fit")}>
                                        <NumberInput
                                            value={padding}
                                            onValueChange={setPadding}
                                            min={50}
                                            max={200}
                                            step={5}
                                            className="w-16"
                                        />
                                        <Button size="sm"
                                            type="button"
                                            variant="ghost"
                                            onClick={() => setPadding(100)}
                                            disabled={padding === 100}
                                            className="h-7 w-7 px-0 text-muted-foreground hover:text-foreground"
                                            aria-label={t('settings.openchamber.visual.actions.resetSpacingAria')}
                                            title={t('settings.common.actions.reset')}
                                        >
                                            <Icon name="restart" className="h-3.5 w-3.5" />
                                        </Button>
                                    </div>
                                </div>
                            )}

                            {shouldShow('inputBarOffset') && (
                                <div data-settings-item="appearance.input-bar-offset" className={cn("py-1", isMobile ? "flex flex-col gap-3" : "flex items-center gap-8")}>
                                    <div className={cn("flex min-w-0 flex-col", isMobile ? "w-full" : "w-56 shrink-0")}>
                                        <div className="flex items-center gap-1.5">
                                            <span className="typography-ui-label text-foreground">{t('settings.openchamber.visual.field.inputBarOffset')}</span>
                                            <Tooltip>
                                                <TooltipTrigger asChild>
                                                    <Icon name="information" className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
                                                </TooltipTrigger>
                                                <TooltipContent sideOffset={8} className="max-w-xs">
                                                    {t('settings.openchamber.visual.field.inputBarOffsetTooltip')}
                                                </TooltipContent>
                                            </Tooltip>
                                        </div>
                                    </div>
                                    <div className={cn("flex items-center gap-2", isMobile ? "w-full" : "w-fit")}>
                                        <NumberInput
                                            value={inputBarOffset}
                                            onValueChange={setInputBarOffset}
                                            min={0}
                                            max={100}
                                            step={5}
                                            className="w-16"
                                        />
                                        <Button size="sm"
                                            type="button"
                                            variant="ghost"
                                            onClick={() => setInputBarOffset(0)}
                                            disabled={inputBarOffset === 0}
                                            className="h-7 w-7 px-0 text-muted-foreground hover:text-foreground"
                                            aria-label={t('settings.openchamber.visual.actions.resetInputBarOffsetAria')}
                                            title={t('settings.common.actions.reset')}
                                        >
                                            <Icon name="restart" className="h-3.5 w-3.5" />
                                        </Button>
                                    </div>
                                </div>
                            )}

                            </div>

                        </section>
                    </div>
                )}

                {/* --- Navigation --- */}
                {hasNavigationSettings && (
                    <div className="space-y-3">
                        <section className="px-2 pb-2 pt-0">
                            <h4 className="typography-ui-header font-medium text-foreground">{t('settings.openchamber.visual.section.navigation')}</h4>
                            {shouldShow('fileEditorKeymap') && (
                                <div data-settings-item="appearance.file-editor-keymap" className="flex flex-col gap-2 py-1.5 sm:flex-row sm:items-start sm:gap-8">
                                    <span className="typography-ui-label text-foreground sm:w-56 shrink-0">
                                        {t('settings.openchamber.visual.field.fileEditorKeymap')}
                                    </span>
                                    <div
                                        role="radiogroup"
                                        aria-label={t('settings.openchamber.visual.field.fileEditorKeymap')}
                                        className="space-y-0"
                                    >
                                        {(['default', 'vim'] as const).map((keymap) => {
                                            const selected = fileEditorKeymap === keymap;
                                            const labelText = t(`settings.openchamber.visual.option.fileEditorKeymap.${keymap}`);
                                            return (
                                                <button
                                                    key={keymap}
                                                    type="button"
                                                    className="flex cursor-pointer items-center gap-2 py-0.5 text-left"
                                                    role="radio"
                                                    aria-checked={selected}
                                                    onClick={() => setFileEditorKeymap(keymap)}
                                                >
                                                    <span
                                                        aria-hidden
                                                        className={cn(
                                                            'relative flex h-[14px] w-[14px] min-h-[14px] min-w-[14px] shrink-0 self-center items-center justify-center rounded-full transition-[background-color,box-shadow] duration-200 ease-out',
                                                            selected
                                                                ? 'bg-[color-mix(in_srgb,var(--primary-base)_80%,transparent)] shadow-none'
                                                                : 'bg-[var(--surface-muted)] shadow-[inset_0_0_0_1px_var(--interactive-border)]'
                                                        )}
                                                    >
                                                        <span className={cn('block h-[5px] w-[5px] rounded-full bg-white', !selected && 'opacity-0')} />
                                                    </span>
                                                    <span className={cn('typography-ui-label font-normal', selected ? 'text-foreground' : 'text-foreground/50')}>
                                                        {labelText}
                                                    </span>
                                                </button>
                                            );
                                        })}
                                    </div>
                                </div>
                            )}
                            {shouldShow('expandedEditorToolbar') && (
                                <div
                                    data-settings-item="appearance.expanded-editor-toolbar"
                                    className="group flex cursor-pointer items-center gap-2 py-1.5"
                                    role="button"
                                    tabIndex={0}
                                    aria-pressed={expandedEditorToolbar}
                                    onClick={() => handleExpandedEditorToolbarChange(!expandedEditorToolbar)}
                                    onKeyDown={(event) => {
                                        if (event.key === ' ' || event.key === 'Enter') {
                                            event.preventDefault();
                                            handleExpandedEditorToolbarChange(!expandedEditorToolbar);
                                        }
                                    }}
                                >
                                    <Checkbox
                                        checked={expandedEditorToolbar}
                                        onChange={handleExpandedEditorToolbarChange}
                                        ariaLabel={t('settings.openchamber.visual.field.expandedEditorToolbarAria')}
                                    />
                                    <span className="typography-ui-label text-foreground">{t('settings.openchamber.visual.field.expandedEditorToolbar')}</span>
                                </div>
                            )}
                            {shouldShow('terminalQuickKeys') && !isMobile && (
                                <div
                                    data-settings-item="appearance.terminal-quick-keys"
                                    className="group flex cursor-pointer items-center gap-2 py-1.5"
                                    role="button"
                                    tabIndex={0}
                                    aria-pressed={showTerminalQuickKeysOnDesktop}
                                    onClick={() => setShowTerminalQuickKeysOnDesktop(!showTerminalQuickKeysOnDesktop)}
                                    onKeyDown={(event) => {
                                        if (event.key === ' ' || event.key === 'Enter') {
                                            event.preventDefault();
                                            setShowTerminalQuickKeysOnDesktop(!showTerminalQuickKeysOnDesktop);
                                        }
                                    }}
                                >
                                    <Checkbox
                                        checked={showTerminalQuickKeysOnDesktop}
                                        onChange={setShowTerminalQuickKeysOnDesktop}
                                        ariaLabel={t('settings.openchamber.visual.field.terminalQuickKeysAria')}
                                    />
                                    <div className="flex min-w-0 items-center gap-1.5">
                                        <span className="typography-ui-label text-foreground">{t('settings.openchamber.visual.field.terminalQuickKeys')}</span>
                                        <Tooltip>
                                            <TooltipTrigger asChild>
                                                <Icon name="information" className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
                                            </TooltipTrigger>
                                            <TooltipContent sideOffset={8} className="max-w-xs">
                                                {t('settings.openchamber.visual.field.terminalQuickKeysTooltip')}
                                            </TooltipContent>
                                        </Tooltip>
                                    </div>
                                </div>
                            )}
                        </section>
                    </div>
                )}

                {hasBehaviorSettings && (
                    <div className="space-y-3">

                            {(shouldShow('userMessageRendering') || shouldShow('mermaidRendering') || shouldShow('chatRenderMode') || shouldShow('messageTransport') || (shouldShow('activityRenderMode') && chatRenderMode === 'sorted') || (shouldShow('diffLayout') && !isVSCode) || shouldShow('followUpBehavior')) && (
                                <div className="grid grid-cols-1 gap-y-2 md:grid-cols-[minmax(0,16rem)_minmax(0,16rem)] md:justify-start md:gap-x-2">
                                    {shouldShow('chatRenderMode') && (
                                        <section data-settings-item="chat.render-mode" className="p-2 md:col-span-2">
                                            <h4 className="typography-ui-header font-medium text-foreground">{t('settings.openchamber.visual.section.chatRenderMode')}</h4>
                                            <div role="radiogroup" aria-label={t('settings.openchamber.visual.section.chatRenderModeAria')} className="mt-1 grid w-full max-w-[26rem] grid-cols-1 gap-3 sm:grid-cols-2">
                                                {CHAT_RENDER_MODE_OPTIONS.map((option) => {
                                                    const selected = chatRenderMode === option.id;
                                                    const previewPhase = chatRenderPreviewTick % 12;
                                                    return (
                                                        <button
                                                            key={option.id}
                                                            type="button"
                                                            onClick={() => handleChatRenderModeChange(option.id)}
                                                            aria-pressed={selected}
                                                            className={cn(
                                                                'flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors',
                                                                selected
                                                                    ? 'border-primary bg-primary/5'
                                                                    : 'border-border hover:border-border/80 hover:bg-muted/50'
                                                            )}
                                                        >
                                                            <span className={cn('typography-ui-label', selected ? 'text-foreground' : 'text-muted-foreground')}>
                                                                {tUnsafe(option.labelKey)}
                                                            </span>
                                                            <div className="mt-2 w-full rounded-md border border-border/60 bg-muted/30 p-2">
                                                                {option.id === 'live' ? (
                                                                    <div className="space-y-1.5">
                                                                        {[0, 1, 2].map((index) => {
                                                                            const rowStart = index * 3 + 1;
                                                                            const rowProgressPhase = previewPhase - rowStart + 1;
                                                                            const rowProgress = rowProgressPhase <= 0
                                                                                ? 0
                                                                                : rowProgressPhase === 1
                                                                                    ? 42
                                                                                    : rowProgressPhase === 2
                                                                                        ? 68
                                                                                        : 92;
                                                                            const visible = rowProgress > 0;
                                                                            return (
                                                                                <div
                                                                                    key={index}
                                                                                    className={cn(
                                                                                        'flex items-center gap-1.5 transition-all duration-300 motion-reduce:transition-none',
                                                                                        visible ? 'translate-y-0 opacity-100' : 'translate-y-1 opacity-0'
                                                                                    )}
                                                                                >
                                                                                    <span className="h-2 w-2 shrink-0 rounded-full bg-muted-foreground/55" />
                                                                                    <span
                                                                                        className="h-1.5 rounded bg-muted-foreground/30 transition-all duration-300 motion-reduce:transition-none"
                                                                                        style={{ width: `${rowProgress}%` }}
                                                                                    />
                                                                                </div>
                                                                            );
                                                                        })}
                                                                    </div>
                                                                ) : (
                                                                    <div className="space-y-1.5">
                                                                        {[0, 1, 2].map((index) => {
                                                                            const visible = previewPhase >= (index + 1) * 3;
                                                                            return (
                                                                                <div
                                                                                    key={index}
                                                                                    className={cn(
                                                                                        'flex items-center gap-1.5 transition-all duration-300 motion-reduce:transition-none',
                                                                                        visible ? 'translate-y-0 opacity-100' : 'translate-y-1 opacity-0'
                                                                                    )}
                                                                                >
                                                                                    <span className="h-2 w-2 shrink-0 rounded-full bg-muted-foreground/55" />
                                                                                    <span
                                                                                        className="h-1.5 rounded bg-muted-foreground/30"
                                                                                        style={{ width: '92%' }}
                                                                                    />
                                                                                </div>
                                                                            );
                                                                        })}
                                                                    </div>
                                                                )}
                                                            </div>
                                                        </button>
                                                    );
                                                })}
                                            </div>
                                        </section>
                                    )}

                                    {shouldShow('messageTransport') && (
                                        <section data-settings-item="chat.message-transport" className="p-2 md:col-span-2">
                                            <h4 className="typography-ui-header font-medium text-foreground">{t('settings.openchamber.visual.section.messageStreamTransport')}</h4>
                                            <div className="mt-1 flex max-w-[24rem] flex-col gap-2">
                                                <div className="flex flex-wrap items-center gap-1">
                                                    {MESSAGE_STREAM_TRANSPORT_OPTIONS.map((option) => (
                                                        <Button
                                                            key={option.id}
                                                            variant="chip"
                                                            size="xs"
                                                            aria-pressed={effectiveMessageStreamTransport === option.id}
                                                            className="!font-normal"
                                                            onClick={() => handleMessageStreamTransportChange(option.id)}
                                                        >
                                                            {tUnsafe(option.labelKey)}
                                                        </Button>
                                                    ))}
                                                </div>
                                                <span className="typography-meta text-muted-foreground">
                                                    {(() => {
                                                        const option = MESSAGE_STREAM_TRANSPORT_OPTIONS.find((item) => item.id === effectiveMessageStreamTransport);
                                                        return option?.descriptionKey ? tUnsafe(option.descriptionKey) : '';
                                                    })()}
                                                </span>
                                            </div>
                                        </section>
                                    )}

                                    {shouldShow('activityRenderMode') && chatRenderMode === 'sorted' && (
                                        <section className="p-2 md:col-span-2">
                                            <h4 className="typography-ui-header font-medium text-foreground">{t('settings.openchamber.visual.section.activityDefault')}</h4>
                                            <div role="radiogroup" aria-label={t('settings.openchamber.visual.section.activityDefaultAria')} className="mt-0.5 space-y-0">
                                                {ACTIVITY_RENDER_MODE_OPTIONS.map((option) => {
                                                    const selected = activityRenderMode === option.id;
                                                    return (
                                                        <div
                                                            key={option.id}
                                                            role="button"
                                                            tabIndex={0}
                                                            aria-pressed={selected}
                                                            onClick={() => handleActivityRenderModeChange(option.id)}
                                                            onKeyDown={(event) => {
                                                                if (event.key === ' ' || event.key === 'Enter') {
                                                                    event.preventDefault();
                                                                    handleActivityRenderModeChange(option.id);
                                                                }
                                                            }}
                                                            className="flex w-full items-center gap-2 py-0 text-left"
                                                        >
                                                            <Radio
                                                                checked={selected}
                                                                onChange={() => handleActivityRenderModeChange(option.id)}
                                                                ariaLabel={t('settings.openchamber.visual.field.activityDefaultModeAria', { option: tUnsafe(option.labelKey) })}
                                                            />
                                                            <span className={cn('typography-ui-label font-normal', selected ? 'text-foreground' : 'text-foreground/50')}>
                                                                {tUnsafe(option.labelKey)}
                                                            </span>
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        </section>
                                    )}

                                    {shouldShow('expandedTools') && (
                                        <section className="p-2 md:col-span-2 space-y-0.5">
                                            <div className="typography-ui-header font-medium text-foreground py-1.5">{t('settings.openchamber.visual.section.showToolsOpenedByDefault')}</div>

                                            <div
                                                className="group flex cursor-pointer items-center gap-2 py-0.5"
                                                role="button"
                                                tabIndex={0}
                                                aria-pressed={showExpandedBashTools}
                                                onClick={() => handleShowExpandedBashToolsChange(!showExpandedBashTools)}
                                                onKeyDown={(event) => {
                                                    if (event.key === ' ' || event.key === 'Enter') {
                                                        event.preventDefault();
                                                        handleShowExpandedBashToolsChange(!showExpandedBashTools);
                                                    }
                                                }}
                                            >
                                                <Checkbox
                                                    checked={showExpandedBashTools}
                                                    onChange={handleShowExpandedBashToolsChange}
                                                    ariaLabel={t('settings.openchamber.visual.field.showExpandedBashToolsAria')}
                                                />
                                                <span className="typography-ui-label text-foreground">{t('settings.openchamber.visual.field.bash')}</span>
                                            </div>

                                            <div
                                                className="group flex cursor-pointer items-center gap-2 py-0.5"
                                                role="button"
                                                tabIndex={0}
                                                aria-pressed={showExpandedEditTools}
                                                onClick={() => handleShowExpandedEditToolsChange(!showExpandedEditTools)}
                                                onKeyDown={(event) => {
                                                    if (event.key === ' ' || event.key === 'Enter') {
                                                        event.preventDefault();
                                                        handleShowExpandedEditToolsChange(!showExpandedEditTools);
                                                    }
                                                }}
                                            >
                                                <Checkbox
                                                    checked={showExpandedEditTools}
                                                    onChange={handleShowExpandedEditToolsChange}
                                                    ariaLabel={t('settings.openchamber.visual.field.showExpandedEditToolsAria')}
                                                />
                                                <span className="typography-ui-label text-foreground">{t('settings.openchamber.visual.field.editTools')}</span>
                                            </div>
                                        </section>
                                    )}

                                    {shouldShow('userMessageRendering') && (
                                        <section className="p-2">
                                            <h4 className="typography-ui-header font-medium text-foreground">{t('settings.openchamber.visual.section.userMessageRendering')}</h4>
                                            <div role="radiogroup" aria-label={t('settings.openchamber.visual.section.userMessageRenderingAria')} className="mt-0.5 space-y-0">
                                                {USER_MESSAGE_RENDERING_OPTIONS.map((option) => {
                                                    const selected = normalizeUserMessageRenderingMode(userMessageRenderingMode) === option.id;
                                                    return (
                                                        <div
                                                            key={option.id}
                                                            role="button"
                                                            tabIndex={0}
                                                            aria-pressed={selected}
                                                            onClick={() => handleUserMessageRenderingModeChange(option.id)}
                                                            onKeyDown={(event) => {
                                                                if (event.key === ' ' || event.key === 'Enter') {
                                                                    event.preventDefault();
                                                                    handleUserMessageRenderingModeChange(option.id);
                                                                }
                                                            }}
                                                            className="flex w-full items-center gap-2 py-0 text-left"
                                                        >
                                                            <Radio
                                                                checked={selected}
                                                                onChange={() => handleUserMessageRenderingModeChange(option.id)}
                                                                ariaLabel={t('settings.openchamber.visual.field.userMessageRenderingAria', { option: tUnsafe(option.labelKey) })}
                                                            />
                                                            <span className={cn('typography-ui-label font-normal', selected ? 'text-foreground' : 'text-foreground/50')}>
                                                                {tUnsafe(option.labelKey)}
                                                            </span>
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        </section>
                                    )}

                                    {shouldShow('mermaidRendering') && (
                                        <section className="p-2">
                                            <h4 className="typography-ui-header font-medium text-foreground">{t('settings.openchamber.visual.section.mermaidRendering')}</h4>
                                            <div role="radiogroup" aria-label={t('settings.openchamber.visual.section.mermaidRenderingAria')} className="mt-0.5 space-y-0">
                                                {MERMAID_RENDERING_OPTIONS.map((option) => {
                                                    const selected = mermaidRenderingMode === option.id;
                                                    return (
                                                        <div
                                                            key={option.id}
                                                            role="button"
                                                            tabIndex={0}
                                                            aria-pressed={selected}
                                                            onClick={() => handleMermaidRenderingModeChange(option.id)}
                                                            onKeyDown={(event) => {
                                                                if (event.key === ' ' || event.key === 'Enter') {
                                                                    event.preventDefault();
                                                                    handleMermaidRenderingModeChange(option.id);
                                                                }
                                                            }}
                                                            className="flex w-full items-center gap-2 py-0 text-left"
                                                        >
                                                            <Radio
                                                                checked={selected}
                                                                onChange={() => handleMermaidRenderingModeChange(option.id)}
                                                                ariaLabel={t('settings.openchamber.visual.field.mermaidRenderingAria', { option: tUnsafe(option.labelKey) })}
                                                            />
                                                            <span className={cn('typography-ui-label font-normal', selected ? 'text-foreground' : 'text-foreground/50')}>
                                                                {tUnsafe(option.labelKey)}
                                                            </span>
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        </section>
                                    )}

                                    {shouldShow('diffLayout') && !isVSCode && (
                                        <section className="p-2">
                                            <h4 className="typography-ui-header font-medium text-foreground">{t('settings.openchamber.visual.section.diffLayout')}</h4>
                                            <div role="radiogroup" aria-label={t('settings.openchamber.visual.section.diffLayoutAria')} className="mt-0.5 space-y-0">
                                                {DIFF_LAYOUT_OPTIONS.map((option) => {
                                                    const selected = diffLayoutPreference === option.id;
                                                    return (
                                                        <div
                                                            key={option.id}
                                                            role="button"
                                                            tabIndex={0}
                                                            aria-pressed={selected}
                                                            onClick={() => setDiffLayoutPreference(option.id)}
                                                            onKeyDown={(event) => {
                                                                if (event.key === ' ' || event.key === 'Enter') {
                                                                    event.preventDefault();
                                                                    setDiffLayoutPreference(option.id);
                                                                }
                                                            }}
                                                            className="flex w-full items-center gap-2 py-0 text-left"
                                                        >
                                                            <Radio
                                                                checked={selected}
                                                                onChange={() => setDiffLayoutPreference(option.id)}
                                                                ariaLabel={t('settings.openchamber.visual.field.diffLayoutAria', { option: tUnsafe(option.labelKey) })}
                                                            />
                                                            <span className={cn('typography-ui-label font-normal', selected ? 'text-foreground' : 'text-foreground/50')}>
                                                                {tUnsafe(option.labelKey)}
                                                            </span>
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        </section>
                                    )}

                                    {shouldShow('followUpBehavior') && (
                                        <section data-settings-item="chat.follow-up-behavior" className="p-2">
                                            <h4 className="typography-ui-header font-medium text-foreground">{t('settings.openchamber.visual.section.followUpBehavior')}</h4>
                                            <div role="radiogroup" aria-label={t('settings.openchamber.visual.section.followUpBehaviorAria')} className="mt-0.5 space-y-0">
                                                {FOLLOW_UP_BEHAVIOR_OPTIONS.map((option) => {
                                                    const selected = followUpBehavior === option.id;
                                                    return (
                                                        <div
                                                            key={option.id}
                                                            role="button"
                                                            tabIndex={0}
                                                            aria-pressed={selected}
                                                            onClick={() => setFollowUpBehavior(option.id)}
                                                            onKeyDown={(event) => {
                                                                if (event.key === ' ' || event.key === 'Enter') {
                                                                    event.preventDefault();
                                                                    setFollowUpBehavior(option.id);
                                                                }
                                                            }}
                                                            className="flex w-full items-center gap-2 py-0 text-left"
                                                        >
                                                            <Radio
                                                                checked={selected}
                                                                onChange={() => setFollowUpBehavior(option.id)}
                                                                ariaLabel={t('settings.openchamber.visual.field.followUpBehaviorAria', { option: tUnsafe(option.labelKey) })}
                                                            />
                                                            <span className={cn('typography-ui-label font-normal', selected ? 'text-foreground' : 'text-foreground/50')}>
                                                                {tUnsafe(option.labelKey)}
                                                            </span>
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        </section>
                                    )}

                                </div>
                            )}

                            {shouldShow('chatMessageWidth') && (
                                <section className="p-2" data-settings-item="chat.message-width">
                                    <h4 className="typography-ui-header font-medium text-foreground">{t('settings.openchamber.visual.section.chatMessageWidth')}</h4>
                                    <div role="radiogroup" aria-label={t('settings.openchamber.visual.section.chatMessageWidthAria')} className="mt-0.5 space-y-0">
                                        {CHAT_MESSAGE_WIDTH_OPTIONS.map((option) => {
                                            const selected = chatMessageWidthMode === option.id;
                                            return (
                                                <div
                                                    key={option.id}
                                                    role="button"
                                                    tabIndex={0}
                                                    aria-pressed={selected}
                                                    onClick={() => handleChatMessageWidthChange(option.id)}
                                                    onKeyDown={(event) => {
                                                        if (event.key === ' ' || event.key === 'Enter') {
                                                            event.preventDefault();
                                                            handleChatMessageWidthChange(option.id);
                                                        }
                                                    }}
                                                    className="flex w-full items-center gap-2 py-0 text-left"
                                                >
                                                    <Radio
                                                        checked={selected}
                                                        onChange={() => handleChatMessageWidthChange(option.id)}
                                                        ariaLabel={t('settings.openchamber.visual.field.chatMessageWidthAria', { option: tUnsafe(option.labelKey) })}
                                                    />
                                                    <span className={cn('typography-ui-label font-normal', selected ? 'text-foreground' : 'text-foreground/50')}>
                                                        {tUnsafe(option.labelKey)}
                                                    </span>
                                                </div>
                                            );
                                        })}
                                    </div>
                                </section>
                            )}

                            {/* The goal loop runs in the web server — VS Code only renders
                                goal state, so the settings section is hidden there too. */}
                            {shouldShow('sessionGoal') && !isVSCode && (
                                <section className="p-2 mb-6 space-y-0.5">
                                    <div className="flex items-center gap-1.5 py-1.5">
                                        <h3 className="typography-ui-header font-medium text-foreground">{t('settings.openchamber.visual.goal.sectionTitle')}</h3>
                                        <Tooltip>
                                            <TooltipTrigger asChild>
                                                <Icon name="information" className="h-3.5 w-3.5 cursor-help text-muted-foreground/60" />
                                            </TooltipTrigger>
                                            <TooltipContent sideOffset={8} className="max-w-sm">
                                                {t('settings.openchamber.visual.goal.description')}
                                            </TooltipContent>
                                        </Tooltip>
                                    </div>
                                        <div
                                            data-settings-item="chat.session-goal"
                                            className="group flex cursor-pointer items-center gap-2 py-0.5"
                                            role="button"
                                            tabIndex={0}
                                            aria-pressed={sessionGoalEnabled}
                                            onClick={() => setSessionGoalEnabled(!sessionGoalEnabled)}
                                            onKeyDown={(event) => {
                                                if (event.key === ' ' || event.key === 'Enter') {
                                                    event.preventDefault();
                                                    setSessionGoalEnabled(!sessionGoalEnabled);
                                                }
                                            }}
                                        >
                                            <Checkbox
                                                checked={sessionGoalEnabled}
                                                onChange={setSessionGoalEnabled}
                                                ariaLabel={t('settings.openchamber.visual.field.sessionGoalAria')}
                                            />
                                            <span className="typography-ui-label text-foreground">{t('settings.openchamber.visual.field.sessionGoal')}</span>
                                        </div>
                                        <div
                                            data-settings-item="chat.session-goal-budget"
                                            className="flex items-center gap-2 py-0.5"
                                        >
                                            <div
                                                className={cn('flex items-center gap-2', sessionGoalEnabled ? 'cursor-pointer' : 'opacity-50')}
                                                role="button"
                                                tabIndex={sessionGoalEnabled ? 0 : -1}
                                                aria-pressed={sessionGoalDefaultBudgetEnabled}
                                                onClick={() => {
                                                    if (sessionGoalEnabled) setSessionGoalDefaultBudgetEnabled(!sessionGoalDefaultBudgetEnabled);
                                                }}
                                                onKeyDown={(event) => {
                                                    if (sessionGoalEnabled && (event.key === ' ' || event.key === 'Enter')) {
                                                        event.preventDefault();
                                                        setSessionGoalDefaultBudgetEnabled(!sessionGoalDefaultBudgetEnabled);
                                                    }
                                                }}
                                            >
                                                <Checkbox
                                                    checked={sessionGoalDefaultBudgetEnabled}
                                                    onChange={setSessionGoalDefaultBudgetEnabled}
                                                    disabled={!sessionGoalEnabled}
                                                    ariaLabel={t('settings.openchamber.visual.goal.budgetAria')}
                                                />
                                                <span className="typography-ui-label text-foreground">{t('settings.openchamber.visual.goal.budgetLabel')}</span>
                                            </div>
                                            {sessionGoalEnabled && sessionGoalDefaultBudgetEnabled ? (
                                                <NumberInput
                                                    value={sessionGoalDefaultBudget}
                                                    onValueChange={(value) => {
                                                        if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
                                                            setSessionGoalDefaultBudget(Math.floor(value));
                                                        }
                                                    }}
                                                    min={1000}
                                                    max={100000000}
                                                    step={50000}
                                                />
                                            ) : null}
                                        </div>
                                </section>
                            )}

                            {(shouldShow('sessionAssist') || shouldShow('collapsibleUserMessages') || shouldShow('stickyUserHeader') || (shouldShow('promptNavigatorEnabled') && !isVSCode) || shouldShow('codeBlockLineWrap') || shouldShow('splitAssistantMessageActions') || shouldShow('subagentReadOnlyBanner') || shouldShow('dotfiles') || shouldShow('fileViewerPreview') || shouldShow('persistDraft') || shouldShow('showToolFileIcons') || shouldShow('showTurnChangedFiles') || (!isMobile && shouldShow('inputSpellcheck')) || shouldShow('reasoning')) && (
                                <div className="space-y-6">
                                    {(shouldShow('sessionAssist') || shouldShow('subagentReadOnlyBanner')) && (
                                        <section className="p-2 space-y-0.5">
                                            <h3 data-settings-item="chat.session-assistance" className="typography-ui-header font-medium text-foreground py-1.5">{t('settings.openchamber.visual.section.sessionAssistance')}</h3>
                                            {shouldShow('sessionAssist') && (
                                        <>
                                        <div
                                            data-settings-item="chat.session-recap"
                                            className="group flex cursor-pointer items-center gap-2 py-0.5"
                                            role="button"
                                            tabIndex={0}
                                            aria-pressed={sessionRecapEnabled}
                                            onClick={() => setSessionRecapEnabled(!sessionRecapEnabled)}
                                            onKeyDown={(event) => {
                                                if (event.key === ' ' || event.key === 'Enter') {
                                                    event.preventDefault();
                                                    setSessionRecapEnabled(!sessionRecapEnabled);
                                                }
                                            }}
                                        >
                                            <Checkbox
                                                checked={sessionRecapEnabled}
                                                onChange={setSessionRecapEnabled}
                                                ariaLabel={t('settings.openchamber.visual.field.sessionRecapAria')}
                                            />
                                            <span className="typography-ui-label text-foreground">{t('settings.openchamber.visual.field.sessionRecap')}</span>
                                        </div>
                                        <div
                                            data-settings-item="chat.session-suggestion"
                                            className="group flex cursor-pointer items-center gap-2 py-0.5"
                                            role="button"
                                            tabIndex={0}
                                            aria-pressed={sessionSuggestionEnabled}
                                            onClick={() => setSessionSuggestionEnabled(!sessionSuggestionEnabled)}
                                            onKeyDown={(event) => {
                                                if (event.key === ' ' || event.key === 'Enter') {
                                                    event.preventDefault();
                                                    setSessionSuggestionEnabled(!sessionSuggestionEnabled);
                                                }
                                            }}
                                        >
                                            <Checkbox
                                                checked={sessionSuggestionEnabled}
                                                onChange={setSessionSuggestionEnabled}
                                                ariaLabel={t('settings.openchamber.visual.field.sessionSuggestionAria')}
                                            />
                                            <span className="typography-ui-label text-foreground">{t('settings.openchamber.visual.field.sessionSuggestion')}</span>
                                        </div>
                                        </>
                                            )}
                                            {shouldShow('subagentReadOnlyBanner') && (
                                                <div
                                                    data-settings-item="chat.subagent-read-only-banner"
                                                    className="group flex cursor-pointer items-center gap-2 py-0.5"
                                                    role="button"
                                                    tabIndex={0}
                                                    aria-pressed={allowPromptingSubagentSessions}
                                                    onClick={() => setAllowPromptingSubagentSessions(!allowPromptingSubagentSessions)}
                                                    onKeyDown={(event) => {
                                                        if (event.key === ' ' || event.key === 'Enter') {
                                                            event.preventDefault();
                                                            setAllowPromptingSubagentSessions(!allowPromptingSubagentSessions);
                                                        }
                                                    }}
                                                >
                                                    <Checkbox
                                                        checked={allowPromptingSubagentSessions}
                                                        onChange={setAllowPromptingSubagentSessions}
                                                        ariaLabel={t('settings.openchamber.visual.field.allowPromptingSubagentSessionsAria')}
                                                    />
                                                    <span className="typography-ui-label text-foreground">{t('settings.openchamber.visual.field.allowPromptingSubagentSessions')}</span>
                                                </div>
                                            )}
                                        </section>
                                    )}
                                    {shouldShow('reasoning') && (
                                        <section className="p-2 space-y-0.5">
                                            <h3 data-settings-item="chat.reasoning" className="typography-ui-header font-medium text-foreground py-1.5">{t('settings.openchamber.visual.section.reasoning')}</h3>
                                    {shouldShow('reasoning') && (
                                        <div
                                            data-settings-item="chat.reasoning-traces"
                                            className="group flex cursor-pointer items-center gap-2 py-0.5"
                                            role="button"
                                            tabIndex={0}
                                            aria-pressed={showReasoningTraces}
                                            onClick={() => setShowReasoningTraces(!showReasoningTraces)}
                                            onKeyDown={(event) => {
                                                if (event.key === ' ' || event.key === 'Enter') {
                                                    event.preventDefault();
                                                    setShowReasoningTraces(!showReasoningTraces);
                                                }
                                            }}
                                        >
                                            <Checkbox
                                                checked={showReasoningTraces}
                                                onChange={setShowReasoningTraces}
                                                ariaLabel={t('settings.openchamber.visual.field.showReasoningTracesAria')}
                                            />
                                            <span className="typography-ui-label text-foreground">{t('settings.openchamber.visual.field.showReasoningTraces')}</span>
                                        </div>
                                    )}

                                    {shouldShow('reasoning') && showReasoningTraces && (
                                        <div
                                            className="group flex cursor-pointer items-center gap-2 py-0.5"
                                            role="button"
                                            tabIndex={0}
                                            aria-pressed={collapsibleThinkingBlocks}
                                            onClick={() => setCollapsibleThinkingBlocks(!collapsibleThinkingBlocks)}
                                            onKeyDown={(event) => {
                                                if (event.key === ' ' || event.key === 'Enter') {
                                                    event.preventDefault();
                                                    setCollapsibleThinkingBlocks(!collapsibleThinkingBlocks);
                                                }
                                            }}
                                        >
                                            <Checkbox
                                                checked={collapsibleThinkingBlocks}
                                                onChange={setCollapsibleThinkingBlocks}
                                                ariaLabel={t('settings.openchamber.visual.field.collapsibleThinkingBlocksAria')}
                                            />
                                            <span className="typography-ui-label text-foreground">{t('settings.openchamber.visual.field.collapsibleThinkingBlocks')}</span>
                                        </div>
                                    )}
                                        </section>
                                    )}

                                    {(shouldShow('collapsibleUserMessages') || shouldShow('stickyUserHeader') || (shouldShow('promptNavigatorEnabled') && !isVSCode) || shouldShow('splitAssistantMessageActions') || shouldShow('codeBlockLineWrap')) && (
                                        <section className="p-2 space-y-0.5">
                                            <h3 data-settings-item="chat.message-appearance" className="typography-ui-header font-medium text-foreground py-1.5">{t('settings.openchamber.visual.section.messageAppearance')}</h3>
                                    {shouldShow('collapsibleUserMessages') && (
                                        <div
                                            data-settings-item="chat.collapsible-user-messages"
                                            className="group flex cursor-pointer items-center gap-2 py-0.5"
                                            role="button"
                                            tabIndex={0}
                                            aria-pressed={collapsibleUserMessages}
                                            onClick={() => handleCollapsibleUserMessagesChange(!collapsibleUserMessages)}
                                            onKeyDown={(event) => {
                                                if (event.key === ' ' || event.key === 'Enter') {
                                                    event.preventDefault();
                                                    handleCollapsibleUserMessagesChange(!collapsibleUserMessages);
                                                }
                                            }}
                                        >
                                            <Checkbox
                                                checked={collapsibleUserMessages}
                                                onChange={handleCollapsibleUserMessagesChange}
                                                ariaLabel={t('settings.openchamber.visual.field.collapsibleUserMessagesAria')}
                                            />
                                            <span className="typography-ui-label text-foreground">{t('settings.openchamber.visual.field.collapsibleUserMessages')}</span>
                                        </div>
                                    )}

                                    {shouldShow('stickyUserHeader') && (
                                        <div
                                            data-settings-item="chat.sticky-user-header"
                                            className="group flex cursor-pointer items-center gap-2 py-0.5"
                                            role="button"
                                            tabIndex={0}
                                            aria-pressed={stickyUserHeader}
                                            onClick={() => handleStickyUserHeaderChange(!stickyUserHeader)}
                                            onKeyDown={(event) => {
                                                if (event.key === ' ' || event.key === 'Enter') {
                                                    event.preventDefault();
                                                    handleStickyUserHeaderChange(!stickyUserHeader);
                                                }
                                            }}
                                        >
                                            <Checkbox
                                                checked={stickyUserHeader}
                                                onChange={handleStickyUserHeaderChange}
                                                ariaLabel={t('settings.openchamber.visual.field.stickyUserHeaderAria')}
                                            />
                                            <span className="typography-ui-label text-foreground">{t('settings.openchamber.visual.field.stickyUserHeader')}</span>
                                        </div>
                                    )}

                                    {shouldShow('promptNavigatorEnabled') && !isVSCode && (
                                        <div
                                            data-settings-item="chat.prompt-navigator"
                                            className="group flex cursor-pointer items-center gap-2 py-0.5"
                                            role="button"
                                            tabIndex={0}
                                            aria-pressed={promptNavigatorEnabled}
                                            onClick={() => handlePromptNavigatorEnabledChange(!promptNavigatorEnabled)}
                                            onKeyDown={(event) => {
                                                if (event.key === ' ' || event.key === 'Enter') {
                                                    event.preventDefault();
                                                    handlePromptNavigatorEnabledChange(!promptNavigatorEnabled);
                                                }
                                            }}
                                        >
                                            <Checkbox
                                                checked={promptNavigatorEnabled}
                                                onChange={handlePromptNavigatorEnabledChange}
                                                ariaLabel={t('settings.openchamber.visual.field.promptNavigatorEnabledAria')}
                                            />
                                            <span className="typography-ui-label text-foreground">{t('settings.openchamber.visual.field.promptNavigatorEnabled')}</span>
                                        </div>
                                    )}

                                    {shouldShow('splitAssistantMessageActions') && (
                                        <div
                                            data-settings-item="chat.inline-assistant-actions"
                                            className="group flex cursor-pointer items-center gap-2 py-0.5"
                                            role="button"
                                            tabIndex={0}
                                            aria-pressed={showSplitAssistantMessageActions}
                                            onClick={() => handleShowSplitAssistantMessageActionsChange(!showSplitAssistantMessageActions)}
                                            onKeyDown={(event) => {
                                                if (event.key === ' ' || event.key === 'Enter') {
                                                    event.preventDefault();
                                                    handleShowSplitAssistantMessageActionsChange(!showSplitAssistantMessageActions);
                                                }
                                            }}
                                        >
                                            <Checkbox
                                                checked={showSplitAssistantMessageActions}
                                                onChange={handleShowSplitAssistantMessageActionsChange}
                                                ariaLabel={t('settings.openchamber.visual.field.showSplitAssistantMessageActionsAria')}
                                            />
                                            <div className="flex min-w-0 items-center gap-1.5">
                                                <span className="typography-ui-label text-foreground">{t('settings.openchamber.visual.field.showSplitAssistantMessageActions')}</span>
                                                <Tooltip>
                                                    <TooltipTrigger asChild>
                                                        <Icon name="information" className="h-3.5 w-3.5 cursor-help text-muted-foreground/60" />
                                                    </TooltipTrigger>
                                                    <TooltipContent sideOffset={8} className="max-w-xs">
                                                        {t('settings.openchamber.visual.field.showSplitAssistantMessageActionsTooltip')}
                                                    </TooltipContent>
                                                </Tooltip>
                                            </div>
                                        </div>
                                    )}

                                    {shouldShow('codeBlockLineWrap') && (
                                        <div
                                            data-settings-item="chat.code-block-line-wrap"
                                            className="group flex cursor-pointer items-center gap-2 py-0.5"
                                            role="button"
                                            tabIndex={0}
                                            aria-pressed={codeBlockLineWrap}
                                            onClick={() => setCodeBlockLineWrap(!codeBlockLineWrap)}
                                            onKeyDown={(event) => {
                                                if (event.key === ' ' || event.key === 'Enter') {
                                                    event.preventDefault();
                                                    setCodeBlockLineWrap(!codeBlockLineWrap);
                                                }
                                            }}
                                        >
                                            <Checkbox
                                                checked={codeBlockLineWrap}
                                                onChange={setCodeBlockLineWrap}
                                                ariaLabel={t('settings.openchamber.visual.field.codeBlockLineWrapAria')}
                                            />
                                            <span className="typography-ui-label text-foreground">{t('settings.openchamber.visual.field.codeBlockLineWrap')}</span>
                                        </div>
                                    )}
                                        </section>
                                    )}

                                    {(shouldShow('showToolFileIcons') || shouldShow('showTurnChangedFiles') || shouldShow('dotfiles') || shouldShow('fileViewerPreview')) && (
                                        <section className="p-2 space-y-0.5">
                                            <h3 data-settings-item="chat.tools-and-files" className="typography-ui-header font-medium text-foreground py-1.5">{t('settings.openchamber.visual.section.toolsAndFiles')}</h3>
                                    {shouldShow('showToolFileIcons') && (
                                        <div
                                            data-settings-item="chat.tool-file-icons"
                                            className="group flex cursor-pointer items-center gap-2 py-0.5"
                                            role="button"
                                            tabIndex={0}
                                            aria-pressed={showToolFileIcons}
                                            onClick={() => handleShowToolFileIconsChange(!showToolFileIcons)}
                                            onKeyDown={(event) => {
                                                if (event.key === ' ' || event.key === 'Enter') {
                                                    event.preventDefault();
                                                    handleShowToolFileIconsChange(!showToolFileIcons);
                                                }
                                            }}
                                        >
                                            <Checkbox
                                                checked={showToolFileIcons}
                                                onChange={handleShowToolFileIconsChange}
                                                ariaLabel={t('settings.openchamber.visual.field.showToolFileIconsAria')}
                                            />
                                            <span className="typography-ui-label text-foreground">{t('settings.openchamber.visual.field.showToolFileIcons')}</span>
                                        </div>
                                    )}

                                    {shouldShow('showTurnChangedFiles') && (
                                        <div
                                            data-settings-item="chat.changed-files"
                                            className="group flex cursor-pointer items-center gap-2 py-0.5"
                                            role="button"
                                            tabIndex={0}
                                            aria-pressed={showTurnChangedFiles}
                                            onClick={() => handleShowTurnChangedFilesChange(!showTurnChangedFiles)}
                                            onKeyDown={(event) => {
                                                if (event.key === ' ' || event.key === 'Enter') {
                                                    event.preventDefault();
                                                    handleShowTurnChangedFilesChange(!showTurnChangedFiles);
                                                }
                                            }}
                                        >
                                            <Checkbox
                                                checked={showTurnChangedFiles}
                                                onChange={handleShowTurnChangedFilesChange}
                                                ariaLabel={t('settings.openchamber.visual.field.showTurnChangedFilesAria')}
                                            />
                                            <span className="typography-ui-label text-foreground">{t('settings.openchamber.visual.field.showTurnChangedFiles')}</span>
                                        </div>
                                    )}

                                    {shouldShow('dotfiles') && !isVSCodeRuntime() && (
                                        <div
                                            data-settings-item="chat.dotfiles"
                                            className="group flex cursor-pointer items-center gap-2 py-0.5"
                                            role="button"
                                            tabIndex={0}
                                            aria-pressed={directoryShowHidden}
                                            onClick={() => setDirectoryShowHidden(!directoryShowHidden)}
                                            onKeyDown={(event) => {
                                                if (event.key === ' ' || event.key === 'Enter') {
                                                    event.preventDefault();
                                                    setDirectoryShowHidden(!directoryShowHidden);
                                                }
                                            }}
                                        >
                                            <Checkbox
                                                checked={directoryShowHidden}
                                                onChange={setDirectoryShowHidden}
                                                ariaLabel={t('settings.openchamber.visual.field.showDotfilesAria')}
                                            />
                                            <span className="typography-ui-label text-foreground">{t('settings.openchamber.visual.field.showDotfiles')}</span>
                                        </div>
                                    )}

                                    {shouldShow('fileViewerPreview') && (
                                        <div
                                            className="group flex cursor-pointer items-center gap-2 py-0.5"
                                            role="button"
                                            tabIndex={0}
                                            aria-pressed={settingsDefaultFileViewerPreview}
                                            onClick={() => handleFileViewerPreviewChange(!settingsDefaultFileViewerPreview)}
                                            onKeyDown={(event) => {
                                                if (event.key === ' ' || event.key === 'Enter') {
                                                    event.preventDefault();
                                                    handleFileViewerPreviewChange(!settingsDefaultFileViewerPreview);
                                                }
                                            }}
                                        >
                                            <span onClick={(event) => event.stopPropagation()}>
                                                <Checkbox
                                                    checked={settingsDefaultFileViewerPreview}
                                                    onChange={handleFileViewerPreviewChange}
                                                    ariaLabel={t('settings.openchamber.defaults.field.openFilesPreviewAria')}
                                                />
                                            </span>
                                            <span className="typography-ui-label text-foreground">{t('settings.openchamber.defaults.field.openFilesPreview')}</span>
                                        </div>
                                    )}
                                        </section>
                                    )}

                                    {(shouldShow('persistDraft') || (!isMobile && shouldShow('inputSpellcheck'))) && (
                                        <section className="p-2 space-y-0.5">
                                            <h3 data-settings-item="chat.composer" className="typography-ui-header font-medium text-foreground py-1.5">{t('settings.openchamber.visual.section.composer')}</h3>
                                    {shouldShow('persistDraft') && (
                                        <div
                                            data-settings-item="chat.persist-drafts"
                                            className="group flex cursor-pointer items-center gap-2 py-0.5"
                                            role="button"
                                            tabIndex={0}
                                            aria-pressed={persistChatDraft}
                                            onClick={() => setPersistChatDraft(!persistChatDraft)}
                                            onKeyDown={(event) => {
                                                if (event.key === ' ' || event.key === 'Enter') {
                                                    event.preventDefault();
                                                    setPersistChatDraft(!persistChatDraft);
                                                }
                                            }}
                                        >
                                            <Checkbox
                                                checked={persistChatDraft}
                                                onChange={setPersistChatDraft}
                                                ariaLabel={t('settings.openchamber.visual.field.persistDraftMessagesAria')}
                                            />
                                            <span className="typography-ui-label text-foreground">{t('settings.openchamber.visual.field.persistDraftMessages')}</span>
                                        </div>
                                    )}

                                    {!isMobile && shouldShow('inputSpellcheck') && (
                                        <div
                                            data-settings-item="chat.spellcheck"
                                            className="group flex cursor-pointer items-center gap-2 py-0.5"
                                            role="button"
                                            tabIndex={0}
                                            aria-pressed={inputSpellcheckEnabled}
                                            onClick={() => handleInputSpellcheckChange(!inputSpellcheckEnabled)}
                                            onKeyDown={(event) => {
                                                if (event.key === ' ' || event.key === 'Enter') {
                                                    event.preventDefault();
                                                    handleInputSpellcheckChange(!inputSpellcheckEnabled);
                                                }
                                            }}
                                        >
                                            <Checkbox
                                                checked={inputSpellcheckEnabled}
                                                onChange={handleInputSpellcheckChange}
                                                ariaLabel={t('settings.openchamber.visual.field.enableSpellcheckInTextInputsAria')}
                                            />
                                            <span className="typography-ui-label text-foreground">{t('settings.openchamber.visual.field.enableSpellcheckInTextInputs')}</span>
                                        </div>
                                    )}
                                        </section>
                                    )}

                                </div>
                            )}

                    </div>
                )}

                {/* --- Privacy & Data --- */}
                {shouldShow('reportUsage') && (
                    <div className="space-y-3">
                        <section className="px-2 pb-2 pt-0">
                            <h4 className="typography-ui-header font-medium text-foreground mb-2">{t('settings.openchamber.visual.section.privacy')}</h4>
                            <div data-settings-item="appearance.usage-reports" className="flex items-start gap-2 py-1.5">
                                <Checkbox
                                    checked={reportUsage}
                                    onChange={handleReportUsageChange}
                                    ariaLabel={t('settings.openchamber.visual.field.sendAnonymousUsageReportsAria')}
                                />
                                <div className="flex min-w-0 flex-col gap-0.5">
                                    <div
                                        className="group flex cursor-pointer"
                                        role="button"
                                        tabIndex={0}
                                        aria-pressed={reportUsage}
                                        onClick={() => handleReportUsageChange(!reportUsage)}
                                        onKeyDown={(event) => {
                                            if (event.key === ' ' || event.key === 'Enter') {
                                                event.preventDefault();
                                                handleReportUsageChange(!reportUsage);
                                            }
                                        }}
                                    >
                                        <span className="typography-ui-label text-foreground">{t('settings.openchamber.visual.field.sendAnonymousUsageReports')}</span>
                                    </div>
                                    <span className="typography-meta text-muted-foreground pointer-events-none">
                                        {t('settings.openchamber.visual.field.sendAnonymousUsageReportsHint')}
                                    </span>
                                </div>
                            </div>
                        </section>
                    </div>
                )}

            </div>
    );
};
