export type ComposerAutoCorrect = 'on' | 'off' | 'Off';

type PlatformNavigator = Pick<Navigator,
    'maxTouchPoints' | 'platform' | 'userAgent' | 'vendor'
>;

// external: https://html.spec.whatwg.org/multipage/interaction.html#attr-autocorrect Autocorrect keywords are ASCII case-insensitive.
export function composerAutoCorrect(options: {
    isMobile: boolean;
    navigator?: PlatformNavigator;
}): ComposerAutoCorrect {
    if (options.isMobile) return 'on';

    const nav = options.navigator
        ?? (typeof navigator === 'undefined'
            ? { maxTouchPoints: 0, platform: '', userAgent: '', vendor: '' }
            : navigator);
    // external: https://code.haverbeke.berlin/codemirror/view/src/tag/6.43.15/src/input.ts The period revert requires an exact lowercase "off" and matching browser flags.
    const ios = /Apple Computer/.test(nav.vendor)
        && (/Mobile\/\w+/.test(nav.userAgent) || nav.maxTouchPoints > 2);
    return ios || /Mac/.test(nav.platform) || /Android\b/.test(nav.userAgent)
        ? 'Off'
        : 'off';
}
