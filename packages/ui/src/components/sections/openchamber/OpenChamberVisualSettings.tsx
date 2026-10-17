import React from 'react';
import { ThemeImportButton } from './ThemeImportButton';
import { ThemePicker } from './ThemePicker';

import { useThemeSystem } from '@/contexts/useThemeSystem';
import type { ThemeMode } from '@/types/theme';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionDisplayStore } from '@/stores/useSessionDisplayStore';
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
import {
    isDesktopShell,
    isVSCodeRuntime,
    isWebRuntime,
    usesFramelessElectronChrome,
    type DesktopWindowControlsPosition,
    type DesktopWindowControlsStyle,
} from '@/lib/desktop';
import { useDeviceInfo } from '@/lib/device';
import { usePwaDetection } from '@/hooks/usePwaDetection';
import { loadDesktopSettings, updateDesktopSettings } from '@/lib/persistence';
import { CODE_FONT_OPTIONS, CUSTOM_FONT_ID, DEFAULT_MONO_FONT, DEFAULT_UI_FONT, UI_FONT_OPTIONS, type MonoFontOption, type UiFontOption } from '@/lib/fontOptions';
import { useI18n } from '@/lib/i18n';
import { useEnterpriseMode } from '@/stores/useEnterprisePolicyStore';
import { useFontPreferences } from '@/hooks/useFontPreferences';
import { normalizeMobileKeyboardMode, supportsMobileKeyboardResizeContent, type MobileKeyboardMode } from '@/lib/mobileKeyboardMode';
import {
    SettingsSection,
    SettingsTwoColumn,
    SettingsStackedField,
    SettingsFieldRow,
    SettingsInset,
    SettingsCheckboxRow,
    SettingsRadioGroup,
    SettingsRadioOption,
    SettingsChipGroup,
    SETTINGS_SELECT_TRIGGER_CLASS,
    SETTINGS_ICON_BUTTON_CLASS,
    SETTINGS_CONTROL_CLUSTER_CLASS,
    SETTINGS_CLUSTER_CONTROL_CLASS,
    SETTINGS_NUMBER_STEPPER_ROW_CLASS,
    SETTINGS_NUMBER_UNIT_CLASS,
    SETTINGS_NUMBER_INPUT_CLASS,
    SETTINGS_FIELDS_STACK_CLASS,
    SETTINGS_OPTION_STACK_CLASS,
    SETTINGS_HELPER_CLASS,
} from '@/components/sections/shared/SettingsSection';
import { SettingsInfoHint } from '@/components/sections/shared/SettingsInfoHint';

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

type PwaInstallNameWindow = Window & {
    __OPENCHAMBER_SET_PWA_INSTALL_NAME__?: (value: string) => string;
    __OPENCHAMBER_SET_PWA_ORIENTATION__?: (value: 'system' | 'portrait' | 'landscape') => 'system' | 'portrait' | 'landscape';
    __OPENCHAMBER_UPDATE_PWA_MANIFEST__?: () => void;
};

const normalizePwaOrientation = (value: unknown): 'system' | 'portrait' | 'landscape' => {
    return value === 'portrait' || value === 'landscape' ? value : 'system';
};

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

type VisibleSetting = 'theme' | 'windowControlsPosition' | 'pwaInstallName' | 'pwaOrientation' | 'mobileKeyboardMode' | 'timeFormat' | 'weekStart' | 'fontSize' | 'terminalFontSize' | 'editorFontSize' | 'spacing' | 'scrollbars' | 'inputBarOffset' | 'animatedActivityIndicators';

const WINDOW_CONTROLS_POSITION_OPTIONS: Array<{ id: DesktopWindowControlsPosition; labelKey: string }> = [
    { id: 'left', labelKey: 'settings.openchamber.desktopNetwork.option.windowControlsLeft' },
    { id: 'right', labelKey: 'settings.openchamber.desktopNetwork.option.windowControlsRight' },
];

