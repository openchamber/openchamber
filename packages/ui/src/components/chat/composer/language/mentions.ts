/**
 * The composer's `@mention` grammar — the single source of truth for what an
 * `@token` means.
 *
 * Before this module the same rule was re-implemented four times inside
 * ChatInput.tsx with subtly different cleanup (highlighting, send-time
 * extraction, deletion, and the autocomplete trigger). Each new reference
 * type had to be taught to all four. Everything
 * that needs to know where mentions are now scans with `scanMentions` and
 * decides what they are with `classifyMention`.
 *
 * A mention is `@` at a token boundary followed by non-whitespace. The visible
 * span (`start`..`end`) covers the raw token including any punctuation that
 * merely brushes against it; `name` is that token cleaned of wrapping
 * punctuation, and is what gets matched against agents and file paths.
 */

/**
 * Characters that may sit directly before `@`. Anything else (a letter, digit
 * or `/`) means the `@` belongs to the preceding word — an email address, a
 * scoped npm package, a path segment — and is not a mention.
 */
const MENTION_BOUNDARY_BEFORE = /[\s()[\]{}<>"'`,.;:]/;

/**
 * Punctuation that commonly wraps a mention and is never part of the name.
 * The two sets are deliberately symmetric: every bracket accepted before `@`
 * is also stripped from the tail, so `[@plan]` and `(@plan)` both reference
 * `plan`. The pre-unification rules allowed `[`/`{` in front but only stripped
 * `)` behind, which left `@plan]` as the resolved name.
 */
const LEADING_NOISE = /^[`"'<([{]+/;
const TRAILING_NOISE = /[)\]},.;:!?`"'>]+$/;

const MENTION_SCAN = /@([^\s]+)/g;

export interface MentionToken {
    /** Offset of the `@`. */
    start: number;
    /**
     * Offset just past the reference itself — the `@` plus the cleaned name.
     * This is the span to highlight: in `see @a/b.ts, ok` the comma is
     * punctuation of the sentence, not part of the file being referenced.
     */
    end: number;
    /** The raw token including `@` and any brushing punctuation. */
    raw: string;
    /** The token with `@` and wrapping punctuation removed. */
    name: string;
}

/** True when `@` at `index` starts a mention rather than continuing a word. */
export function isMentionBoundary(text: string, index: number): boolean {
    if (index <= 0) return true;
    return MENTION_BOUNDARY_BEFORE.test(text[index - 1]);
}

/** Strip the punctuation that wraps a mention without belonging to it. */
export function cleanMentionName(rawName: string): string {
    return rawName
        .trim()
        .replace(LEADING_NOISE, '')
        .replace(TRAILING_NOISE, '');
}

/** Characters that may directly follow a confirmed path that contains spaces. */
const CONFIRMED_END_BOUNDARY = /[\s)\]},.;:!?`"'>]/;

/**
 * The longest confirmed path containing whitespace that starts right after the
 * `@` at `start` and ends at a boundary. Paths without whitespace are already
 * captured whole by the plain scan, so only spaced paths need this lookup.
 */
function matchSpacedConfirmedPath(
    text: string,
    start: number,
    spacedPaths: readonly string[],
): string | null {
    for (const path of spacedPaths) {
        if (!text.startsWith(path, start + 1)) continue;
        const after = start + 1 + path.length;
        if (after >= text.length || CONFIRMED_END_BOUNDARY.test(text[after])) return path;
    }
    return null;
}

/**
 * Find every `@mention` in `text`. Tokens whose name cleans away to nothing
 * (a bare `@`, `@...`) are skipped — there is nothing to reference.
 *
 * `confirmedMentions` lets a path the picker inserted keep its spaces:
 * `@docs/my document.md` is one mention when that path was confirmed, while an
 * unconfirmed `@docs/my document.md` still stops at the first space.
 */
export function scanMentions(
    text: string,
    confirmedMentions?: ReadonlySet<string>,
): MentionToken[] {
    if (!text || !text.includes('@')) return [];

    const spacedPaths: string[] = [];
    if (confirmedMentions) {
        for (const path of confirmedMentions) {
            if (/\s/.test(path)) spacedPaths.push(path);
        }
        spacedPaths.sort((a, b) => b.length - a.length);
    }

    const tokens: MentionToken[] = [];
    MENTION_SCAN.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = MENTION_SCAN.exec(text)) !== null) {
        const start = match.index;
        if (!isMentionBoundary(text, start)) continue;

        const spaced = spacedPaths.length > 0 ? matchSpacedConfirmedPath(text, start, spacedPaths) : null;
        if (spaced) {
            const end = start + 1 + spaced.length;
            tokens.push({ start, end, raw: text.slice(start, end), name: spaced });
            MENTION_SCAN.lastIndex = end;
            continue;
        }

        const rawName = match[1] ?? '';
        const name = cleanMentionName(rawName);
        if (!name) continue;

        // The cleaned name is a substring of the raw one, so its offset inside
        // the token is exactly how much leading noise was stripped.
        const nameStart = start + 1 + rawName.indexOf(name);

        tokens.push({
            start,
            end: nameStart + name.length,
            raw: match[0],
            name,
        });
    }

    return tokens;
}

export type MentionKind = 'agent' | 'file';

export interface MentionClassifier {
    /** Lowercased names of the agents that can be mentioned. */
    knownAgentNames: ReadonlySet<string>;
    /** Mention paths confirmed by the picker, a drop, or a restored draft. */
    confirmedMentions: ReadonlySet<string>;
}

/**
 * A name looks like a file when it carries path structure (a separator or an
 * extension) or when the user confirmed it explicitly through the picker.
 * Agents win over files: an agent name is an exact, known identifier.
 */
export function classifyMention(
    name: string,
    classifier: MentionClassifier,
): MentionKind | null {
    if (!name) return null;
    // HTML fragments are prompt text, never references. In particular, do not
    // interpret CSS syntax such as `@import</style>` as a local file path.
    if (name.includes('<') || name.includes('>')) return null;
    if (classifier.knownAgentNames.has(name.toLowerCase())) return 'agent';
    if (looksLikeFilePath(name, classifier.confirmedMentions)) return 'file';
    return null;
}

export function looksLikeFilePath(
    name: string,
    confirmedMentions: ReadonlySet<string>,
): boolean {
    return name.includes('/')
        || name.includes('\\')
        || name.includes('.')
        || confirmedMentions.has(name);
}
