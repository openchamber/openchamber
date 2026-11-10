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
        for (const entry of confirmedMentions) {
            const path = mentionEntryName(entry);
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
    /**
     * What the composer settled about mention names: paths confirmed by the
     * picker, a drop, a restored draft or a check of the disk, and names the
     * user turned back into text (`dismissMention`).
     */
    confirmedMentions: ReadonlySet<string>;
}

// A mention never holds a NUL, so a dismissal cannot collide with a path.
const DISMISSED_PREFIX = '\0';

/** The name stays text until something confirms it again. */
export function dismissMention(name: string, mentions: Set<string>): void {
    mentions.delete(name);
    mentions.add(DISMISSED_PREFIX + name);
}

export function confirmMention(name: string, mentions: Set<string>): void {
    mentions.delete(DISMISSED_PREFIX + name);
    mentions.add(name);
}

/** The name an entry of `confirmedMentions` is about, dismissed or not. */
const mentionEntryName = (entry: string): string =>
    (entry.startsWith(DISMISSED_PREFIX) ? entry.slice(DISMISSED_PREFIX.length) : entry);

/** Whether `text` still holds the mention an entry of `confirmedMentions` is about. */
export function isMentionEntryInText(entry: string, text: string): boolean {
    if (!entry.startsWith(DISMISSED_PREFIX)) return text.includes(`@${entry}`);
    // A dismissed agent is stored lowercased, whatever case the text has.
    return text.toLowerCase().includes(`@${mentionEntryName(entry).toLowerCase()}`);
}

export function isMentionDismissed(name: string, mentions: ReadonlySet<string>): boolean {
    return mentions.has(DISMISSED_PREFIX + name);
}

// HTML fragments are prompt text, never references. In particular, do not
// interpret CSS syntax such as `@import</style>` as a local file path.
const isExcludedMention = (name: string, classifier: MentionClassifier): boolean =>
    !name
    || name.includes('<')
    || name.includes('>')
    || isMentionDismissed(name, classifier.confirmedMentions)
    || isMentionDismissed(name.toLowerCase(), classifier.confirmedMentions);

/**
 * What a mention is known to reference. Agents win over files: an agent name
 * is an exact, known identifier. A path counts once it is confirmed; its shape
 * alone only makes it a candidate (`isFileMentionCandidate`).
 */
export function classifyMention(
    name: string,
    classifier: MentionClassifier,
): MentionKind | null {
    if (isExcludedMention(name, classifier)) return null;
    if (classifier.knownAgentNames.has(name.toLowerCase())) return 'agent';
    return classifier.confirmedMentions.has(name) ? 'file' : null;
}

/** A name worth looking up on disk: it may reference a file, confirmed or not. */
export function isFileMentionCandidate(
    name: string,
    classifier: MentionClassifier,
): boolean {
    if (isExcludedMention(name, classifier)) return false;
    if (classifier.knownAgentNames.has(name.toLowerCase())) return false;
    return looksLikeFilePath(name, classifier.confirmedMentions);
}

/**
 * Shapes that carry a dot or a slash without being a path: a quoted attribute
 * or call (`@click="a.b"`, `@app.route("/x")`), a URL, a version alone
 * (`@1.2.3`) or at the end of a package (`@angular/core@19`).
 */
const NOT_A_PATH = /["`]|:\/\/|@[^/\\]*$|^v?\d+(\.\d+)+([-+]\S*)?$/;

/** A separator or an extension, or a name the user confirmed explicitly. */
export function looksLikeFilePath(
    name: string,
    confirmedMentions: ReadonlySet<string>,
): boolean {
    if (confirmedMentions.has(name)) return true;
    if (NOT_A_PATH.test(name)) return false;
    return name.includes('/') || name.includes('\\') || name.includes('.');
}