const WINDOW_CONTROLS_STYLE_OPTIONS: Array<{ id: DesktopWindowControlsStyle; labelKey: string }> = [
    { id: 'classic', labelKey: 'settings.openchamber.desktopNetwork.option.windowControlsClassic' },
    { id: 'traffic-lights', labelKey: 'settings.openchamber.desktopNetwork.option.windowControlsTrafficLights' },
];

interface OpenChamberVisualSettingsProps {
    /** Which settings to show. If undefined, shows all. */
    visibleSettings?: VisibleSetting[];
}

export const OpenChamberVisualSettings: React.FC<OpenChamberVisualSettingsProps> = ({ visibleSettings }) => {
    const { locale, locales, setLocale, label, t } = useI18n();
    const tUnsafe = React.useCallback((key: string) => t(key as Parameters<typeof t>[0]), [t]);
    const { isMobile } = useDeviceInfo();
    const { browserTab } = usePwaDetection();
    const animatedActivityIndicators = useSessionDisplayStore((s) => s.animatedActivityIndicators);
    const setAnimatedActivityIndicators = useSessionDisplayStore((s) => s.setAnimatedActivityIndicators);

    const fontSize = useUIStore(state => state.fontSize);
    const setFontSize = useUIStore(state => state.setFontSize);
    const terminalFontSize = useUIStore(state => state.terminalFontSize);
    const setTerminalFontSize = useUIStore(state => state.setTerminalFontSize);
    const editorFontSize = useUIStore(state => state.editorFontSize);
    const setEditorFontSize = useUIStore(state => state.setEditorFontSize);
    // The fonts in effect: enterprise mode shows the system font where the
    // stored choice would load from a CDN (useFontPreferences).
    const { uiFont, monoFont } = useFontPreferences();
    const setUiFont = useUIStore(state => state.setUiFont);
    const setMonoFont = useUIStore(state => state.setMonoFont);
    const customUiFont = useUIStore(state => state.customUiFont);
    const customMonoFont = useUIStore(state => state.customMonoFont);
    const setCustomUiFont = useUIStore(state => state.setCustomUiFont);
    const setCustomMonoFont = useUIStore(state => state.setCustomMonoFont);
    const webFontsBlocked = useEnterpriseMode();
    const padding = useUIStore(state => state.padding);
    const setPadding = useUIStore(state => state.setPadding);
    const inputBarOffset = useUIStore(state => state.inputBarOffset);
    const setInputBarOffset = useUIStore(state => state.setInputBarOffset);
    const mobileKeyboardMode = useUIStore(state => state.mobileKeyboardMode);
    const setMobileKeyboardMode = useUIStore(state => state.setMobileKeyboardMode);
    const timeFormatPreference = useUIStore(state => state.timeFormatPreference);
    const setTimeFormatPreference = useUIStore(state => state.setTimeFormatPreference);
    const weekStartPreference = useUIStore(state => state.weekStartPreference);
    const setWeekStartPreference = useUIStore(state => state.setWeekStartPreference);
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
    const alwaysShowScrollbars = useUIStore(state => state.alwaysShowScrollbars === true);
    const setAlwaysShowScrollbars = useUIStore(state => state.setAlwaysShowScrollbars);
    const showWindowControlsPosition = usesFramelessElectronChrome();
    const desktopWindowControlsPosition = useUIStore((state) => state.desktopWindowControlsPosition);
    const setDesktopWindowControlsPosition = useUIStore((state) => state.setDesktopWindowControlsPosition);
    const desktopWindowControlsStyle = useUIStore((state) => state.desktopWindowControlsStyle);
    const setDesktopWindowControlsStyle = useUIStore((state) => state.setDesktopWindowControlsStyle);

    // The server copy lets the language survive lost browser storage and reach
    // the other clients of this instance.
    const handleLocaleChange = React.useCallback((value: string) => {
        const next = locales.find((candidate) => candidate === value);
        if (!next) return;
        setLocale(next);
        void updateDesktopSettings({ locale: next });
    }, [locales, setLocale]);

    const handleWindowControlsPositionChange = React.useCallback((value: DesktopWindowControlsPosition) => {
        setDesktopWindowControlsPosition(value);
        void updateDesktopSettings({ desktopWindowControlsPosition: value });
    }, [setDesktopWindowControlsPosition]);

    const handleWindowControlsStyleChange = React.useCallback((value: DesktopWindowControlsStyle) => {
        setDesktopWindowControlsStyle(value);
        void updateDesktopSettings({ desktopWindowControlsStyle: value });
    }, [setDesktopWindowControlsStyle]);


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

    const lightThemeOptions = React.useMemo(
        () => lightThemes.map((theme) => ({ id: theme.metadata.id, label: formatThemeLabel(theme.metadata.name, 'light') })),
        [lightThemes, formatThemeLabel],
    );

    const darkThemeOptions = React.useMemo(
        () => darkThemes.map((theme) => ({ id: theme.metadata.id, label: formatThemeLabel(theme.metadata.name, 'dark') })),
        [darkThemes, formatThemeLabel],
    );

    const shouldShow = (setting: VisibleSetting): boolean => {
        if (!visibleSettings) return true;
        return visibleSettings.includes(setting);
    };

    const isVSCode = isVSCodeRuntime();
    const hasThemeSettings = shouldShow('theme') && !isVSCode;
    const showWindowControlsPositionSetting = shouldShow('windowControlsPosition') && showWindowControlsPosition;
    const hasLocalizationSettings = shouldShow('theme') || shouldShow('timeFormat') || shouldShow('weekStart');
    const hasAppearanceSettings = isVSCode
        ? hasLocalizationSettings
        : (shouldShow('theme') || showWindowControlsPositionSetting || shouldShow('pwaInstallName') || shouldShow('pwaOrientation') || shouldShow('timeFormat') || shouldShow('weekStart'));
    const hasLayoutSettings = shouldShow('fontSize') || shouldShow('terminalFontSize') || shouldShow('editorFontSize') || shouldShow('spacing') || (shouldShow('scrollbars') && !hasThemeSettings) || (shouldShow('inputBarOffset') && isMobile);
    const showPwaInstallNameSetting = shouldShow('pwaInstallName') && isWebRuntime() && browserTab && !isDesktopShell() && !isVSCode;
    const showPwaOrientationSetting = shouldShow('pwaOrientation') && isWebRuntime() && !isDesktopShell() && !isVSCode;
    const showMobileKeyboardModeSetting = shouldShow('mobileKeyboardMode') && isWebRuntime() && !isDesktopShell() && !isVSCode && supportsMobileKeyboardResizeContent();
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
                const settings = await loadDesktopSettings();

                if (!settings) {
                    if (!cancelled) {
                        setPwaInstallName(DEFAULT_PWA_INSTALL_NAME);
                    }
                    return;
                }

                const raw = settings.pwaAppName ?? '';
                const normalized = raw.trim().replace(/\s+/g, ' ').slice(0, 64);
                const orientation = normalizePwaOrientation(settings.pwaOrientation);
                const nextMobileKeyboardMode = normalizeMobileKeyboardMode(settings.mobileKeyboardMode);

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

    const scrollbarSetting = shouldShow('scrollbars') ? (
        <SettingsCheckboxRow
            checked={alwaysShowScrollbars}
            onChange={setAlwaysShowScrollbars}
            label={t('settings.openchamber.visual.field.alwaysShowScrollbars')}
            info={t('settings.openchamber.visual.field.alwaysShowScrollbarsHint')}
            settingsItem="appearance.scrollbars"
        />
    ) : null;

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
                                                    ariaLabel={tUnsafe(option.labelKey)}
                                                />
                                            ))}
                                        </SettingsRadioGroup>

                                    </div>

                                    <div className={SETTINGS_FIELDS_STACK_CLASS}>
                                        <SettingsStackedField
                                            label={t('settings.openchamber.visual.field.lightTheme')}
                                            settingsItem="appearance.light-theme"
                                        >
                                            <ThemePicker
                                                options={lightThemeOptions}
                                                value={selectedLightTheme?.metadata.id ?? ''}
                                                onValueChange={setLightThemePreference}
                                                placeholder={t('settings.openchamber.visual.field.selectThemePlaceholder')}
                                                ariaLabel={t('settings.openchamber.visual.field.selectLightThemeAria')}
                                            />
                                        </SettingsStackedField>
                                        <SettingsStackedField
                                            label={t('settings.openchamber.visual.field.darkTheme')}
                                            settingsItem="appearance.dark-theme"
                                        >
                                            <ThemePicker
                                                options={darkThemeOptions}
                                                value={selectedDarkTheme?.metadata.id ?? ''}
                                                onValueChange={setDarkThemePreference}
                                                placeholder={t('settings.openchamber.visual.field.selectThemePlaceholder')}
                                                ariaLabel={t('settings.openchamber.visual.field.selectDarkThemeAria')}
                                            />
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
                                            <SettingsInfoHint>
                                                {t('settings.openchamber.visual.field.themeImportInfoTooltip')}
                                            </SettingsInfoHint>
                                        </div>
                                        <ThemeImportButton />
                                    </div>
                                </SettingsTwoColumn>

                                {dockBadgeSupported && (
                                    <SettingsInset settingsItem="appearance.dock-badge">
                                        <SettingsCheckboxRow
                                            checked={dockBadgeEnabled}
                                            onChange={setDockBadgeEnabled}
                                            label={t('settings.openchamber.visual.field.dockBadge')}
                                            info={t('settings.openchamber.visual.field.dockBadgeHint')}
                                            ariaLabel={t('settings.openchamber.visual.field.dockBadge')}
                                        />
                                    </SettingsInset>
                                )}
                                {scrollbarSetting && <SettingsInset>{scrollbarSetting}</SettingsInset>}
                            </SettingsSection>
                        )}

                        {showWindowControlsPositionSetting && (
                            <SettingsSection
                                title={t('settings.openchamber.desktopNetwork.field.windowControls')}
                                info={t('settings.openchamber.desktopNetwork.field.windowControlsPositionDescription')}
                                divider={hasThemeSettings}
                            >
                                <SettingsTwoColumn>
                                    <SettingsStackedField
                                        label={t('settings.openchamber.desktopNetwork.field.windowControlsPosition')}
                                        settingsItem="sessions.desktop-window-controls-position"
                                    >
                                        <SettingsChipGroup
                                            value={desktopWindowControlsPosition}
                                            options={WINDOW_CONTROLS_POSITION_OPTIONS.map((option) => ({
                                                value: option.id,
                                                label: tUnsafe(option.labelKey),
                                            }))}
                                            onChange={handleWindowControlsPositionChange}
                                            aria-label={t('settings.openchamber.desktopNetwork.field.windowControlsPositionAria')}
                                        />
                                    </SettingsStackedField>
                                    <SettingsStackedField
                                        label={t('settings.openchamber.desktopNetwork.field.windowControlsStyle')}
                                        settingsItem="sessions.desktop-window-controls-style"
                                    >
                                        <SettingsChipGroup
                                            value={desktopWindowControlsStyle}
                                            options={WINDOW_CONTROLS_STYLE_OPTIONS.map((option) => ({
                                                value: option.id,
                                                label: tUnsafe(option.labelKey),
                                            }))}
                                            onChange={handleWindowControlsStyleChange}
                                            aria-label={t('settings.openchamber.desktopNetwork.field.windowControlsStyleAria')}
                                        />
                                    </SettingsStackedField>
                                </SettingsTwoColumn>
                            </SettingsSection>
                        )}

                        {hasLocalizationSettings && (
                            <SettingsSection title={t('settings.openchamber.visual.section.localization')}>
                                <SettingsTwoColumn>
                                    <SettingsStackedField
                                        label={t('settings.appearance.language.label')}
                                        info={t('settings.appearance.language.description')}
                                        settingsItem="appearance.language"
                                    >
                                        <Select value={locale} onValueChange={handleLocaleChange}>
                                            <SelectTrigger aria-label={t('settings.appearance.language.select')} className={SETTINGS_SELECT_TRIGGER_CLASS}>
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
                                                        <SelectTrigger aria-label={t('settings.openchamber.visual.field.selectTimeFormatAria')} className={SETTINGS_SELECT_TRIGGER_CLASS}>
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
                                                        <SelectTrigger aria-label={t('settings.openchamber.visual.field.selectWeekStartAria')} className={SETTINGS_SELECT_TRIGGER_CLASS}>
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
                                <SettingsFieldRow
                                    label={t('settings.openchamber.visual.field.installAppName')}
                                    info={t('settings.openchamber.visual.field.installAppNameHint')}
                                    settingsItem="appearance.pwa-install-name"
                                    alignEnd={false}
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
                                </SettingsFieldRow>
                            )}

                            {showPwaOrientationSetting && (
                                <SettingsFieldRow
                                    label={t('settings.openchamber.visual.field.installOrientation')}
                                    description={t('settings.openchamber.visual.field.installOrientationHint')}
                                    settingsItem="appearance.pwa-orientation"
                                    alignEnd={false}
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
                                        <SelectTrigger aria-label={t('settings.openchamber.visual.field.pwaInstallOrientationAria')} className={SETTINGS_CLUSTER_CONTROL_CLASS}>
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
                                </SettingsFieldRow>
                            )}

                            {showMobileKeyboardModeSetting && (
                                <SettingsFieldRow
                                    label={t('settings.openchamber.visual.field.mobileKeyboardMode')}
                                    info={t('settings.openchamber.visual.field.mobileKeyboardModeHint')}
                                    settingsItem="appearance.mobile-keyboard-mode"
                                    alignEnd={false}
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
                                        <SelectTrigger aria-label={t('settings.openchamber.visual.field.mobileKeyboardModeAria')} className={SETTINGS_CLUSTER_CONTROL_CLASS}>
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
                                </SettingsFieldRow>
                            )}
                            </SettingsSection>
                        )}
                    </div>
                )}

                {/* --- Density & type --- */}
                {hasLayoutSettings && (
                    <SettingsSection title={t('settings.openchamber.visual.section.densityAndType')} contentClassName={SETTINGS_FIELDS_STACK_CLASS}>
                        {(shouldShow('fontSize') && !isMobile) || shouldShow('terminalFontSize') ? (
                            <SettingsTwoColumn>
                                {shouldShow('fontSize') && !isMobile && (
                                    <SettingsStackedField
                                        label={t('settings.openchamber.visual.field.interfaceFont')}
                                        settingsItem="appearance.interface-font-size"
                                        controlClassName="w-full flex-wrap"
                                    >
                                        <Select value={uiFont} onValueChange={(value) => setUiFont(value as UiFontOption)}>
                                            <SelectTrigger aria-label={t('settings.openchamber.visual.field.selectInterfaceFontAria')} className={SETTINGS_SELECT_TRIGGER_CLASS}>
                                                <SelectValue>{uiFont === CUSTOM_FONT_ID ? t('settings.openchamber.visual.field.customFont') : UI_FONT_OPTIONS.find((option) => option.id === uiFont)?.label}</SelectValue>
                                            </SelectTrigger>
                                            <SelectContent>
                                                {UI_FONT_OPTIONS.map((option) => (
                                                    <SelectItem key={option.id} value={option.id} disabled={webFontsBlocked && Boolean(option.source)}>
                                                        <span style={{ fontFamily: option.stack }}>{option.label}</span>
                                                    </SelectItem>
                                                ))}
                                                <SelectItem value={CUSTOM_FONT_ID}>{t('settings.openchamber.visual.field.customFont')}</SelectItem>
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
                                        {uiFont === CUSTOM_FONT_ID ? (
                                            <Input
                                                value={customUiFont}
                                                onChange={(event) => setCustomUiFont(event.target.value)}
                                                placeholder={t('settings.openchamber.visual.field.customFontPlaceholder')}
                                                aria-label={t('settings.openchamber.visual.field.customFontAria')}
                                                spellCheck={false}
                                                autoComplete="off"
                                                className="h-8 basis-full rounded-md px-3"
                                            />
                                        ) : null}
                                    </SettingsStackedField>
                                )}
                                {shouldShow('terminalFontSize') && (
                                    <SettingsStackedField
                                        label={t('settings.openchamber.visual.field.codeFont')}
                                        controlClassName="w-full flex-wrap"
                                    >
                                        <Select value={monoFont} onValueChange={(value) => setMonoFont(value as MonoFontOption)}>
                                            <SelectTrigger aria-label={t('settings.openchamber.visual.field.selectCodeFontAria')} className={SETTINGS_SELECT_TRIGGER_CLASS}>
                                                <SelectValue>{monoFont === CUSTOM_FONT_ID ? t('settings.openchamber.visual.field.customFont') : CODE_FONT_OPTIONS.find((option) => option.id === monoFont)?.label}</SelectValue>
                                            </SelectTrigger>
                                            <SelectContent>
                                                {CODE_FONT_OPTIONS.map((option) => (
                                                    <SelectItem key={option.id} value={option.id} disabled={webFontsBlocked && Boolean(option.source)}>
                                                        <span style={{ fontFamily: option.stack }}>{option.label}</span>
                                                    </SelectItem>
                                                ))}
                                                <SelectItem value={CUSTOM_FONT_ID}>{t('settings.openchamber.visual.field.customFont')}</SelectItem>
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
                                        {monoFont === CUSTOM_FONT_ID ? (
                                            <Input
                                                value={customMonoFont}
                                                onChange={(event) => setCustomMonoFont(event.target.value)}
                                                placeholder={t('settings.openchamber.visual.field.customFontPlaceholder')}
                                                aria-label={t('settings.openchamber.visual.field.customFontAria')}
                                                spellCheck={false}
                                                autoComplete="off"
                                                className="h-8 basis-full rounded-md px-3"
                                            />
                                        ) : null}
                                    </SettingsStackedField>
                                )}
                            </SettingsTwoColumn>
                        ) : null}
                        {webFontsBlocked && ((shouldShow('fontSize') && !isMobile) || shouldShow('terminalFontSize')) ? (
                            <p className={SETTINGS_HELPER_CLASS}>{t('settings.openchamber.visual.field.webFontsEnterprise')}</p>
                        ) : null}

                        {(shouldShow('fontSize') && !isMobile) || shouldShow('terminalFontSize') || shouldShow('editorFontSize') ? (
                            <SettingsTwoColumn>
                                {shouldShow('fontSize') && !isMobile && (
                                    <SettingsStackedField
                                        label={t('settings.openchamber.visual.field.interfaceFontSize')}
                                        controlClassName="w-full"
                                    >
                                        <div className={SETTINGS_NUMBER_STEPPER_ROW_CLASS}>
                                            <NumberInput
                                                value={fontSize}
                                                onValueChange={setFontSize}
                                                min={50}
                                                max={200}
                                                step={5}
                                                className={SETTINGS_NUMBER_INPUT_CLASS}
                                                aria-label={t('settings.openchamber.visual.field.fontSizePercentageAria')}
                                            />
                                            <span className={SETTINGS_NUMBER_UNIT_CLASS}>%</span>
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
                                        </div>
                                    </SettingsStackedField>
                                )}
                                {shouldShow('terminalFontSize') && (
                                    <SettingsStackedField
                                        label={t('settings.openchamber.visual.field.terminalFontSize')}
                                        settingsItem="appearance.terminal-font-size"
                                        controlClassName="w-full"
                                    >
                                        <div className={SETTINGS_NUMBER_STEPPER_ROW_CLASS}>
                                            <NumberInput
                                                value={terminalFontSize}
                                                onValueChange={setTerminalFontSize}
                                                min={9}
                                                max={52}
                                                step={1}
                                                className={SETTINGS_NUMBER_INPUT_CLASS}
                                            />
                                            <span className={SETTINGS_NUMBER_UNIT_CLASS}>px</span>
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
                                        </div>
                                    </SettingsStackedField>
                                )}
                                {shouldShow('editorFontSize') && (
                                    <SettingsStackedField
                                        label={t('settings.openchamber.visual.field.editorFontSize')}
                                        settingsItem="appearance.editor-font-size"
                                        controlClassName="w-full"
                                    >
                                        <div className={SETTINGS_NUMBER_STEPPER_ROW_CLASS}>
                                            <NumberInput
                                                value={editorFontSize}
                                                onValueChange={setEditorFontSize}
                                                min={9}
                                                max={32}
                                                step={1}
                                                className={SETTINGS_NUMBER_INPUT_CLASS}
                                            />
                                            <span className={SETTINGS_NUMBER_UNIT_CLASS}>px</span>
                                            <Button size="sm"
                                                type="button"
                                                variant="ghost"
                                                onClick={() => setEditorFontSize(13)}
                                                disabled={editorFontSize === 13}
                                                className={SETTINGS_ICON_BUTTON_CLASS}
                                                aria-label={t('settings.openchamber.visual.actions.resetEditorFontSizeAria')}
                                                title={t('settings.common.actions.reset')}
                                            >
                                                <Icon name="restart" className="h-3.5 w-3.5" />
                                            </Button>
                                        </div>
                                    </SettingsStackedField>
                                )}
                            </SettingsTwoColumn>
                        ) : null}

                        {shouldShow('spacing') || (shouldShow('inputBarOffset') && isMobile) ? (
                            <SettingsTwoColumn>
                                {shouldShow('spacing') && (
                                    <SettingsStackedField
                                        label={t('settings.openchamber.visual.field.spacingDensity')}
                                        settingsItem="appearance.spacing-density"
                                        controlClassName="w-full"
                                    >
                                        <div className={SETTINGS_NUMBER_STEPPER_ROW_CLASS}>
                                            <NumberInput
                                                value={padding}
                                                onValueChange={setPadding}
                                                min={50}
                                                max={200}
                                                step={5}
                                                className={SETTINGS_NUMBER_INPUT_CLASS}
                                            />
                                            <span className={SETTINGS_NUMBER_UNIT_CLASS}>%</span>
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
                                        </div>
                                    </SettingsStackedField>
                                )}
                                {shouldShow('inputBarOffset') && isMobile && (
                                    <SettingsStackedField
                                        label={t('settings.openchamber.visual.field.inputBarOffset')}
                                        info={t('settings.openchamber.visual.field.inputBarOffsetTooltip')}
                                        settingsItem="appearance.input-bar-offset"
                                        controlClassName="w-full"
                                    >
                                        <div className={SETTINGS_NUMBER_STEPPER_ROW_CLASS}>
                                            <NumberInput
                                                value={inputBarOffset}
                                                onValueChange={setInputBarOffset}
                                                min={0}
                                                max={100}
                                                step={5}
                                                className={SETTINGS_NUMBER_INPUT_CLASS}
                                            />
                                            <span className={SETTINGS_NUMBER_UNIT_CLASS}>px</span>
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
                                        </div>
                                    </SettingsStackedField>
                                )}
                            </SettingsTwoColumn>
                        ) : null}
                        {!hasThemeSettings && scrollbarSetting}
                    </SettingsSection>
                )}

                {shouldShow('animatedActivityIndicators') && (
                    <SettingsSection
                        title={t('settings.openchamber.visual.section.sessionActivity')}
                        settingsItem="appearance.session-activity"
                        contentClassName={SETTINGS_OPTION_STACK_CLASS}
                    >
                        <SettingsCheckboxRow
                            checked={animatedActivityIndicators}
                            onChange={setAnimatedActivityIndicators}
                            label={t('settings.openchamber.visual.field.animatedActivityIndicators')}
                            ariaLabel={t('settings.openchamber.visual.field.animatedActivityIndicatorsAria')}
                            info={t('settings.openchamber.visual.field.animatedActivityIndicatorsInfo')}
                            settingsItem="appearance.animated-activity-indicators"
                        />
                    </SettingsSection>
                )}

            </div>
    );
};
