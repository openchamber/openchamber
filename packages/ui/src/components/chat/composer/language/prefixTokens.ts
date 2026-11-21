
const TOKEN_NAME = '[A-Za-z0-9][A-Za-z0-9_-]*';

export type TokenPrefix = '/' | '$' | '#';

const SIGIL_SPELLINGS = {
    '/': ['/'],
    '$': ['$', '¥', '￥', '＄'],
    '#': ['#'],
} satisfies Record<TokenPrefix, readonly string[]>;

export interface PrefixToken {
    start: number;
    end: number;
    prefix: TokenPrefix;
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

export function scanPrefixTokens(text: string, prefix: TokenPrefix): PrefixToken[] {
    if (!text || !SIGIL_SPELLINGS[prefix].some((sigil) => text.includes(sigil))) return [];

    const scan = SCANNERS[prefix];
    const tokens: PrefixToken[] = [];
    scan.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = scan.exec(text)) !== null) {
        const sigil = match[2];
        const name = match[3];
        const start = match.index + match[1].length;
        tokens.push({ start, end: start + sigil.length + name.length, prefix, name });
    }

    return tokens;
}

export function lastPrefixSigilIndex(text: string, prefix: TokenPrefix): number {
    return SIGIL_SPELLINGS[prefix].reduce((last, sigil) => Math.max(last, text.lastIndexOf(sigil)), -1);
}

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
