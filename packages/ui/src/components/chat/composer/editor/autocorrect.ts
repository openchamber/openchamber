/**
 * The `autocorrect` keyword for the composer's content element.
 *
 * The composer's correction policy is "on for mobile keyboards, off
 * elsewhere". That policy is applied through the HTML `autocorrect`
 * attribute, which uses ASCII case-insensitive keywords — `on`, `off`,
 * `Off` all mean "off" to the browser.
 *
 * The `Off` spelling is load-bearing. @codemirror/view reads the attribute
 * with an exact string comparison and actively rewrites the platform's
 * insert-period-on-double-space (macOS and Android) into a plain double
 * space when it sees exactly `"off"`:
 *
 *     (browser.mac || browser.android) && change.from == change.to &&
 *     /^\. ?$/.test(...) && view.contentDOM.getAttribute("autocorrect") == "off"
 *
 * So on those platforms emitting the exact keyword `off` silently destroys
 * the period the user asked for. Emitting the case-insensitively-equivalent
 * `Off` keeps correction disabled for the browser while the exact match
 * fails, and the period survives.
 *
 * Windows and Linux keep the literal `off`: CodeMirror has no revert path
 * there, and staying on the standard spelling limits exposure if a browser
 * ever started matching the keyword case-sensitively.
 */

export type ComposerAutoCorrect = 'on' | 'off' | 'Off';

/**
 * The platform signals @codemirror/view's own `browser` flags read. The
 * detection below deliberately mirrors them, so the `Off` workaround turns
 * on exactly where CodeMirror's revert path turns on.
 */
interface CodeMirrorPlatformSignals {
    userAgent: string;
    vendor: string;
    platform: string;
    maxTouchPoints: number;
}

/**
 * Whether CodeMirror's insert-period-on-double-space revert path is active
 * on this platform. Mirrors `browser.mac || browser.android` from
 * @codemirror/view (see the pinned-guard test).
 */
function codeMirrorRevertsPeriod(nav: CodeMirrorPlatformSignals): boolean {
    // `safari` in CodeMirror: `!ie && /Apple Computer/.test(nav.vendor)`.
    const safari = /Apple Computer/.test(nav.vendor);
    // `ios` in CodeMirror: `safari && (/Mobile\/\w+/.test(nav.userAgent) || nav.maxTouchPoints > 2)`.
    const ios = safari && (/Mobile\/\w+/.test(nav.userAgent) || nav.maxTouchPoints > 2);
    // `mac` in CodeMirror: `ios || /Mac/.test(nav.platform)`.
    const mac = ios || /Mac/.test(nav.platform);
    // `android` in CodeMirror: `/Android\b/.test(nav.userAgent)`.
    const android = /Android\b/.test(nav.userAgent);
    return mac || android;
}

/**
 * The autocorrect keyword for the composer content element.
 *
 * `isMobile` keeps the existing mobile policy (`on`). Desktop stays `off`
 * for the browser everywhere, spelled `Off` on macOS/iOS/iPadOS and Android
 * so CodeMirror does not undo the platform's period-on-double-space.
 */
export function composerAutoCorrect(options: {
    isMobile: boolean;
    navigator?: Pick<Navigator, 'userAgent' | 'vendor' | 'platform' | 'maxTouchPoints'>;
}): ComposerAutoCorrect {
    if (options.isMobile) {
        return 'on';
    }
    const nav = options.navigator ?? globalThis.navigator;
    return codeMirrorRevertsPeriod(nav) ? 'Off' : 'off';
}
