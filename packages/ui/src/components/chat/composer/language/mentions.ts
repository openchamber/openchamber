
const MENTION_BOUNDARY_BEFORE = /[\s()[\]{}<>"'`,.;:]/;

const LEADING_NOISE = /^[`"'<([{]+/;
const TRAILING_NOISE = /[)\]},.;:!?`"'>]+$/;

const MENTION_SCAN = /@([^\s]+)/g;

export interface MentionToken {
    start: number;
    end: number;
    raw: string;
    name: string;
}

export function isMentionBoundary(text: string, index: number): boolean {
    if (index <= 0) return true;
    return MENTION_BOUNDARY_BEFORE.test(text[index - 1]);
}

export function cleanMentionName(rawName: string): string {
    return rawName
        .trim()
        .replace(LEADING_NOISE, '')
        .replace(TRAILING_NOISE, '');
}

const CONFIRMED_END_BOUNDARY = /[\s)\]},.;:!?`"'>]/;

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
    knownAgentNames: ReadonlySet<string>;
    confirmedMentions: ReadonlySet<string>;
}

const DISMISSED_PREFIX = '\0';

export function dismissMention(name: string, mentions: Set<string>): void {
    mentions.delete(name);
    mentions.add(DISMISSED_PREFIX + name);
}

export function confirmMention(name: string, mentions: Set<string>): void {
    mentions.delete(DISMISSED_PREFIX + name);
    mentions.add(name);
}

const mentionEntryName = (entry: string): string =>
    (entry.startsWith(DISMISSED_PREFIX) ? entry.slice(DISMISSED_PREFIX.length) : entry);

export function isMentionEntryInText(entry: string, text: string): boolean {
    if (!entry.startsWith(DISMISSED_PREFIX)) return text.includes(`@${entry}`);
    return text.toLowerCase().includes(`@${mentionEntryName(entry).toLowerCase()}`);
}

export function isMentionDismissed(name: string, mentions: ReadonlySet<string>): boolean {
    return mentions.has(DISMISSED_PREFIX + name);
}

const isExcludedMention = (name: string, classifier: MentionClassifier): boolean =>
    !name
    || name.includes('<')
    || name.includes('>')
    || isMentionDismissed(name, classifier.confirmedMentions)
    || isMentionDismissed(name.toLowerCase(), classifier.confirmedMentions);

export function classifyMention(
    name: string,
    classifier: MentionClassifier,
): MentionKind | null {
    if (isExcludedMention(name, classifier)) return null;
    if (classifier.knownAgentNames.has(name.toLowerCase())) return 'agent';
    return classifier.confirmedMentions.has(name) ? 'file' : null;
}

export function isFileMentionCandidate(
    name: string,
    classifier: MentionClassifier,
): boolean {
    if (isExcludedMention(name, classifier)) return false;
    if (classifier.knownAgentNames.has(name.toLowerCase())) return false;
    return looksLikeFilePath(name, classifier.confirmedMentions);
}

const NOT_A_PATH = /["`]|:\/\/|@[^/\\]*$|^v?\d+(\.\d+)+([-+]\S*)?$/;

export function looksLikeFilePath(
    name: string,
    confirmedMentions: ReadonlySet<string>,
): boolean {
    if (confirmedMentions.has(name)) return true;
    if (NOT_A_PATH.test(name)) return false;
    return name.includes('/') || name.includes('\\') || name.includes('.');
}
