import React from 'react';
import { RiRestartLine, RiInformationLine } from '@remixicon/react';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import type { ThemeMode } from '@/types/theme';
import { useUIStore } from '@/stores/useUIStore';
import { useMessageQueueStore } from '@/stores/messageQueueStore';
import { cn, getModifierLabel } from '@/lib/utils';
import { ButtonSmall } from '@/components/ui/button-small';
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
import { isVSCodeRuntime, isWebRuntime } from '@/lib/desktop';
import { useDeviceInfo } from '@/lib/device';
import { usePwaDetection } from '@/hooks/usePwaDetection';
import { updateDesktopSettings } from '@/lib/persistence';
import {
    setDirectoryShowHidden,
    useDirectoryShowHidden,
} from '@/lib/directoryShowHidden';

interface Option<T extends string> {
    id: T;
    label: string;
    description?: string;
}

const THEME_MODE_OPTIONS: Array<{ value: ThemeMode; label: string }> = [
    {
        value: 'system',
        label: 'System',
    },
    {
        value: 'light',
        label: 'Light',
    },
    {
        value: 'dark',
        label: 'Dark',
    },
];

const TOOL_EXPANSION_OPTIONS: Array<{ value: 'collapsed' | 'activity' | 'detailed' | 'changes'; label: string; description: string }> = [
    { value: 'collapsed', label: 'Collapsed', description: 'Activity and tool calls stay collapsed by default.' },
    { value: 'activity', label: 'Summary', description: 'Activity opens by default; tool calls stay collapsed.' },
    { value: 'detailed', label: 'Detailed', description: 'Activity opens; key tools auto-expand for richer detail.' },
    { value: 'changes', label: 'Changes', description: 'Activity opens; only edit/write/patch tools auto-expand.' },
];

const DIFF_LAYOUT_OPTIONS: Option<'dynamic' | 'inline' | 'side-by-side'>[] = [
    {
        id: 'dynamic',
        label: 'Dynamic',
        description: 'New inline, modified side-by-side.',
    },
    {
        id: 'inline',
        label: 'Always inline',
        description: 'Show as a single unified view.',
    },
    {
        id: 'side-by-side',
        label: 'Always side-by-side',
        description: 'Compare original and modified files.',
    },
];

const DIFF_VIEW_MODE_OPTIONS: Option<'single' | 'stacked'>[] = [
    {
        id: 'single',
        label: 'Single file',
        description: 'Show one file at a time.',
    },
    {
        id: 'stacked',
        label: 'All files',
        description: 'Stack all changed files together.',
    },
];

const MERMAID_RENDERING_OPTIONS: Option<'svg' | 'ascii'>[] = [
    {
        id: 'svg',
        label: 'SVG',
        description: 'Render diagrams as scalable graphics.',
    },
    {
        id: 'ascii',
        label: 'ASCII',
        description: 'Render diagrams as text blocks.',
    },
];

const DEFAULT_PWA_INSTALL_NAME = 'OpenChamber - AI Coding Assistant';

type PwaInstallNameWindow = Window & {
    __OPENCHAMBER_SET_PWA_INSTALL_NAME__?: (value: string) => string;
    __OPENCHAMBER_UPDATE_PWA_MANIFEST__?: () => void;
};

const USER_MESSAGE_RENDERING_OPTIONS: Option<'markdown' | 'plain'>[] = [
    {
        id: 'markdown',
        label: 'Markdown',
        description: 'Render user text with markdown formatting.',
    },
    {
        id: 'plain',
        label: 'Plain text',
        description: 'Render user text with preserved whitespace and links.',
    },
];

const normalizeUserMessageRenderingMode = (mode: unknown): 'markdown' | 'plain' => {
    return mode === 'markdown' ? 'markdown' : 'plain';
};

export type VisibleSetting = 'theme' | 'pwaInstallName' | 'fontSize' | 'terminalFontSize' | 'spacing' | 'cornerRadius' | 'inputBarOffset' | 'navRail' | 'toolOutput' | 'mermaidRendering' | 'userMessageRendering' | 'stickyUserHeader' | 'diffLayout' | 'mobileStatusBar' | 'dotfiles' | 'reasoning' | 'queueMode' | 'textJustificationActivity' | 'activityHeaderTimestamps' | 'terminalQuickKeys' | 'persistDraft' | 'chatInputSpellcheck';

