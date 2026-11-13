/**
 * The composer's prefix-token grammar: `/command`, `$skill` and `#snippet`.
 * A skill may start with the yen or full-width dollar signs a CJK IME types
 * for the same key; see `SIGIL_SPELLINGS`.
 *
 * Structurally these are the same construct — a sigil at a word boundary
 * followed by an identifier — and they were previously scanned by three
 * different regexes per sigil (highlighting, send-time collection, and the
 * autocomplete trigger), each with its own idea of the valid character set.
 * The send-time skill scanner, for instance, accepted only lowercase names, so
 * a `My_Skill` token was painted but never collected.
 *
 * Scanning is deliberately generous: it finds every syntactically plausible
 * token and leaves the decision of what exists to the caller, which holds the
 * authoritative set of commands, skills or snippets. Membership is the
 * authority; the pattern is only a locator.
 *
 * @see mentions.ts for the `@` half of the grammar.
 */

/**
 * Identifier body shared by all prefix tokens: starts alphanumeric, then
 * alphanumerics, `-` and `_`. Kept in one place so the sigils cannot drift
 * apart again.
 */
const TOKEN_NAME = '[A-Za-z0-9][A-Za-z0-9_-]*';

/** Sigils that introduce a prefix token: commands, skills, snippets. */
export type TokenPrefix = '/' | '$' | '#';

/**
 * Spellings that count as one sigil. A Chinese or Japanese IME turns the
 * Shift+4 key that types `$` into `¥` or `￥`, and full-width mode into `＄`,
 * so a skill token can start with any of them.
 */
const SIGIL_SPELLINGS = {
    '/': ['/'],
    '$': ['$', '¥', '￥', '＄'],
    '#': ['#'],
} satisfies Record<TokenPrefix, readonly string[]>;

export interface PrefixToken {
    /** Offset of the sigil. */
    start: number;
    /** Offset just past the identifier. */
    end: number;
    /** The sigil that introduced this token. */
    prefix: TokenPrefix;
    /** The identifier without its sigil. */
    name: string;
}

const escapeSigil = (sigil: string) => sigil.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const scanner = (spellings: readonly string[]) =>
    new RegExp(`(^|\\s)(${spellings.map(escapeSigil).join('|')})(${TOKEN_NAME})`, 'g');

const SCANNERS: Record<TokenPrefix, RegExp> = {
    '/': scanner(SIGIL_SPELLINGS['/']),
    '$': scanner(SIGIL_SPELLINGS['$']),
    '#': scanner(SIGIL_SPELLINGS['#']),
};

/**
 * Find every `prefix`-token in `text`. A token must sit at the start of the
 * text or directly after whitespace, so `a/b` and `#1` inside `issue#1` stay
 * ordinary prose.
 */
export function scanPrefixTokens(text: string, prefix: TokenPrefix): PrefixToken[] {
    if (!text || !SIGIL_SPELLINGS[prefix].some((sigil) => text.includes(sigil))) return [];

    const scan = SCANNERS[prefix];
    const tokens: PrefixToken[] = [];
    scan.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = scan.exec(text)) !== null) {
        const sigil = match[2];
        const name = match[3];
        // The leading-whitespace capture keeps the boundary check inside the
        // pattern; the token itself starts after it.
        const start = match.index + match[1].length;
        tokens.push({ start, end: start + sigil.length + name.length, prefix, name });
    }

    return tokens;
}

/**
 * Index of the last spelling of `prefix`'s sigil in `text`, or -1. The composer
 * replaces the sigil a picker opened on, whichever spelling the IME produced.
 */
export function lastPrefixSigilIndex(text: string, prefix: TokenPrefix): number {
    return SIGIL_SPELLINGS[prefix].reduce((last, sigil) => Math.max(last, text.lastIndexOf(sigil)), -1);
}

/**
 * The tokens whose name is present in `known`, in document order. `compare`
 * decides how a token name is matched against the set — snippets and commands
 * both match case-insensitively, while the skill-instruction
 * builder matches the exact registered name.
 */
export function filterKnownTokens(
    tokens: readonly PrefixToken[],
    known: ReadonlySet<string>,
    compare: 'exact' | 'case-insensitive' = 'case-insensitive',
): PrefixToken[] {
    if (known.size === 0) return [];
    return tokens.filter((token) => known.has(
        compare === 'exact' ? token.name : token.name.toLowerCase(),
    ));
}

/**
 * Distinct names of the known `prefix`-tokens in `text`, in first-occurrence
 * order. Used to tell the model which skills the user named explicitly.
 */
export function collectKnownTokenNames(
    text: string,
    prefix: TokenPrefix,
    known: ReadonlySet<string>,
    compare: 'exact' | 'case-insensitive' = 'case-insensitive',
): string[] {
    const seen = new Set<string>();
    const names: string[] = [];
    for (const token of filterKnownTokens(scanPrefixTokens(text, prefix), known, compare)) {
        if (seen.has(token.name)) continue;
        seen.add(token.name);
        names.push(token.name);
    }
    return names;
}
