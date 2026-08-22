/**
 * Expand `%preset` tokens into `[fusion preset: preset]` directives at send
 * time. The composer paints the short form as a chip; the model receives the
 * full directive. Membership in `knownPresets` is the authority — percentages
 * and `50%off` spellings are never rewritten.
 *
 * The boundary rules mirror the composer's `%` scanner (see
 * `language/prefixTokens.ts`): a token sits at the start of the text or right
 * after whitespace, with the same dot-inclusive name charset as the settings
 * layer. Punctuation that is not a name character terminates the token, so
 * `%deep-dive:` expands to `[fusion preset: deep-dive]:`. A name character
 * directly after the token (including a trailing dot) stays part of the name
 * and simply fails the registry check, exactly as it does in the painter.
 */

const TOKEN_PATTERN = /(^|\s)%([A-Za-z0-9][A-Za-z0-9._-]*)/g;

export const expandFusionPresets = (text: string, knownPresets: ReadonlySet<string>): string => {
    if (!text.includes('%') || knownPresets.size === 0) return text;
    return text.replace(TOKEN_PATTERN, (full, boundary: string, name: string) => (
        knownPresets.has(name) ? `${boundary}[fusion preset: ${name}]` : full
    ));
};
