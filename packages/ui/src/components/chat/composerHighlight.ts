
type HighlightStyle =
    | 'marker'
    | 'code'
    | 'codeFence'
    | 'link'
    | 'linkUrl'
    | 'heading'
    | 'blockquote'
    | 'listMarker'
    | 'strong'
    | 'emphasis'
    | 'attention'
    | 'path';

type MentionKind = 'file' | 'agent';

export interface HighlightRange {
    start: number;
    end: number;
    style: HighlightStyle | 'mentionFile' | 'mentionAgent' | 'mentionCommand' | 'mentionSnippet';
    className?: string;
    priority?: number;
}

export interface MentionRange {
    start: number;
    end: number;
    kind: MentionKind;
}

export interface HighlightPart {
    text: string;
    className: string;
}

export interface HighlightSegment {
    start: number;
    end: number;
    className: string;
}

type AnyStyle = HighlightRange['style'];

const STYLE_PRIORITY: Record<AnyStyle, number> = {
    mentionFile: 100,
    mentionAgent: 100,
    mentionCommand: 100,
    mentionSnippet: 100,
    code: 90,
    codeFence: 90,
    path: 85,
    link: 80,
    linkUrl: 78,
    heading: 70,
    attention: 60,
    strong: 50,
    emphasis: 50,
    blockquote: 40,
    listMarker: 35,
    marker: 10,
};

const STYLE_CLASS: Record<AnyStyle, string> = {
    mentionFile: 'text-[var(--status-info)]',
    mentionAgent: 'text-[var(--status-success)]',
    mentionCommand: 'text-[var(--primary)]',
    mentionSnippet: 'text-[var(--status-warning)]',
    code: 'rounded-[6px] bg-[var(--surface-muted)]',
    codeFence: 'bg-[var(--surface-subtle)]',
    path: 'text-[var(--status-info)]',
    link: 'text-[var(--status-info)] underline',
    linkUrl: 'text-muted-foreground',
    heading: 'text-[var(--syntax-keyword)]',
    attention: 'font-semibold text-[var(--status-warning)]',
    blockquote: 'text-muted-foreground',
    listMarker: 'text-[var(--syntax-keyword)]',
    marker: 'text-muted-foreground',
    strong: 'font-semibold',
    emphasis: 'italic',
};

const ADDITIVE_STYLES = new Set<AnyStyle>(['strong', 'emphasis']);

const DEFAULT_CLASS = 'text-foreground';

function opensEmphasis(segment: string, index: number, runLength: number): boolean {
    const before = index > 0 ? segment[index - 1] : '';
    const after = segment[index + runLength];
    if (!after || /\s/.test(after)) return false;
    if (segment[index] === '_' && /[\w]/.test(before)) return false;
    return before === '' || !/[\w]/.test(before) || segment[index] === '*';
}

function closesEmphasis(segment: string, index: number, runLength: number): boolean {
    const before = segment[index - 1];
    const after = segment[index + runLength];
    if (!before || /\s/.test(before)) return false;
    if (segment[index] === '_' && after && /[\w]/.test(after)) return false;
    return true;
}

function matchEmphasis(segment: string, index: number): { end: number; runLength: number } | null {
    const char = segment[index];
    const run = /^(\*{1,3}|_{1,3})/.exec(segment.slice(index))?.[1] ?? '';
    if (!run || !opensEmphasis(segment, index, run.length)) return null;

    let search = index + run.length;
    while (search < segment.length) {
        const closeIndex = segment.indexOf(run, search);
        if (closeIndex === -1) return null;
        if (segment[closeIndex + run.length] === char) {
            search = closeIndex + run.length + 1;
            continue;
        }
        if (closesEmphasis(segment, closeIndex, run.length)) {
            return { end: closeIndex + run.length, runLength: run.length };
        }
        search = closeIndex + run.length;
    }
    return null;
}

