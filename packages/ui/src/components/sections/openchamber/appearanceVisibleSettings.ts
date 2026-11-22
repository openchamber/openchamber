// Every setting the visual-settings component can gate on. The
// VisibleSetting type is derived from this list, so the type and the
// runtime values cannot drift apart; OpenChamberVisualSettings re-exports
// the type. Pinned by appearanceVisibleSettings.test.ts.
export const ALL_VISIBLE_SETTINGS = [
    'theme',
    'windowControlsPosition',
    'pwaInstallName',
    'pwaOrientation',
    'mobileKeyboardMode',
    'timeFormat',
    'weekStart',
    'fontSize',
    'terminalFontSize',
    'editorFontSize',
    'spacing',
    'scrollbars',
    'inputBarOffset',
    'animatedActivityIndicators',
    'sidebarRows',
] as const;

export type VisibleSetting = (typeof ALL_VISIBLE_SETTINGS)[number];

// The Appearance (visual) section's allowlist for OpenChamberVisualSettings:
// every gateable setting, except weekStart, which the VS Code runtime omits.
export const getAppearanceVisibleSettings = (isVSCode: boolean): VisibleSetting[] =>
    ALL_VISIBLE_SETTINGS.filter((setting) => !isVSCode || setting !== 'weekStart');