interface OpenChamberVisualSettingsProps {
    /** Which settings to show. If undefined, shows all. */
    visibleSettings?: VisibleSetting[];
}

export const OpenChamberVisualSettings: React.FC<OpenChamberVisualSettingsProps> = ({ visibleSettings }) => {
    const { isMobile } = useDeviceInfo();
    const { browserTab } = usePwaDetection();
    const directoryShowHidden = useDirectoryShowHidden();
    const showReasoningTraces = useUIStore(state => state.showReasoningTraces);
    const setShowReasoningTraces = useUIStore(state => state.setShowReasoningTraces);
    const showTextJustificationActivity = useUIStore(state => state.showTextJustificationActivity);
    const setShowTextJustificationActivity = useUIStore(state => state.setShowTextJustificationActivity);
    const showActivityHeaderTimestamps = useUIStore(state => state.showActivityHeaderTimestamps);
    const setShowActivityHeaderTimestamps = useUIStore(state => state.setShowActivityHeaderTimestamps);
    const toolCallExpansion = useUIStore(state => state.toolCallExpansion);
    const setToolCallExpansion = useUIStore(state => state.setToolCallExpansion);
    const mermaidRenderingMode = useUIStore(state => state.mermaidRenderingMode);
    const setMermaidRenderingMode = useUIStore(state => state.setMermaidRenderingMode);
    const userMessageRenderingMode = useUIStore(state => state.userMessageRenderingMode);
    const setUserMessageRenderingMode = useUIStore(state => state.setUserMessageRenderingMode);
    const stickyUserHeader = useUIStore(state => state.stickyUserHeader);
    const setStickyUserHeader = useUIStore(state => state.setStickyUserHeader);
    const fontSize = useUIStore(state => state.fontSize);
    const setFontSize = useUIStore(state => state.setFontSize);
    const terminalFontSize = useUIStore(state => state.terminalFontSize);
    const setTerminalFontSize = useUIStore(state => state.setTerminalFontSize);
    const padding = useUIStore(state => state.padding);
    const setPadding = useUIStore(state => state.setPadding);
    const cornerRadius = useUIStore(state => state.cornerRadius);
    const setCornerRadius = useUIStore(state => state.setCornerRadius);
    const inputBarOffset = useUIStore(state => state.inputBarOffset);
    const setInputBarOffset = useUIStore(state => state.setInputBarOffset);
    const diffLayoutPreference = useUIStore(state => state.diffLayoutPreference);
    const setDiffLayoutPreference = useUIStore(state => state.setDiffLayoutPreference);
    const diffViewMode = useUIStore(state => state.diffViewMode);
    const setDiffViewMode = useUIStore(state => state.setDiffViewMode);
    const showTerminalQuickKeysOnDesktop = useUIStore(state => state.showTerminalQuickKeysOnDesktop);
    const setShowTerminalQuickKeysOnDesktop = useUIStore(state => state.setShowTerminalQuickKeysOnDesktop);
    const queueModeEnabled = useMessageQueueStore(state => state.queueModeEnabled);
    const setQueueMode = useMessageQueueStore(state => state.setQueueMode);
    const persistChatDraft = useUIStore(state => state.persistChatDraft);
    const setPersistChatDraft = useUIStore(state => state.setPersistChatDraft);
    const chatInputSpellcheckEnabled = useUIStore(state => state.chatInputSpellcheckEnabled);
    const setChatInputSpellcheckEnabled = useUIStore(state => state.setChatInputSpellcheckEnabled);
    const isNavRailExpanded = useUIStore(state => state.isNavRailExpanded);
    const setNavRailExpanded = useUIStore(state => state.setNavRailExpanded);
    const showMobileSessionStatusBar = useUIStore(state => state.showMobileSessionStatusBar);
    const setShowMobileSessionStatusBar = useUIStore(state => state.setShowMobileSessionStatusBar);
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
    const handleUserMessageRenderingModeChange = React.useCallback((mode: 'markdown' | 'plain') => {
        setUserMessageRenderingMode(mode);
        void updateDesktopSettings({ userMessageRenderingMode: mode });
    }, [setUserMessageRenderingMode]);

    const handleStickyUserHeaderChange = React.useCallback((enabled: boolean) => {
        setStickyUserHeader(enabled);
        void updateDesktopSettings({ stickyUserHeader: enabled });
    }, [setStickyUserHeader]);

    const handleChatInputSpellcheckChange = React.useCallback((enabled: boolean) => {
        setChatInputSpellcheckEnabled(enabled);
        void updateDesktopSettings({ chatInputSpellcheckEnabled: enabled });
    }, [setChatInputSpellcheckEnabled]);

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
    const hasAppearanceSettings = (shouldShow('theme') || shouldShow('pwaInstallName')) && !isVSCode;
    const hasLayoutSettings = shouldShow('fontSize') || shouldShow('terminalFontSize') || shouldShow('spacing') || shouldShow('cornerRadius') || shouldShow('inputBarOffset');
    const hasNavigationSettings = (!isMobile && shouldShow('navRail')) || (shouldShow('terminalQuickKeys') && !isMobile);
    const hasBehaviorSettings = shouldShow('toolOutput')
        || shouldShow('mermaidRendering')
        || shouldShow('userMessageRendering')
        || shouldShow('stickyUserHeader')
        || shouldShow('diffLayout')
        || (shouldShow('mobileStatusBar') && isMobile)
        || shouldShow('dotfiles')
        || shouldShow('reasoning')
        || shouldShow('queueMode')
        || shouldShow('textJustificationActivity')
        || shouldShow('activityHeaderTimestamps')
        || shouldShow('persistDraft')
        || shouldShow('chatInputSpellcheck');
    const selectedToolExpansionOption = TOOL_EXPANSION_OPTIONS.find((option) => option.value === toolCallExpansion);

    const showPwaInstallNameSetting = shouldShow('pwaInstallName') && isWebRuntime() && browserTab;
    const [pwaInstallName, setPwaInstallName] = React.useState('');

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

    React.useEffect(() => {
        if (typeof window === 'undefined' || !showPwaInstallNameSetting) {
            return;
        }

        let cancelled = false;

        const loadPwaInstallName = async () => {
            try {
                const response = await fetch('/api/config/settings', {
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

                if (!cancelled) {
                    setPwaInstallName(normalized || DEFAULT_PWA_INSTALL_NAME);
                }
            } catch {
                if (!cancelled) {
                    setPwaInstallName(DEFAULT_PWA_INSTALL_NAME);
                }
            }
        };

        void loadPwaInstallName();

        return () => {
            cancelled = true;
        };
    }, [showPwaInstallNameSetting]);

    return (
        <div className="space-y-8">

                {/* --- Appearance & Themes --- */}
                {hasAppearanceSettings && (
                    <div className="mb-8 space-y-3">
                        <section className="px-2 pb-2 pt-0 space-y-0.5">

                            <div className="pb-1.5">
                                <div className="flex min-w-0 flex-col gap-1.5">
                                    <span className="typography-ui-header font-medium text-foreground">Color Mode</span>
                                    <div className="flex flex-wrap items-center gap-1">
                                        {THEME_MODE_OPTIONS.map((option) => (
                                            <ButtonSmall
                                                key={option.value}
                                                variant="outline"
                                                size="xs"
                                                className={cn(
                                                    '!font-normal',
                                                    themeMode === option.value
                                                        ? 'border-[var(--primary-base)] text-[var(--primary-base)] bg-[var(--primary-base)]/10 hover:text-[var(--primary-base)]'
                                                        : 'text-foreground'
                                                )}
                                                onClick={() => setThemeMode(option.value)}
                                            >
                                                {option.label}
                                            </ButtonSmall>
                                        ))}
                                    </div>
                                </div>
                            </div>

                            <div className="mt-2 grid grid-cols-1 gap-2 py-1.5 md:grid-cols-[14rem_auto] md:gap-x-8 md:gap-y-2">
                                <div className="flex min-w-0 items-center gap-2">
                                    <span className="typography-ui-label text-foreground shrink-0">Light Theme</span>
                                    <Select value={selectedLightTheme?.metadata.id ?? ''} onValueChange={setLightThemePreference}>
                                        <SelectTrigger aria-label="Select light theme" className="w-fit">
                                            <SelectValue placeholder="Select theme" />
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
                                <div className="flex min-w-0 items-center gap-2">
                                    <span className="typography-ui-label text-foreground shrink-0">Dark Theme</span>
                                    <Select value={selectedDarkTheme?.metadata.id ?? ''} onValueChange={setDarkThemePreference}>
                                        <SelectTrigger aria-label="Select dark theme" className="w-fit">
                                            <SelectValue placeholder="Select theme" />
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
                                    {themesReloading ? 'Reloading themes...' : 'Reload themes'}
                                </button>
                                <Tooltip delayDuration={700}>
                                    <TooltipTrigger asChild>
                                        <button
                                            type="button"
                                            className="flex items-center justify-center rounded-md p-1 text-muted-foreground/70 hover:text-foreground"
                                            aria-label="Theme import info"
                                        >
                                            <RiInformationLine className="h-3.5 w-3.5" />
                                        </button>
                                    </TooltipTrigger>
                                    <TooltipContent sideOffset={8}>
                                        Import custom themes from ~/.config/openchamber/themes/
                                    </TooltipContent>
                                </Tooltip>
                            </div>

                            {showPwaInstallNameSetting && (
                                <div className={cn('py-1.5', isMobile ? 'space-y-2' : 'flex items-center gap-8')}>
                                    <div className={cn('flex min-w-0 flex-col', isMobile ? 'w-full' : 'w-56 shrink-0')}>
                                        <span className="typography-ui-label text-foreground">Install App Name</span>
                                        <span className="typography-meta text-muted-foreground">Used by PWA installation process.</span>
                                    </div>
                                    <div className={cn('flex items-center gap-2', isMobile ? 'w-full' : 'w-fit min-w-[22rem]')}>
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
                                            aria-label="PWA install app name"
                                        />
                                        <ButtonSmall
                                            type="button"
                                            variant="ghost"
                                            onClick={() => {
                                                setPwaInstallName(DEFAULT_PWA_INSTALL_NAME);
                                                void applyPwaInstallName('');
                                            }}
                                            className="h-7 w-7 px-0 text-muted-foreground hover:text-foreground"
                                            aria-label="Reset install app name"
                                            title="Reset"
                                        >
                                            <RiRestartLine className="h-3.5 w-3.5" />
                                        </ButtonSmall>
                                    </div>
                                </div>
                            )}
                        </section>
                    </div>
                )}

                {/* --- UI Scaling & Layout --- */}
                {hasLayoutSettings && (
                    <div className="mb-8 space-y-3">
                        <section className="p-2 space-y-0.5">
                            <h4 className="typography-ui-header font-medium text-foreground">Spacing & Layout</h4>
                            <div className="pl-2">

                            {shouldShow('fontSize') && !isMobile && (
                                <div className="flex items-center gap-8 py-1">
                                    <div className="flex min-w-0 flex-col w-56 shrink-0">
                                        <span className="typography-ui-label text-foreground">Interface Font Size</span>
                                    </div>
                                    <div className="flex items-center gap-2 w-fit">
                                        <NumberInput
                                            value={fontSize}
                                            onValueChange={setFontSize}
                                            min={50}
                                            max={200}
                                            step={5}
                                            aria-label="Font size percentage"
                                            className="w-16"
                                        />
                                        <ButtonSmall
                                            type="button"
                                            variant="ghost"
                                            onClick={() => setFontSize(100)}
                                            disabled={fontSize === 100}
                                            className="h-7 w-7 px-0 text-muted-foreground hover:text-foreground"
                                            aria-label="Reset font size"
                                            title="Reset"
                                        >
                                            <RiRestartLine className="h-3.5 w-3.5" />
                                        </ButtonSmall>
                                    </div>
                                </div>
                            )}

                            {shouldShow('terminalFontSize') && (
                                <div className={cn("py-1", isMobile ? "flex flex-col gap-3" : "flex items-center gap-8")}>
                                    <div className={cn("flex min-w-0 flex-col", isMobile ? "w-full" : "w-56 shrink-0")}>
                                        <span className="typography-ui-label text-foreground">Terminal Font Size</span>
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
                                        <ButtonSmall
                                            type="button"
                                            variant="ghost"
                                            onClick={() => setTerminalFontSize(13)}
                                            disabled={terminalFontSize === 13}
                                            className="h-7 w-7 px-0 text-muted-foreground hover:text-foreground"
                                            aria-label="Reset terminal font size"
                                            title="Reset"
                                        >
                                            <RiRestartLine className="h-3.5 w-3.5" />
                                        </ButtonSmall>
                                    </div>
                                </div>
                            )}

                            {shouldShow('spacing') && (
                                <div className={cn("py-1", isMobile ? "flex flex-col gap-3" : "flex items-center gap-8")}>
                                    <div className={cn("flex min-w-0 flex-col", isMobile ? "w-full" : "w-56 shrink-0")}>
                                        <span className="typography-ui-label text-foreground">Spacing Density</span>
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
                                        <ButtonSmall
                                            type="button"
                                            variant="ghost"
                                            onClick={() => setPadding(100)}
                                            disabled={padding === 100}
                                            className="h-7 w-7 px-0 text-muted-foreground hover:text-foreground"
                                            aria-label="Reset spacing"
                                            title="Reset"
                                        >
                                            <RiRestartLine className="h-3.5 w-3.5" />
                                        </ButtonSmall>
                                    </div>
                                </div>
                            )}

                            {shouldShow('cornerRadius') && (
                                <div className={cn("py-1", isMobile ? "flex flex-col gap-3" : "flex items-center gap-8")}>
                                    <div className={cn("flex min-w-0 flex-col", isMobile ? "w-full" : "w-56 shrink-0")}>
                                        <span className="typography-ui-label text-foreground">Corner Radius</span>
                                    </div>
                                    <div className={cn("flex items-center gap-2", isMobile ? "w-full" : "w-fit")}>
                                        <NumberInput
                                            value={cornerRadius}
                                            onValueChange={setCornerRadius}
                                            min={0}
                                            max={32}
                                            step={1}
                                            className="w-16"
                                        />
                                        <ButtonSmall
                                            type="button"
                                            variant="ghost"
                                            onClick={() => setCornerRadius(12)}
                                            disabled={cornerRadius === 12}
                                            className="h-7 w-7 px-0 text-muted-foreground hover:text-foreground"
                                            aria-label="Reset corner radius"
                                            title="Reset"
                                        >
                                            <RiRestartLine className="h-3.5 w-3.5" />
                                        </ButtonSmall>
                                    </div>
                                </div>
                            )}

                            {shouldShow('inputBarOffset') && (
                                <div className={cn("py-1", isMobile ? "flex flex-col gap-3" : "flex items-center gap-8")}>
                                    <div className={cn("flex min-w-0 flex-col", isMobile ? "w-full" : "w-56 shrink-0")}>
                                        <div className="flex items-center gap-1.5">
                                            <span className="typography-ui-label text-foreground">Input Bar Offset</span>
                                            <Tooltip delayDuration={1000}>
                                                <TooltipTrigger asChild>
                                                    <RiInformationLine className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
                                                </TooltipTrigger>
                                                <TooltipContent sideOffset={8} className="max-w-xs">
                                                    Raise input bar to avoid OS-level screen obstructions like home bars.
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
                                        <ButtonSmall
                                            type="button"
                                            variant="ghost"
                                            onClick={() => setInputBarOffset(0)}
                                            disabled={inputBarOffset === 0}
                                            className="h-7 w-7 px-0 text-muted-foreground hover:text-foreground"
                                            aria-label="Reset input bar offset"
                                            title="Reset"
                                        >
                                            <RiRestartLine className="h-3.5 w-3.5" />
                                        </ButtonSmall>
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
                            <h4 className="typography-ui-header font-medium text-foreground">Navigation</h4>
                            {shouldShow('navRail') && !isMobile && (
                                <div
                                    className="group mt-1.5 flex cursor-pointer items-center gap-2 py-1.5"
                                    role="button"
                                    tabIndex={0}
                                    onClick={() => setNavRailExpanded(!isNavRailExpanded)}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter' || e.key === ' ') {
                                            e.preventDefault();
                                            setNavRailExpanded(!isNavRailExpanded);
                                        }
                                    }}
                                >
                                    <Checkbox
                                        checked={isNavRailExpanded}
                                        onChange={setNavRailExpanded}
                                        ariaLabel="Expand project rail by default"
                                    />
                                    <div className="flex min-w-0 items-center gap-1.5">
                                        <span className="typography-ui-label text-foreground">Expand project rail</span>
                                        <Tooltip delayDuration={1000}>
                                            <TooltipTrigger asChild>
                                                <RiInformationLine className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
                                            </TooltipTrigger>
                                            <TooltipContent sideOffset={8} className="max-w-xs">
                                                Show project names in the left rail when multiple projects are open. Auto-collapses with a single project.
                                            </TooltipContent>
                                        </Tooltip>
                                    </div>
                                </div>
                            )}

                            {shouldShow('terminalQuickKeys') && !isMobile && (
                                <div
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
                                        ariaLabel="Terminal quick keys"
                                    />
                                    <div className="flex min-w-0 items-center gap-1.5">
                                        <span className="typography-ui-label text-foreground">Terminal Quick Keys</span>
                                        <Tooltip delayDuration={1000}>
                                            <TooltipTrigger asChild>
                                                <RiInformationLine className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
                                            </TooltipTrigger>
                                            <TooltipContent sideOffset={8} className="max-w-xs">
                                                Show Esc, Ctrl, Arrows in terminal view
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

                            {shouldShow('toolOutput') && (
                                <section className="px-2 pb-2 pt-0">
                                    <h4 className="typography-ui-header font-medium text-foreground">Default Tool Output</h4>
                                    <div className="mt-1.5 flex flex-wrap items-center gap-1">
                                        {TOOL_EXPANSION_OPTIONS.map((option) => {
                                            return (
                                                <ButtonSmall
                                                    key={option.value}
                                                    type="button"
                                                    variant="outline"
                                                    size="xs"
                                                    className={cn(
                                                        '!font-normal',
                                                        toolCallExpansion === option.value
                                                            ? 'border-[var(--primary-base)] text-[var(--primary-base)] bg-[var(--primary-base)]/10 hover:text-[var(--primary-base)]'
                                                            : 'text-foreground'
                                                    )}
                                                    onClick={() => setToolCallExpansion(option.value)}
                                                >
                                                    {option.label}
                                                </ButtonSmall>
                                            );
                                        })}
                                    </div>
                                    {selectedToolExpansionOption && (
                                        <p className="mt-2 typography-ui-label font-normal text-muted-foreground">
                                            {selectedToolExpansionOption.description}
                                        </p>
                                    )}
                                </section>
                            )}

                            {(shouldShow('userMessageRendering') || shouldShow('mermaidRendering') || (shouldShow('diffLayout') && !isVSCode)) && (
                                <div className="grid grid-cols-1 gap-y-2 md:grid-cols-[minmax(0,16rem)_minmax(0,16rem)] md:justify-start md:gap-x-2">
                                    {shouldShow('userMessageRendering') && (
                                        <section className="p-2">
                                            <h4 className="typography-ui-header font-medium text-foreground">User Message Rendering</h4>
                                            <div role="radiogroup" aria-label="User message rendering mode" className="mt-1 space-y-0">
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
                                                            className="flex w-full items-center gap-2 py-0.5 text-left"
                                                        >
                                                            <Radio
                                                                checked={selected}
                                                                onChange={() => handleUserMessageRenderingModeChange(option.id)}
                                                                ariaLabel={`User message rendering: ${option.label}`}
                                                            />
                                                            <span className={cn('typography-ui-label font-normal', selected ? 'text-foreground' : 'text-foreground/50')}>
                                                                {option.label}
                                                            </span>
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        </section>
                                    )}

                                    {shouldShow('mermaidRendering') && (
                                        <section className="p-2">
                                            <h4 className="typography-ui-header font-medium text-foreground">Mermaid Rendering</h4>
                                            <div role="radiogroup" aria-label="Mermaid rendering mode" className="mt-1 space-y-0">
                                                {MERMAID_RENDERING_OPTIONS.map((option) => {
                                                    const selected = mermaidRenderingMode === option.id;
                                                    return (
                                                        <div
                                                            key={option.id}
                                                            role="button"
                                                            tabIndex={0}
                                                            aria-pressed={selected}
                                                            onClick={() => setMermaidRenderingMode(option.id)}
                                                            onKeyDown={(event) => {
                                                                if (event.key === ' ' || event.key === 'Enter') {
                                                                    event.preventDefault();
                                                                    setMermaidRenderingMode(option.id);
                                                                }
                                                            }}
                                                            className="flex w-full items-center gap-2 py-0.5 text-left"
                                                        >
                                                            <Radio
                                                                checked={selected}
                                                                onChange={() => setMermaidRenderingMode(option.id)}
                                                                ariaLabel={`Mermaid rendering: ${option.label}`}
                                                            />
                                                            <span className={cn('typography-ui-label font-normal', selected ? 'text-foreground' : 'text-foreground/50')}>
                                                                {option.label}
                                                            </span>
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        </section>
                                    )}

                                    {shouldShow('diffLayout') && !isVSCode && (
                                        <section className="p-2">
                                            <h4 className="typography-ui-header font-medium text-foreground">Diff Layout</h4>
                                            <div role="radiogroup" aria-label="Diff layout" className="mt-1 space-y-0">
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
                                                            className="flex w-full items-center gap-2 py-0.5 text-left"
                                                        >
                                                            <Radio
                                                                checked={selected}
                                                                onChange={() => setDiffLayoutPreference(option.id)}
                                                                ariaLabel={`Diff layout: ${option.label}`}
                                                            />
                                                            <span className={cn('typography-ui-label font-normal', selected ? 'text-foreground' : 'text-foreground/50')}>
                                                                {option.label}
                                                            </span>
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        </section>
                                    )}

                                    {shouldShow('diffLayout') && !isVSCode && (
                                        <section className="p-2">
                                            <h4 className="typography-ui-header font-medium text-foreground">Diff View Mode</h4>
                                            <div role="radiogroup" aria-label="Diff view mode" className="mt-1 space-y-0">
                                                {DIFF_VIEW_MODE_OPTIONS.map((option) => {
                                                    const selected = diffViewMode === option.id;
                                                    return (
                                                        <div
                                                            key={option.id}
                                                            role="button"
                                                            tabIndex={0}
                                                            aria-pressed={selected}
                                                            onClick={() => setDiffViewMode(option.id)}
                                                            onKeyDown={(event) => {
                                                                if (event.key === ' ' || event.key === 'Enter') {
                                                                    event.preventDefault();
                                                                    setDiffViewMode(option.id);
                                                                }
                                                            }}
                                                            className="flex w-full items-center gap-2 py-0.5 text-left"
                                                        >
                                                            <Radio
                                                                checked={selected}
                                                                onChange={() => setDiffViewMode(option.id)}
                                                                ariaLabel={`Diff view mode: ${option.label}`}
                                                            />
                                                            <span className={cn('typography-ui-label font-normal', selected ? 'text-foreground' : 'text-foreground/50')}>
                                                                {option.label}
                                                            </span>
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        </section>
                                    )}
                                </div>
                            )}

                            {(shouldShow('stickyUserHeader') || (shouldShow('mobileStatusBar') && isMobile) || shouldShow('dotfiles') || shouldShow('queueMode') || shouldShow('persistDraft') || shouldShow('chatInputSpellcheck') || shouldShow('reasoning') || shouldShow('textJustificationActivity')) && (
                                <section className="p-2 space-y-0.5">
                                    {shouldShow('stickyUserHeader') && (
                                        <div
                                            className="group flex cursor-pointer items-center gap-2 py-1.5"
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
                                                ariaLabel="Sticky user header"
                                            />
                                            <span className="typography-ui-label text-foreground">Sticky User Header</span>
                                        </div>
                                    )}

                                    {shouldShow('mobileStatusBar') && isMobile && (
                                        <div
                                            className="group flex cursor-pointer items-center gap-2 py-1.5"
                                            role="button"
                                            tabIndex={0}
                                            aria-pressed={showMobileSessionStatusBar}
                                            onClick={() => setShowMobileSessionStatusBar(!showMobileSessionStatusBar)}
                                            onKeyDown={(event) => {
                                                if (event.key === ' ' || event.key === 'Enter') {
                                                    event.preventDefault();
                                                    setShowMobileSessionStatusBar(!showMobileSessionStatusBar);
                                                }
                                            }}
                                        >
                                            <Checkbox
                                                checked={showMobileSessionStatusBar}
                                                onChange={setShowMobileSessionStatusBar}
                                                ariaLabel="Show mobile status bar"
                                            />
                                            <span className="typography-ui-label text-foreground">Show Mobile Status Bar</span>
                                        </div>
                                    )}

                                    {shouldShow('dotfiles') && !isVSCodeRuntime() && (
                                        <div
                                            className="group flex cursor-pointer items-center gap-2 py-1.5"
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
                                                ariaLabel="Show dotfiles"
                                            />
                                            <span className="typography-ui-label text-foreground">Show Dotfiles</span>
                                        </div>
                                    )}

                                    {shouldShow('queueMode') && (
                                        <div
                                            className="group flex cursor-pointer items-center gap-2 py-1.5"
                                            role="button"
                                            tabIndex={0}
                                            aria-pressed={queueModeEnabled}
                                            onClick={() => setQueueMode(!queueModeEnabled)}
                                            onKeyDown={(event) => {
                                                if (event.key === ' ' || event.key === 'Enter') {
                                                    event.preventDefault();
                                                    setQueueMode(!queueModeEnabled);
                                                }
                                            }}
                                        >
                                            <Checkbox
                                                checked={queueModeEnabled}
                                                onChange={setQueueMode}
                                                ariaLabel="Queue messages by default"
                                            />
                                            <div className="flex min-w-0 items-center gap-1.5">
                                                <span className="typography-ui-label text-foreground">Queue Messages by Default</span>
                                                <Tooltip delayDuration={1000}>
                                                    <TooltipTrigger asChild>
                                                        <RiInformationLine className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
                                                    </TooltipTrigger>
                                                    <TooltipContent sideOffset={8} className="max-w-xs">
                                                        When enabled, Enter queues messages. Use {getModifierLabel()}+Enter to send.
                                                    </TooltipContent>
                                                </Tooltip>
                                            </div>
                                        </div>
                                    )}

                                    {shouldShow('persistDraft') && (
                                        <div
                                            className="group flex cursor-pointer items-center gap-2 py-1.5"
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
                                                ariaLabel="Persist draft messages"
                                            />
                                            <span className="typography-ui-label text-foreground">Persist Draft Messages</span>
                                        </div>
                                    )}

                                    {shouldShow('chatInputSpellcheck') && (
                                        <div
                                            className="group flex cursor-pointer items-center gap-2 py-1.5"
                                            role="button"
                                            tabIndex={0}
                                            aria-pressed={chatInputSpellcheckEnabled}
                                            onClick={() => handleChatInputSpellcheckChange(!chatInputSpellcheckEnabled)}
                                            onKeyDown={(event) => {
                                                if (event.key === ' ' || event.key === 'Enter') {
                                                    event.preventDefault();
                                                    handleChatInputSpellcheckChange(!chatInputSpellcheckEnabled);
                                                }
                                            }}
                                        >
                                            <Checkbox
                                                checked={chatInputSpellcheckEnabled}
                                                onChange={handleChatInputSpellcheckChange}
                                                ariaLabel="Enable spellcheck in text inputs"
                                            />
                                            <span className="typography-ui-label text-foreground">Enable Spellcheck in Text Inputs</span>
                                        </div>
                                    )}

                                    {shouldShow('reasoning') && (
                                        <div
                                            className="group flex cursor-pointer items-center gap-2 py-1.5"
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
                                                ariaLabel="Show reasoning traces"
                                            />
                                            <span className="typography-ui-label text-foreground">Show Reasoning Traces</span>
                                        </div>
                                    )}

                                    {shouldShow('textJustificationActivity') && (
                                        <div
                                            className="group flex cursor-pointer items-center gap-2 py-1.5"
                                            role="button"
                                            tabIndex={0}
                                            aria-pressed={showTextJustificationActivity}
                                            onClick={() => setShowTextJustificationActivity(!showTextJustificationActivity)}
                                            onKeyDown={(event) => {
                                                if (event.key === ' ' || event.key === 'Enter') {
                                                    event.preventDefault();
                                                    setShowTextJustificationActivity(!showTextJustificationActivity);
                                                }
                                            }}
                                        >
                                            <Checkbox
                                                checked={showTextJustificationActivity}
                                                onChange={setShowTextJustificationActivity}
                                                ariaLabel="Show justification activity"
                                            />
                                            <span className="typography-ui-label text-foreground">Show Justification Activity</span>
                                        </div>
                                    )}

                                    {shouldShow('activityHeaderTimestamps') && (
                                        <div
                                            className="group flex cursor-pointer items-center gap-2 py-1.5"
                                            role="button"
                                            tabIndex={0}
                                            aria-pressed={showActivityHeaderTimestamps}
                                            onClick={() => setShowActivityHeaderTimestamps(!showActivityHeaderTimestamps)}
                                            onKeyDown={(event) => {
                                                if (event.key === ' ' || event.key === 'Enter') {
                                                    event.preventDefault();
                                                    setShowActivityHeaderTimestamps(!showActivityHeaderTimestamps);
                                                }
                                            }}
                                        >
                                            <Checkbox
                                                checked={showActivityHeaderTimestamps}
                                                onChange={setShowActivityHeaderTimestamps}
                                                ariaLabel="Show tool and reasoning header timestamps"
                                            />
                                            <span className="typography-ui-label text-foreground">Show Activity Header Timestamps</span>
                                        </div>
                                    )}
                                </section>
                            )}

                    </div>
                )}

            </div>
    );
};