function scanInline(segment: string, base: number, out: HighlightRange[]): void {
    let i = 0;
    const n = segment.length;

    while (i < n) {
        const ch = segment[i];

        if (ch === '`') {
            const openRun = /^`+/.exec(segment.slice(i))?.[0] ?? '';
            const closeIdx = segment.indexOf(openRun, i + openRun.length);
            if (closeIdx !== -1) {
                const end = closeIdx + openRun.length;
                out.push({ start: base + i, end: base + end, style: 'code' });
                i = end;
                continue;
            }
        }

        if (ch === '[') {
            const m = /^\[([^\]\n]*)\]\(([^)\n]*)\)/.exec(segment.slice(i));
            if (m) {
                const p = base + i;
                const textLen = m[1].length;
                const urlLen = m[2].length;
                const openMarkerEnd = p + 1;
                const textEnd = openMarkerEnd + textLen;
                const midMarkerEnd = textEnd + 2;
                const urlEnd = midMarkerEnd + urlLen;
                const closeEnd = urlEnd + 1;
                out.push({ start: p, end: openMarkerEnd, style: 'marker' });
                if (textLen > 0) out.push({ start: openMarkerEnd, end: textEnd, style: 'link' });
                out.push({ start: textEnd, end: midMarkerEnd, style: 'marker' });
                if (urlLen > 0) out.push({ start: midMarkerEnd, end: urlEnd, style: 'linkUrl' });
                out.push({ start: urlEnd, end: closeEnd, style: 'marker' });
                i += m[0].length;
                continue;
            }
        }

        if (ch === '*' || ch === '_') {
            const match = matchEmphasis(segment, i);
            if (match) {
                const contentStart = base + i + match.runLength;
                const contentEnd = base + match.end - match.runLength;
                out.push({ start: base + i, end: contentStart, style: 'marker' });
                if (match.runLength >= 2) {
                    out.push({ start: contentStart, end: contentEnd, style: 'strong' });
                }
                if (match.runLength !== 2) {
                    out.push({ start: contentStart, end: contentEnd, style: 'emphasis' });
                }
                out.push({ start: contentEnd, end: base + match.end, style: 'marker' });
                scanInline(
                    segment.slice(i + match.runLength, match.end - match.runLength),
                    contentStart,
                    out,
                );
                i = match.end;
                continue;
            }
        }

        i += 1;
    }
}

const FENCE_OPEN = /^(\s*)(`{3,}|~{3,})\s*(\S*)/;

export interface FenceOpen {
    marker: string;
    lang: string;
}

export function matchFenceOpen(line: string): FenceOpen | null {
    const match = FENCE_OPEN.exec(line);
    return match ? { marker: match[2], lang: match[3] || '' } : null;
}

export function isFenceClose(line: string, openMarker: string): boolean {
    return new RegExp(`^\\s*\\${openMarker[0]}{${openMarker.length},}\\s*$`).test(line);
}

export function tokenizeMarkdown(text: string): HighlightRange[] {
    const ranges: HighlightRange[] = [];
    if (!text) return ranges;

    let offset = 0;
    let inFence = false;
    let openMarker = '';

    const lines = text.split('\n');
    for (let li = 0; li < lines.length; li += 1) {
        const line = lines[li];
        const lineStart = offset;
        const lineEnd = lineStart + line.length;
        offset = lineEnd + 1;

        if (inFence) {
            ranges.push({ start: lineStart, end: lineEnd, style: 'codeFence' });
            if (isFenceClose(line, openMarker)) {
                inFence = false;
            }
            continue;
        }

        const fenceOpen = matchFenceOpen(line);
        if (fenceOpen) {
            inFence = true;
            openMarker = fenceOpen.marker;
            ranges.push({ start: lineStart, end: lineEnd, style: 'codeFence' });
            continue;
        }

        const attention = /^(\s*)(!!!)(\s+)/.exec(line);
        if (attention) {
            const markerStart = lineStart + attention[1].length;
            const markerEnd = markerStart + attention[2].length;
            ranges.push({ start: markerStart, end: markerEnd, style: 'marker' });
            const contentStart = markerEnd + attention[3].length;
            if (lineEnd > contentStart) {
                ranges.push({ start: contentStart, end: lineEnd, style: 'attention' });
                scanInline(line.slice(contentStart - lineStart), contentStart, ranges);
            }
            continue;
        }

        const heading = /^(\s*)(#{1,6})(\s+)/.exec(line);
        if (heading) {
            const markerStart = lineStart + heading[1].length;
            const markerEnd = markerStart + heading[2].length;
            ranges.push({ start: markerStart, end: markerEnd, style: 'marker' });
            const contentStart = markerEnd + heading[3].length;
            if (lineEnd > contentStart) {
                ranges.push({ start: contentStart, end: lineEnd, style: 'heading' });
                scanInline(line.slice(contentStart - lineStart), contentStart, ranges);
            }
            continue;
        }

        const quote = /^(\s*)(>+)(\s?)/.exec(line);
        if (quote) {
            const markerStart = lineStart + quote[1].length;
            const markerEnd = markerStart + quote[2].length;
            ranges.push({ start: markerStart, end: markerEnd, style: 'marker' });
            const contentStart = markerEnd + quote[3].length;
            if (lineEnd > contentStart) {
                ranges.push({ start: contentStart, end: lineEnd, style: 'blockquote' });
                scanInline(line.slice(contentStart - lineStart), contentStart, ranges);
            }
            continue;
        }

        const list = /^(\s*)([-*+]|\d{1,9}[.)])(\s+)/.exec(line);
        if (list) {
            const markerStart = lineStart + list[1].length;
            const markerEnd = markerStart + list[2].length;
            ranges.push({ start: markerStart, end: markerEnd, style: 'listMarker' });
            const contentStart = markerEnd + list[3].length;
            scanInline(line.slice(contentStart - lineStart), contentStart, ranges);
            continue;
        }

        scanInline(line, lineStart, ranges);
    }

    return ranges;
}

export function resolveHighlightSegments(
    text: string,
    ranges: HighlightRange[],
): HighlightSegment[] {
    if (!text || ranges.length === 0) return [];

    const len = text.length;
    const bounds = new Set<number>([0, len]);
    for (const range of ranges) {
        if (range.start > 0 && range.start < len) bounds.add(range.start);
        if (range.end > 0 && range.end < len) bounds.add(range.end);
    }
    const sorted = [...bounds].sort((a, b) => a - b);

    const byStart = ranges
        .map((range, index) => ({ range, index }))
        .filter((item) => item.range.end > item.range.start)
        .sort((a, b) => a.range.start - b.range.start);

    const segments: HighlightSegment[] = [];
    const active: Array<{ range: HighlightRange; index: number }> = [];
    let nextRange = 0;

    for (let i = 0; i < sorted.length - 1; i += 1) {
        const segStart = sorted[i];
        const segEnd = sorted[i + 1];
        if (segEnd <= segStart) continue;

        while (nextRange < byStart.length && byStart[nextRange].range.start <= segStart) {
            active.push(byStart[nextRange]);
            nextRange += 1;
        }
        for (let a = active.length - 1; a >= 0; a -= 1) {
            if (active[a].range.end <= segStart) active.splice(a, 1);
        }

        let bestRange: HighlightRange | null = null;
        let bestPriority = -1;
        let bestIndex = Infinity;
        const additive: string[] = [];

        for (const { range, index } of active) {
            if (ADDITIVE_STYLES.has(range.style)) {
                const extra = range.className ?? STYLE_CLASS[range.style];
                if (!additive.includes(extra)) additive.push(extra);
                continue;
            }
            const priority = range.priority ?? STYLE_PRIORITY[range.style];
            if (priority > bestPriority || (priority === bestPriority && index < bestIndex)) {
                bestPriority = priority;
                bestIndex = index;
                bestRange = range;
            }
        }

        const baseClass = bestRange
            ? (bestRange.className ?? STYLE_CLASS[bestRange.style])
            : DEFAULT_CLASS;
        const className = additive.length > 0
            ? [baseClass, ...additive].join(' ')
            : baseClass;

        const last = segments[segments.length - 1];
        if (last && last.className === className && last.end === segStart) {
            last.end = segEnd;
        } else {
            segments.push({ start: segStart, end: segEnd, className });
        }
    }

    return segments;
}

export function buildHighlightParts(
    text: string,
    ranges: HighlightRange[],
): HighlightPart[] | null {
    const segments = resolveHighlightSegments(text, ranges);
    if (segments.length === 0) return null;
    return segments.map((segment) => ({
        text: text.slice(segment.start, segment.end),
        className: segment.className,
    }));
}

export const DEFAULT_HIGHLIGHT_CLASS = DEFAULT_CLASS;

export function mentionRangesToHighlightRanges(mentions: MentionRange[]): HighlightRange[] {
    return mentions.map((mention) => ({
        start: mention.start,
        end: mention.end,
        style: mention.kind === 'file' ? 'mentionFile' : 'mentionAgent',
    }));
}
