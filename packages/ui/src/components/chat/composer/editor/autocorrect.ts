export type ComposerAutoCorrect = 'on' | 'off' | 'Off';

type PlatformNavigator = Pick<Navigator,
    'maxTouchPoints' | 'platform' | 'userAgent' | 'vendor'
>;

/** Keep desktop autocorrect off without triggering CodeMirror's period revert. */
export function composerAutoCorrect(options: {
    isMobile: boolean;
    navigator?: PlatformNavigator;
}): ComposerAutoCorrect {
    if (options.isMobile) return 'on';

    const nav = options.navigator
        ?? (typeof navigator === 'undefined'
            ? { maxTouchPoints: 0, platform: '', userAgent: '', vendor: '' }
            : navigator);
    // These must match CodeMirror's flags because its revert checks exact "off".
    const ios = /Apple Computer/.test(nav.vendor)
        && (/Mobile\/\w+/.test(nav.userAgent) || nav.maxTouchPoints > 2);
    return ios || /Mac/.test(nav.platform) || /Android\b/.test(nav.userAgent)
        ? 'Off'
        : 'off';
}
