import React from 'react';
import { runtimeFetch } from '@/lib/runtime-fetch';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import type { ThemeMode } from '@/types/theme';
import { useUIStore } from '@/stores/useUIStore';
import { useMessageQueueStore, type FollowUpBehavior } from '@/stores/messageQueueStore';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { NumberInput } from '@/components/ui/number-input';
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
import {
    SettingsSection,
    SettingsTwoColumn,
    SettingsControlGroup,
    SettingsStackedField,
    SettingsFieldRow,
    SettingsInset,
    SettingsCheckboxRow,
    SettingsRadioGroup,
    SettingsRadioOption,
    SettingsChipGroup,
    SETTINGS_SELECT_TRIGGER_CLASS,
    SETTINGS_SELECT_SIZE,
    SETTINGS_ICON_BUTTON_CLASS,
    SETTINGS_CONTROL_CLUSTER_CLASS,
    SETTINGS_FIELDS_STACK_CLASS,
    SETTINGS_OPTION_STACK_CLASS,
} from '@/components/sections/shared/SettingsSection';

interface Option<T extends string> {
    id: T;
    labelKey: string;
    descriptionKey?: string;
}

const THEME_MODE_OPTIONS: Array<{ value: ThemeMode; labelKey: string; descriptionKey: string }> = [
    {
        value: 'system',
        labelKey: 'settings.openchamber.visual.option.themeMode.system',
        descriptionKey: 'settings.openchamber.visual.option.themeMode.system.description',
    },
    {
        value: 'light',
        labelKey: 'settings.openchamber.visual.option.themeMode.light',
        descriptionKey: 'settings.openchamber.visual.option.themeMode.light.description',
    },
    {
        value: 'dark',
        labelKey: 'settings.openchamber.visual.option.themeMode.dark',
        descriptionKey: 'settings.openchamber.visual.option.themeMode.dark.description',
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

type VisibleSetting = 'sessionAssist' | 'theme' | 'pwaInstallName' | 'pwaOrientation' | 'mobileKeyboardMode' | 'timeFormat' | 'weekStart' | 'fontSize' | 'terminalFontSize' | 'spacing' | 'inputBarOffset' | 'mermaidRendering' | 'userMessageRendering' | 'chatRenderMode' | 'messageTransport' | 'activityRenderMode' | 'collapsibleUserMessages' | 'stickyUserHeader' | 'wideChatLayout' | 'codeBlockLineWrap' | 'splitAssistantMessageActions' | 'diffLayout' | 'mobileStatusBar' | 'dotfiles' | 'fileViewerPreview' | 'reasoning' | 'showToolFileIcons' | 'showTurnChangedFiles' | 'expandedTools' | 'followUpBehavior' | 'terminalQuickKeys' | 'fileEditorKeymap' | 'persistDraft' | 'inputSpellcheck' | 'reportUsage' | 'expandedEditorToolbar';

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
    const setStickyUserHeader = useUIStore(state => state.setStickyUserHeader);
    const expandedEditorToolbar = useUIStore(state => state.expandedEditorToolbar);
    const setExpandedEditorToolbar = useUIStore(state => state.setExpandedEditorToolbar);
    const wideChatLayoutEnabled = useUIStore(state => state.wideChatLayoutEnabled);
    const setWideChatLayoutEnabled = useUIStore(state => state.setWideChatLayoutEnabled);
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

    const handleExpandedEditorToolbarChange = React.useCallback((enabled: boolean) => {
        setExpandedEditorToolbar(enabled);
        void updateDesktopSettings({ expandedEditorToolbar: enabled });
    }, [setExpandedEditorToolbar]);

    const handleCollapsibleUserMessagesChange = React.useCallback((enabled: boolean) => {
        setCollapsibleUserMessages(enabled);
        void updateDesktopSettings({ collapsibleUserMessages: enabled });
    }, [setCollapsibleUserMessages]);

    const handleWideChatLayoutChange = React.useCallback((enabled: boolean) => {
        setWideChatLayoutEnabled(enabled);
        void updateDesktopSettings({ wideChatLayoutEnabled: enabled });
    }, [setWideChatLayoutEnabled]);

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
    const hasLayoutSettings = shouldShow('fontSize') || shouldShow('terminalFontSize') || shouldShow('spacing') || shouldShow('inputBarOffset');
    const hasNavigationSettings = (shouldShow('terminalQuickKeys') && !isMobile) || shouldShow('fileEditorKeymap') || shouldShow('expandedEditorToolbar');
    const hasBehaviorSettings = shouldShow('mermaidRendering')
        || shouldShow('userMessageRendering')
        || shouldShow('chatRenderMode')
        || shouldShow('messageTransport')
        || (shouldShow('activityRenderMode') && chatRenderMode === 'sorted')
        || shouldShow('collapsibleUserMessages')
        || shouldShow('stickyUserHeader')
        || shouldShow('wideChatLayout')
        || shouldShow('codeBlockLineWrap')
        || shouldShow('splitAssistantMessageActions')
        || shouldShow('diffLayout')
        || shouldShow('dotfiles')
        || shouldShow('fileViewerPreview')
        || shouldShow('reasoning')
        || shouldShow('followUpBehavior')
        || shouldShow('persistDraft')
        || shouldShow('showToolFileIcons')
        || shouldShow('expandedTools')
        || (!isMobile && shouldShow('inputSpellcheck'));
    const showBehaviorDisplaySettings = shouldShow('chatRenderMode')
        || shouldShow('messageTransport')
        || (shouldShow('activityRenderMode') && chatRenderMode === 'sorted')
        || shouldShow('expandedTools');
    const showBehaviorMessageOptions = shouldShow('userMessageRendering')
        || shouldShow('mermaidRendering')
        || (shouldShow('diffLayout') && !isVSCode)
        || shouldShow('followUpBehavior');
    const showBehaviorFeatureCheckboxes = shouldShow('sessionAssist')
        || shouldShow('collapsibleUserMessages')
        || shouldShow('stickyUserHeader')
        || shouldShow('wideChatLayout')
        || shouldShow('codeBlockLineWrap')
        || shouldShow('splitAssistantMessageActions')
        || shouldShow('dotfiles')
        || shouldShow('fileViewerPreview')
        || shouldShow('persistDraft')
        || shouldShow('showToolFileIcons')
        || shouldShow('showTurnChangedFiles')
        || (!isMobile && shouldShow('inputSpellcheck'))
        || shouldShow('reasoning');
    // First behavior section under the page header should not draw a top border on Chat-only;
    // when Appearance (or earlier sections) already rendered, keep the default divider.
    const behaviorSectionDivider = hasAppearanceSettings || hasLayoutSettings || hasNavigationSettings;

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
        <div className="space-y-0">

                {/* --- Appearance & Themes --- */}
                {hasAppearanceSettings && (
                    <div className="space-y-0">
                        {hasThemeSettings && (
                            <SettingsSection title={t('settings.openchamber.visual.section.colorModeAndTheme')} divider={false}>
                                <SettingsTwoColumn>
                                    <div className={SETTINGS_FIELDS_STACK_CLASS}>
                                        <SettingsRadioGroup aria-label={t('settings.openchamber.visual.section.colorMode')}>
                                            {THEME_MODE_OPTIONS.map((option) => (
                                                <SettingsRadioOption
                                                    key={option.value}
                                                    selected={themeMode === option.value}
                                                    onSelect={() => setThemeMode(option.value)}
                                                    label={tUnsafe(option.labelKey)}
                                                    description={tUnsafe(option.descriptionKey)}
                                                    ariaLabel={tUnsafe(option.labelKey)}
                                                />
                                            ))}
                                        </SettingsRadioGroup>

                                        {showMobileLayoutSetting && (
                                            <SettingsInset>
                                                <SettingsStackedField label={t('settings.openchamber.visual.section.mobileLayout')}>
                                                    <SettingsChipGroup
                                                        value={mobileLayoutPreference}
                                                        options={MOBILE_LAYOUT_OPTIONS.map((option) => ({
                                                            value: option.value,
                                                            label: tUnsafe(option.labelKey),
                                                        }))}
                                                        onChange={handleMobileLayoutPreferenceChange}
                                                        aria-label={t('settings.openchamber.visual.section.mobileLayout')}
                                                    />
                                                </SettingsStackedField>
                                            </SettingsInset>
                                        )}
                                    </div>

                                    <div className={SETTINGS_FIELDS_STACK_CLASS}>
                                        <SettingsStackedField
                                            label={t('settings.openchamber.visual.field.lightTheme')}
                                            settingsItem="appearance.light-theme"
                                        >
                                            <Select value={selectedLightTheme?.metadata.id ?? ''} onValueChange={setLightThemePreference}>
                                                <SelectTrigger aria-label={t('settings.openchamber.visual.field.selectLightThemeAria')} size={SETTINGS_SELECT_SIZE} className={SETTINGS_SELECT_TRIGGER_CLASS}>
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
                                        </SettingsStackedField>
                                        <SettingsStackedField
                                            label={t('settings.openchamber.visual.field.darkTheme')}
                                            settingsItem="appearance.dark-theme"
                                        >
                                            <Select value={selectedDarkTheme?.metadata.id ?? ''} onValueChange={setDarkThemePreference}>
                                                <SelectTrigger aria-label={t('settings.openchamber.visual.field.selectDarkThemeAria')} size={SETTINGS_SELECT_SIZE} className={SETTINGS_SELECT_TRIGGER_CLASS}>
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
                                        </SettingsStackedField>

                                        <div className="flex items-center gap-2 pt-1">
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
                                                className="typography-settings-link inline-flex items-center gap-1.5 disabled:cursor-not-allowed disabled:opacity-50 disabled:no-underline"
                                            >
                                                <Icon name="restart" className={cn('h-3.5 w-3.5', themesReloading && 'animate-spin')} />
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
                                    </div>
                                </SettingsTwoColumn>

                                {macVibrancySupported && (
                                    <SettingsInset settingsItem="appearance.window-transparency" className="flex flex-col gap-1.5">
                                        <SettingsCheckboxRow
                                            checked={vibrancyChecked}
                                            onChange={setVibrancyChecked}
                                            disabled={vibrancyRestarting}
                                            label={t('settings.openchamber.visual.field.macVibrancy')}
                                            description={t('settings.openchamber.visual.field.macVibrancyHint')}
                                            ariaLabel={t('settings.openchamber.visual.field.macVibrancy')}
                                        />
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
                                    </SettingsInset>
                                )}

                                {dockBadgeSupported && (
                                    <SettingsInset settingsItem="appearance.dock-badge">
                                        <SettingsCheckboxRow
                                            checked={dockBadgeEnabled}
                                            onChange={setDockBadgeEnabled}
                                            label={t('settings.openchamber.visual.field.dockBadge')}
                                            description={t('settings.openchamber.visual.field.dockBadgeHint')}
                                            ariaLabel={t('settings.openchamber.visual.field.dockBadge')}
                                        />
                                    </SettingsInset>
                                )}
                            </SettingsSection>
                        )}

                        {hasLocalizationSettings && (
                            <SettingsSection title={t('settings.openchamber.visual.section.localization')}>
                                <SettingsTwoColumn>
                                    <SettingsStackedField
                                        label={t('settings.appearance.language.label')}
                                        description={t('settings.appearance.language.description')}
                                        descriptionPlacement="after"
                                        settingsItem="appearance.language"
                                    >
                                        <Select value={locale} onValueChange={(value) => setLocale(value as Locale)}>
                                            <SelectTrigger aria-label={t('settings.appearance.language.select')} size={SETTINGS_SELECT_SIZE} className={SETTINGS_SELECT_TRIGGER_CLASS}>
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
                                    </SettingsStackedField>

                                    {(shouldShow('timeFormat') || shouldShow('weekStart')) && (
                                        <div className={SETTINGS_FIELDS_STACK_CLASS}>
                                            {shouldShow('timeFormat') && (
                                                <SettingsStackedField
                                                    label={t('settings.openchamber.visual.field.timeFormat')}
                                                    settingsItem="appearance.time-format"
                                                >
                                                    <Select value={timeFormatPreference} onValueChange={(value: 'auto' | '12h' | '24h') => handleTimeFormatPreferenceChange(value)}>
                                                        <SelectTrigger aria-label={t('settings.openchamber.visual.field.selectTimeFormatAria')} size={SETTINGS_SELECT_SIZE} className={SETTINGS_SELECT_TRIGGER_CLASS}>
                                                            <SelectValue>{selectedTimeFormatLabel}</SelectValue>
                                                        </SelectTrigger>
                                                        <SelectContent>
                                                            {TIME_FORMAT_OPTIONS.map((option) => (
                                                                <SelectItem key={option.id} value={option.id}>{tUnsafe(option.labelKey)}</SelectItem>
                                                            ))}
                                                        </SelectContent>
                                                    </Select>
                                                </SettingsStackedField>
                                            )}

                                            {shouldShow('weekStart') && (
                                                <SettingsStackedField
                                                    label={t('settings.openchamber.visual.field.weekStartsOn')}
                                                    settingsItem="appearance.week-start"
                                                >
                                                    <Select value={weekStartPreference} onValueChange={(value: 'auto' | 'monday' | 'sunday') => handleWeekStartPreferenceChange(value)}>
                                                        <SelectTrigger aria-label={t('settings.openchamber.visual.field.selectWeekStartAria')} size={SETTINGS_SELECT_SIZE} className={SETTINGS_SELECT_TRIGGER_CLASS}>
                                                            <SelectValue>{selectedWeekStartLabel}</SelectValue>
                                                        </SelectTrigger>
                                                        <SelectContent>
                                                            {WEEK_START_OPTIONS.map((option) => (
                                                                <SelectItem key={option.id} value={option.id}>{tUnsafe(option.labelKey)}</SelectItem>
                                                            ))}
                                                        </SelectContent>
                                                    </Select>
                                                </SettingsStackedField>
                                            )}
                                        </div>
                                    )}
                                </SettingsTwoColumn>
                            </SettingsSection>
                        )}

                        {(showPwaInstallNameSetting || showPwaOrientationSetting || showMobileKeyboardModeSetting) && (
                            <SettingsSection title={t('settings.openchamber.visual.section.appInstall')} contentClassName={SETTINGS_FIELDS_STACK_CLASS}>

                            {showPwaInstallNameSetting && (
                                <SettingsStackedField
                                    label={t('settings.openchamber.visual.field.installAppName')}
                                    description={t('settings.openchamber.visual.field.installAppNameHint')}
                                    settingsItem="appearance.pwa-install-name"
                                    controlClassName={SETTINGS_CONTROL_CLUSTER_CLASS}
                                >
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
                                        className="min-w-0 flex-1"
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
                                        className={SETTINGS_ICON_BUTTON_CLASS}
                                        aria-label={t('settings.openchamber.visual.actions.resetInstallAppNameAria')}
                                        title={t('settings.common.actions.reset')}
                                    >
                                        <Icon name="restart" className="h-3.5 w-3.5" />
                                    </Button>
                                </SettingsStackedField>
                            )}

                            {showPwaOrientationSetting && (
                                <SettingsStackedField
                                    label={t('settings.openchamber.visual.field.installOrientation')}
                                    description={t('settings.openchamber.visual.field.installOrientationHint')}
                                    settingsItem="appearance.pwa-orientation"
                                    controlClassName={SETTINGS_CONTROL_CLUSTER_CLASS}
                                >
                                    <Select
                                        value={pwaOrientation}
                                        onValueChange={(value) => {
                                            const orientation = normalizePwaOrientation(value);
                                            setPwaOrientation(orientation);
                                            void applyPwaOrientation(orientation);
                                        }}
                                    >
                                        <SelectTrigger aria-label={t('settings.openchamber.visual.field.pwaInstallOrientationAria')} size={SETTINGS_SELECT_SIZE} className={SETTINGS_SELECT_TRIGGER_CLASS}>
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
                                        className={SETTINGS_ICON_BUTTON_CLASS}
                                        aria-label={t('settings.openchamber.visual.actions.resetInstallOrientationAria')}
                                        title={t('settings.common.actions.reset')}
                                    >
                                        <Icon name="restart" className="h-3.5 w-3.5" />
                                    </Button>
                                </SettingsStackedField>
                            )}

                            {showMobileKeyboardModeSetting && (
                                <SettingsStackedField
                                    label={t('settings.openchamber.visual.field.mobileKeyboardMode')}
                                    description={t('settings.openchamber.visual.field.mobileKeyboardModeHint')}
                                    settingsItem="appearance.mobile-keyboard-mode"
                                    controlClassName={SETTINGS_CONTROL_CLUSTER_CLASS}
                                >
                                    <Select
                                        value={mobileKeyboardMode}
                                        onValueChange={(value) => {
                                            const mode = normalizeMobileKeyboardMode(value);
                                            setMobileKeyboardMode(mode);
                                            void updateDesktopSettings({ mobileKeyboardMode: mode });
                                        }}
                                    >
                                        <SelectTrigger aria-label={t('settings.openchamber.visual.field.mobileKeyboardModeAria')} size={SETTINGS_SELECT_SIZE} className={SETTINGS_SELECT_TRIGGER_CLASS}>
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
                                        className={SETTINGS_ICON_BUTTON_CLASS}
                                        aria-label={t('settings.openchamber.visual.actions.resetMobileKeyboardModeAria')}
                                        title={t('settings.common.actions.reset')}
                                    >
                                        <Icon name="restart" className="h-3.5 w-3.5" />
                                    </Button>
                                </SettingsStackedField>
                            )}
                            </SettingsSection>
                        )}
                    </div>
                )}

                {/* --- Density & type --- */}
                {hasLayoutSettings && (
                    <SettingsSection title={t('settings.openchamber.visual.section.densityAndType')}>
                        <SettingsTwoColumn>
                            <div className={SETTINGS_FIELDS_STACK_CLASS}>
                                {shouldShow('fontSize') && !isMobile && (
                                    <SettingsStackedField
                                        label={t('settings.openchamber.visual.field.interfaceFont')}
                                        settingsItem="appearance.interface-font-size"
                                    >
                                        <Select value={uiFont} onValueChange={(value) => setUiFont(value as UiFontOption)}>
                                            <SelectTrigger aria-label={t('settings.openchamber.visual.field.selectInterfaceFontAria')} size={SETTINGS_SELECT_SIZE} className={SETTINGS_SELECT_TRIGGER_CLASS}>
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
                                            className={SETTINGS_ICON_BUTTON_CLASS}
                                            aria-label={t('settings.openchamber.visual.actions.resetInterfaceFontAria')}
                                            title={t('settings.common.actions.reset')}
                                        >
                                            <Icon name="restart" className="h-3.5 w-3.5" />
                                        </Button>
                                    </SettingsStackedField>
                                )}

                                {shouldShow('terminalFontSize') && (
                                    <SettingsStackedField label={t('settings.openchamber.visual.field.codeFont')}>
                                        <Select value={monoFont} onValueChange={(value) => setMonoFont(value as MonoFontOption)}>
                                            <SelectTrigger aria-label={t('settings.openchamber.visual.field.selectCodeFontAria')} size={SETTINGS_SELECT_SIZE} className={SETTINGS_SELECT_TRIGGER_CLASS}>
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
                                            className={SETTINGS_ICON_BUTTON_CLASS}
                                            aria-label={t('settings.openchamber.visual.actions.resetCodeFontAria')}
                                            title={t('settings.common.actions.reset')}
                                        >
                                            <Icon name="restart" className="h-3.5 w-3.5" />
                                        </Button>
                                    </SettingsStackedField>
                                )}

                                {shouldShow('fontSize') && !isMobile && (
                                    <SettingsStackedField label={t('settings.openchamber.visual.field.interfaceFontSize')}>
                                        <NumberInput
                                            value={fontSize}
                                            onValueChange={setFontSize}
                                            min={50}
                                            max={200}
                                            step={5}
                                            aria-label={t('settings.openchamber.visual.field.fontSizePercentageAria')}
                                        />
                                        <span className="typography-meta text-muted-foreground tabular-nums">%</span>
                                        <Button size="sm"
                                            type="button"
                                            variant="ghost"
                                            onClick={() => setFontSize(100)}
                                            disabled={fontSize === 100}
                                            className={SETTINGS_ICON_BUTTON_CLASS}
                                            aria-label={t('settings.openchamber.visual.actions.resetFontSizeAria')}
                                            title={t('settings.common.actions.reset')}
                                        >
                                            <Icon name="restart" className="h-3.5 w-3.5" />
                                        </Button>
                                    </SettingsStackedField>
                                )}

                                {shouldShow('terminalFontSize') && (
                                    <SettingsStackedField
                                        label={t('settings.openchamber.visual.field.terminalFontSize')}
                                        settingsItem="appearance.terminal-font-size"
                                    >
                                        <NumberInput
                                            value={terminalFontSize}
                                            onValueChange={setTerminalFontSize}
                                            min={9}
                                            max={52}
                                            step={1}
                                            className="w-16"
                                        />
                                        <span className="typography-meta text-muted-foreground tabular-nums">px</span>
                                        <Button size="sm"
                                            type="button"
                                            variant="ghost"
                                            onClick={() => setTerminalFontSize(13)}
                                            disabled={terminalFontSize === 13}
                                            className={SETTINGS_ICON_BUTTON_CLASS}
                                            aria-label={t('settings.openchamber.visual.actions.resetTerminalFontSizeAria')}
                                            title={t('settings.common.actions.reset')}
                                        >
                                            <Icon name="restart" className="h-3.5 w-3.5" />
                                        </Button>
                                    </SettingsStackedField>
                                )}
                            </div>

                            <div className={SETTINGS_FIELDS_STACK_CLASS}>
                                {shouldShow('spacing') && (
                                    <SettingsStackedField
                                        label={t('settings.openchamber.visual.field.spacingDensity')}
                                        settingsItem="appearance.spacing-density"
                                    >
                                        <NumberInput
                                            value={padding}
                                            onValueChange={setPadding}
                                            min={50}
                                            max={200}
                                            step={5}
                                            className="w-16"
                                        />
                                        <span className="typography-meta text-muted-foreground tabular-nums">%</span>
                                        <Button size="sm"
                                            type="button"
                                            variant="ghost"
                                            onClick={() => setPadding(100)}
                                            disabled={padding === 100}
                                            className={SETTINGS_ICON_BUTTON_CLASS}
                                            aria-label={t('settings.openchamber.visual.actions.resetSpacingAria')}
                                            title={t('settings.common.actions.reset')}
                                        >
                                            <Icon name="restart" className="h-3.5 w-3.5" />
                                        </Button>
                                    </SettingsStackedField>
                                )}

                                {shouldShow('inputBarOffset') && (
                                    <SettingsStackedField
                                        label={(
                                            <span className="inline-flex items-center gap-1.5">
                                                {t('settings.openchamber.visual.field.inputBarOffset')}
                                                <Tooltip>
                                                    <TooltipTrigger asChild>
                                                        <Icon name="information" className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
                                                    </TooltipTrigger>
                                                    <TooltipContent sideOffset={8} className="max-w-xs">
                                                        {t('settings.openchamber.visual.field.inputBarOffsetTooltip')}
                                                    </TooltipContent>
                                                </Tooltip>
                                            </span>
                                        )}
                                        settingsItem="appearance.input-bar-offset"
                                    >
                                        <NumberInput
                                            value={inputBarOffset}
                                            onValueChange={setInputBarOffset}
                                            min={0}
                                            max={100}
                                            step={5}
                                            className="w-16"
                                        />
                                        <span className="typography-meta text-muted-foreground tabular-nums">px</span>
                                        <Button size="sm"
                                            type="button"
                                            variant="ghost"
                                            onClick={() => setInputBarOffset(0)}
                                            disabled={inputBarOffset === 0}
                                            className={SETTINGS_ICON_BUTTON_CLASS}
                                            aria-label={t('settings.openchamber.visual.actions.resetInputBarOffsetAria')}
                                            title={t('settings.common.actions.reset')}
                                        >
                                            <Icon name="restart" className="h-3.5 w-3.5" />
                                        </Button>
                                    </SettingsStackedField>
                                )}
                            </div>
                        </SettingsTwoColumn>
                    </SettingsSection>
                )}

                {/* --- Navigation --- */}
                {hasNavigationSettings && (
                    <SettingsSection title={t('settings.openchamber.visual.section.navigation')} contentClassName={SETTINGS_OPTION_STACK_CLASS}>
                            {shouldShow('fileEditorKeymap') && (
                                <SettingsFieldRow
                                    label={t('settings.openchamber.visual.field.fileEditorKeymap')}
                                    settingsItem="appearance.file-editor-keymap"
                                    alignEnd={false}
                                >
                                    <SettingsRadioGroup aria-label={t('settings.openchamber.visual.field.fileEditorKeymap')}>
                                        {(['default', 'vim'] as const).map((keymap) => (
                                            <SettingsRadioOption
                                                key={keymap}
                                                selected={fileEditorKeymap === keymap}
                                                onSelect={() => setFileEditorKeymap(keymap)}
                                                label={t(`settings.openchamber.visual.option.fileEditorKeymap.${keymap}`)}
                                                ariaLabel={t(`settings.openchamber.visual.option.fileEditorKeymap.${keymap}`)}
                                            />
                                        ))}
                                    </SettingsRadioGroup>
                                </SettingsFieldRow>
                            )}
                            {shouldShow('expandedEditorToolbar') && (
                                <SettingsCheckboxRow
                                    checked={expandedEditorToolbar}
                                    onChange={handleExpandedEditorToolbarChange}
                                    label={t('settings.openchamber.visual.field.expandedEditorToolbar')}
                                    ariaLabel={t('settings.openchamber.visual.field.expandedEditorToolbarAria')}
                                    settingsItem="appearance.expanded-editor-toolbar"
                                />
                            )}
                            {shouldShow('terminalQuickKeys') && !isMobile && (
                                <SettingsCheckboxRow
                                    checked={showTerminalQuickKeysOnDesktop}
                                    onChange={setShowTerminalQuickKeysOnDesktop}
                                    label={t('settings.openchamber.visual.field.terminalQuickKeys')}
                                    ariaLabel={t('settings.openchamber.visual.field.terminalQuickKeysAria')}
                                    settingsItem="appearance.terminal-quick-keys"
                                    labelAccessory={(
                                        <Tooltip>
                                            <TooltipTrigger asChild>
                                                <Icon name="information" className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
                                            </TooltipTrigger>
                                            <TooltipContent sideOffset={8} className="max-w-xs">
                                                {t('settings.openchamber.visual.field.terminalQuickKeysTooltip')}
                                            </TooltipContent>
                                        </Tooltip>
                                    )}
                                />
                            )}
                    </SettingsSection>
                )}

                {hasBehaviorSettings && (
                    <>
                        {showBehaviorDisplaySettings && (
                            <SettingsSection
                                title={t('settings.openchamber.visual.section.chatDisplay')}
                                divider={behaviorSectionDivider}
                                contentClassName="space-y-6"
                            >
                                {shouldShow('chatRenderMode') && (
                                    <SettingsControlGroup
                                        title={t('settings.openchamber.visual.section.chatRenderMode')}
                                        settingsItem="chat.render-mode"
                                    >
                                        <div role="radiogroup" aria-label={t('settings.openchamber.visual.section.chatRenderModeAria')} className="grid w-full max-w-[26rem] grid-cols-1 gap-3 sm:grid-cols-2">
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
                                    </SettingsControlGroup>
                                )}

                                {shouldShow('messageTransport') && (
                                    <SettingsControlGroup
                                        title={t('settings.openchamber.visual.section.messageStreamTransport')}
                                        settingsItem="chat.message-transport"
                                        contentClassName="space-y-2"
                                    >
                                        <SettingsChipGroup
                                            value={effectiveMessageStreamTransport}
                                            options={MESSAGE_STREAM_TRANSPORT_OPTIONS.map((option) => ({
                                                value: option.id,
                                                label: tUnsafe(option.labelKey),
                                            }))}
                                            onChange={handleMessageStreamTransportChange}
                                            aria-label={t('settings.openchamber.visual.section.messageStreamTransport')}
                                        />
                                        {(() => {
                                            const option = MESSAGE_STREAM_TRANSPORT_OPTIONS.find((item) => item.id === effectiveMessageStreamTransport);
                                            return option?.descriptionKey ? (
                                                <span className="typography-meta text-muted-foreground">
                                                    {tUnsafe(option.descriptionKey)}
                                                </span>
                                            ) : null;
                                        })()}
                                    </SettingsControlGroup>
                                )}

                                {shouldShow('activityRenderMode') && chatRenderMode === 'sorted' && (
                                    <SettingsControlGroup title={t('settings.openchamber.visual.section.activityDefault')}>
                                        <SettingsRadioGroup aria-label={t('settings.openchamber.visual.section.activityDefaultAria')}>
                                            {ACTIVITY_RENDER_MODE_OPTIONS.map((option) => (
                                                <SettingsRadioOption
                                                    key={option.id}
                                                    selected={activityRenderMode === option.id}
                                                    onSelect={() => handleActivityRenderModeChange(option.id)}
                                                    label={tUnsafe(option.labelKey)}
                                                    ariaLabel={t('settings.openchamber.visual.field.activityDefaultModeAria', { option: tUnsafe(option.labelKey) })}
                                                />
                                            ))}
                                        </SettingsRadioGroup>
                                    </SettingsControlGroup>
                                )}

                                {shouldShow('expandedTools') && (
                                    <SettingsControlGroup title={t('settings.openchamber.visual.section.showToolsOpenedByDefault')}>
                                        <SettingsCheckboxRow
                                            checked={showExpandedBashTools}
                                            onChange={handleShowExpandedBashToolsChange}
                                            label={t('settings.openchamber.visual.field.bash')}
                                            ariaLabel={t('settings.openchamber.visual.field.showExpandedBashToolsAria')}
                                        />
                                        <SettingsCheckboxRow
                                            checked={showExpandedEditTools}
                                            onChange={handleShowExpandedEditToolsChange}
                                            label={t('settings.openchamber.visual.field.editTools')}
                                            ariaLabel={t('settings.openchamber.visual.field.showExpandedEditToolsAria')}
                                        />
                                    </SettingsControlGroup>
                                )}
                            </SettingsSection>
                        )}

                        {showBehaviorMessageOptions && (
                            <SettingsSection
                                title={t('settings.openchamber.visual.section.chatMessageOptions')}
                                divider={showBehaviorDisplaySettings || behaviorSectionDivider}
                            >
                                {/* Flat 2×2 grid so row headers share a baseline (not stacked columns). */}
                                <SettingsTwoColumn className="lg:gap-y-6">
                                    {shouldShow('userMessageRendering') && (
                                        <SettingsControlGroup title={t('settings.openchamber.visual.section.userMessageRendering')}>
                                            <SettingsRadioGroup aria-label={t('settings.openchamber.visual.section.userMessageRenderingAria')}>
                                                {USER_MESSAGE_RENDERING_OPTIONS.map((option) => (
                                                    <SettingsRadioOption
                                                        key={option.id}
                                                        selected={normalizeUserMessageRenderingMode(userMessageRenderingMode) === option.id}
                                                        onSelect={() => handleUserMessageRenderingModeChange(option.id)}
                                                        label={tUnsafe(option.labelKey)}
                                                        ariaLabel={t('settings.openchamber.visual.field.userMessageRenderingAria', { option: tUnsafe(option.labelKey) })}
                                                    />
                                                ))}
                                            </SettingsRadioGroup>
                                        </SettingsControlGroup>
                                    )}

                                    {shouldShow('mermaidRendering') && (
                                        <SettingsControlGroup title={t('settings.openchamber.visual.section.mermaidRendering')}>
                                            <SettingsRadioGroup aria-label={t('settings.openchamber.visual.section.mermaidRenderingAria')}>
                                                {MERMAID_RENDERING_OPTIONS.map((option) => (
                                                    <SettingsRadioOption
                                                        key={option.id}
                                                        selected={mermaidRenderingMode === option.id}
                                                        onSelect={() => handleMermaidRenderingModeChange(option.id)}
                                                        label={tUnsafe(option.labelKey)}
                                                        ariaLabel={t('settings.openchamber.visual.field.mermaidRenderingAria', { option: tUnsafe(option.labelKey) })}
                                                    />
                                                ))}
                                            </SettingsRadioGroup>
                                        </SettingsControlGroup>
                                    )}

                                    {shouldShow('diffLayout') && !isVSCode && (
                                        <SettingsControlGroup title={t('settings.openchamber.visual.section.diffLayout')}>
                                            <SettingsRadioGroup aria-label={t('settings.openchamber.visual.section.diffLayoutAria')}>
                                                {DIFF_LAYOUT_OPTIONS.map((option) => (
                                                    <SettingsRadioOption
                                                        key={option.id}
                                                        selected={diffLayoutPreference === option.id}
                                                        onSelect={() => setDiffLayoutPreference(option.id)}
                                                        label={tUnsafe(option.labelKey)}
                                                        ariaLabel={t('settings.openchamber.visual.field.diffLayoutAria', { option: tUnsafe(option.labelKey) })}
                                                    />
                                                ))}
                                            </SettingsRadioGroup>
                                        </SettingsControlGroup>
                                    )}

                                    {shouldShow('followUpBehavior') && (
                                        <SettingsControlGroup
                                            title={t('settings.openchamber.visual.section.followUpBehavior')}
                                            settingsItem="chat.follow-up-behavior"
                                        >
                                            <SettingsRadioGroup aria-label={t('settings.openchamber.visual.section.followUpBehaviorAria')}>
                                                {FOLLOW_UP_BEHAVIOR_OPTIONS.map((option) => (
                                                    <SettingsRadioOption
                                                        key={option.id}
                                                        selected={followUpBehavior === option.id}
                                                        onSelect={() => setFollowUpBehavior(option.id)}
                                                        label={tUnsafe(option.labelKey)}
                                                        ariaLabel={t('settings.openchamber.visual.field.followUpBehaviorAria', { option: tUnsafe(option.labelKey) })}
                                                    />
                                                ))}
                                            </SettingsRadioGroup>
                                        </SettingsControlGroup>
                                    )}
                                </SettingsTwoColumn>
                            </SettingsSection>
                        )}

                        {showBehaviorFeatureCheckboxes && (
                            <SettingsSection
                                title={t('settings.openchamber.visual.section.chatFeatures')}
                                divider={showBehaviorDisplaySettings || showBehaviorMessageOptions || behaviorSectionDivider}
                                contentClassName={SETTINGS_OPTION_STACK_CLASS}
                            >
                                {shouldShow('sessionAssist') && (
                                    <>
                                        <SettingsCheckboxRow
                                            checked={sessionRecapEnabled}
                                            onChange={setSessionRecapEnabled}
                                            label={t('settings.openchamber.visual.field.sessionRecap')}
                                            ariaLabel={t('settings.openchamber.visual.field.sessionRecapAria')}
                                            settingsItem="chat.session-recap"
                                        />
                                        <SettingsCheckboxRow
                                            checked={sessionSuggestionEnabled}
                                            onChange={setSessionSuggestionEnabled}
                                            label={t('settings.openchamber.visual.field.sessionSuggestion')}
                                            ariaLabel={t('settings.openchamber.visual.field.sessionSuggestionAria')}
                                            settingsItem="chat.session-suggestion"
                                        />
                                    </>
                                )}
                                {shouldShow('reasoning') && (
                                    <SettingsCheckboxRow
                                        checked={showReasoningTraces}
                                        onChange={setShowReasoningTraces}
                                        label={t('settings.openchamber.visual.field.showReasoningTraces')}
                                        ariaLabel={t('settings.openchamber.visual.field.showReasoningTracesAria')}
                                        settingsItem="chat.reasoning-traces"
                                    />
                                )}

                                {shouldShow('reasoning') && showReasoningTraces && (
                                    <SettingsCheckboxRow
                                        checked={collapsibleThinkingBlocks}
                                        onChange={setCollapsibleThinkingBlocks}
                                        label={t('settings.openchamber.visual.field.collapsibleThinkingBlocks')}
                                        ariaLabel={t('settings.openchamber.visual.field.collapsibleThinkingBlocksAria')}
                                    />
                                )}

                                {shouldShow('collapsibleUserMessages') && (
                                    <SettingsCheckboxRow
                                        checked={collapsibleUserMessages}
                                        onChange={handleCollapsibleUserMessagesChange}
                                        label={t('settings.openchamber.visual.field.collapsibleUserMessages')}
                                        ariaLabel={t('settings.openchamber.visual.field.collapsibleUserMessagesAria')}
                                        settingsItem="chat.collapsible-user-messages"
                                    />
                                )}

                                {shouldShow('stickyUserHeader') && (
                                    <SettingsCheckboxRow
                                        checked={stickyUserHeader}
                                        onChange={handleStickyUserHeaderChange}
                                        label={t('settings.openchamber.visual.field.stickyUserHeader')}
                                        ariaLabel={t('settings.openchamber.visual.field.stickyUserHeaderAria')}
                                        settingsItem="chat.sticky-user-header"
                                    />
                                )}

                                {shouldShow('wideChatLayout') && (
                                    <SettingsCheckboxRow
                                        checked={wideChatLayoutEnabled}
                                        onChange={handleWideChatLayoutChange}
                                        label={t('settings.openchamber.visual.field.wideChatLayout')}
                                        ariaLabel={t('settings.openchamber.visual.field.wideChatLayoutAria')}
                                        settingsItem="chat.wide-layout"
                                    />
                                )}

                                {shouldShow('splitAssistantMessageActions') && (
                                    <SettingsCheckboxRow
                                        checked={showSplitAssistantMessageActions}
                                        onChange={handleShowSplitAssistantMessageActionsChange}
                                        label={t('settings.openchamber.visual.field.showSplitAssistantMessageActions')}
                                        ariaLabel={t('settings.openchamber.visual.field.showSplitAssistantMessageActionsAria')}
                                        settingsItem="chat.inline-assistant-actions"
                                        labelAccessory={(
                                            <Tooltip>
                                                <TooltipTrigger asChild>
                                                    <Icon name="information" className="h-3.5 w-3.5 cursor-help text-muted-foreground/60" />
                                                </TooltipTrigger>
                                                <TooltipContent sideOffset={8} className="max-w-xs">
                                                    {t('settings.openchamber.visual.field.showSplitAssistantMessageActionsTooltip')}
                                                </TooltipContent>
                                            </Tooltip>
                                        )}
                                    />
                                )}

                                {shouldShow('codeBlockLineWrap') && (
                                    <SettingsCheckboxRow
                                        checked={codeBlockLineWrap}
                                        onChange={setCodeBlockLineWrap}
                                        label={t('settings.openchamber.visual.field.codeBlockLineWrap')}
                                        ariaLabel={t('settings.openchamber.visual.field.codeBlockLineWrapAria')}
                                        settingsItem="chat.code-block-line-wrap"
                                    />
                                )}

                                {shouldShow('showToolFileIcons') && (
                                    <SettingsCheckboxRow
                                        checked={showToolFileIcons}
                                        onChange={handleShowToolFileIconsChange}
                                        label={t('settings.openchamber.visual.field.showToolFileIcons')}
                                        ariaLabel={t('settings.openchamber.visual.field.showToolFileIconsAria')}
                                        settingsItem="chat.tool-file-icons"
                                    />
                                )}

                                {shouldShow('showTurnChangedFiles') && (
                                    <SettingsCheckboxRow
                                        checked={showTurnChangedFiles}
                                        onChange={handleShowTurnChangedFilesChange}
                                        label={t('settings.openchamber.visual.field.showTurnChangedFiles')}
                                        ariaLabel={t('settings.openchamber.visual.field.showTurnChangedFilesAria')}
                                        settingsItem="chat.changed-files"
                                    />
                                )}

                                {shouldShow('dotfiles') && !isVSCodeRuntime() && (
                                    <SettingsCheckboxRow
                                        checked={directoryShowHidden}
                                        onChange={setDirectoryShowHidden}
                                        label={t('settings.openchamber.visual.field.showDotfiles')}
                                        ariaLabel={t('settings.openchamber.visual.field.showDotfilesAria')}
                                        settingsItem="chat.dotfiles"
                                    />
                                )}

                                {shouldShow('fileViewerPreview') && (
                                    <SettingsCheckboxRow
                                        checked={settingsDefaultFileViewerPreview}
                                        onChange={handleFileViewerPreviewChange}
                                        label={t('settings.openchamber.defaults.field.openFilesPreview')}
                                        ariaLabel={t('settings.openchamber.defaults.field.openFilesPreviewAria')}
                                    />
                                )}

                                {shouldShow('persistDraft') && (
                                    <SettingsCheckboxRow
                                        checked={persistChatDraft}
                                        onChange={setPersistChatDraft}
                                        label={t('settings.openchamber.visual.field.persistDraftMessages')}
                                        ariaLabel={t('settings.openchamber.visual.field.persistDraftMessagesAria')}
                                        settingsItem="chat.persist-drafts"
                                    />
                                )}

                                {!isMobile && shouldShow('inputSpellcheck') && (
                                    <SettingsCheckboxRow
                                        checked={inputSpellcheckEnabled}
                                        onChange={handleInputSpellcheckChange}
                                        label={t('settings.openchamber.visual.field.enableSpellcheckInTextInputs')}
                                        ariaLabel={t('settings.openchamber.visual.field.enableSpellcheckInTextInputsAria')}
                                        settingsItem="chat.spellcheck"
                                    />
                                )}
                            </SettingsSection>
                        )}
                    </>
                )}

                {/* --- Privacy & Data --- */}
                {shouldShow('reportUsage') && (
                    <SettingsSection title={t('settings.openchamber.visual.section.privacy')}>
                        <SettingsCheckboxRow
                            checked={reportUsage}
                            onChange={handleReportUsageChange}
                            label={t('settings.openchamber.visual.field.sendAnonymousUsageReports')}
                            description={t('settings.openchamber.visual.field.sendAnonymousUsageReportsHint')}
                            ariaLabel={t('settings.openchamber.visual.field.sendAnonymousUsageReportsAria')}
                            settingsItem="appearance.usage-reports"
                        />
                    </SettingsSection>
                )}

            </div>
    );
};
