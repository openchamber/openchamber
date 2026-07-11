/**
 * Lightweight markdown tokenizer for the chat composer's highlight overlay.
 *
 * The composer renders a transparent <textarea> on top of a mirror <div>
 * (see ChatInput.tsx). The div paints the colored text the user sees while the
 * textarea owns the caret and selection. For the two layers to stay aligned the
 * overlay may only use styles that DO NOT change glyph advance width:
 * color, text-decoration and background. Font weight / style / family / size
 * would shift the text and make the highlight drift from the caret, so they are
 * intentionally avoided here.
 *
 * As a result we highlight the high-signal, low-false-positive markdown
 * constructs (code, links, headings, blockquotes, list markers) and dim their
 * syntax punctuation — a "source mode" look similar to GitHub's comment editor.
 * Emphasis (*bold* / _italic_) is deliberately not colored: it can only be
 * expressed through font weight (which we cannot use) and its delimiters clash
 * with ordinary prose (`2 * 3`, `foo_bar`).
 */

type HighlightStyle =
    | 'marker'
    | 'code'
    | 'codeFence'
    | 'link'
    | 'linkUrl'
    | 'heading'
    | 'blockquote'
    | 'listMarker';

type MentionKind = 'file' | 'agent';

export interface HighlightRange {
    start: number;
    end: number;
    style: HighlightStyle | 'mentionFile' | 'mentionAgent' | 'mentionCommand' | 'mentionSnippet';
    /**
     * Optional explicit class, used by syntax highlighting where the style is
     * resolved dynamically (per language token) rather than from a fixed enum.
     * When set it overrides STYLE_CLASS[style]. Must remain metric-safe
     * (color / decoration / background only).
     */
    className?: string;
    /** Optional explicit priority; falls back to STYLE_PRIORITY[style]. */
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

type AnyStyle = HighlightRange['style'];

// Higher priority wins when ranges overlap on a given segment.
const STYLE_PRIORITY: Record<AnyStyle, number> = {
    mentionFile: 100,
    mentionAgent: 100,
    mentionCommand: 100,
    mentionSnippet: 100,
    code: 90,
    codeFence: 90,
    link: 80,
    linkUrl: 78,
    heading: 70,
    blockquote: 40,
    listMarker: 35,
    marker: 10,
};

// Color / decoration / background only — never anything that affects layout.
const STYLE_CLASS: Record<AnyStyle, string> = {
    mentionFile: 'text-[var(--status-info)]',
    mentionAgent: 'text-[var(--status-success)]',
    mentionCommand: 'text-[var(--primary)]',
    mentionSnippet: 'text-[var(--status-warning)]',
    code: 'rounded-[3px] bg-[var(--surface-subtle)] text-[var(--markdown-inline-code)]',
    codeFence: 'bg-[var(--surface-subtle)] text-[var(--markdown-inline-code)]',
    link: 'text-[var(--status-info)] underline',
    linkUrl: 'text-muted-foreground',
    heading: 'text-[var(--syntax-keyword)]',
    blockquote: 'text-muted-foreground',
    listMarker: 'text-[var(--syntax-keyword)]',
    marker: 'text-muted-foreground',
};

const DEFAULT_CLASS = 'text-foreground';

/**
 * Scan a single line (or the content portion of a block construct) for inline
 * markdown spans and push their ranges. `base` is the absolute offset of
 * `segment` within the full text.
 */
function scanInline(segment: string, base: number, out: HighlightRange[]): void {
    let i = 0;
    const n = segment.length;

    while (i < n) {
        const ch = segment[i];

        // Inline code: a run of N backticks closed by an identical run.
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

        // Link: [text](url)
        if (ch === '[') {
            const m = /^\[([^\]\n]*)\]\(([^)\n]*)\)/.exec(segment.slice(i));
            if (m) {
                const p = base + i;
                const textLen = m[1].length;
                const urlLen = m[2].length;
                const openMarkerEnd = p + 1;
                const textEnd = openMarkerEnd + textLen;
                const midMarkerEnd = textEnd + 2; // "]("
                const urlEnd = midMarkerEnd + urlLen;
                const closeEnd = urlEnd + 1; // ")"
                out.push({ start: p, end: openMarkerEnd, style: 'marker' });
                if (textLen > 0) out.push({ start: openMarkerEnd, end: textEnd, style: 'link' });
                out.push({ start: textEnd, end: midMarkerEnd, style: 'marker' });
                if (urlLen > 0) out.push({ start: midMarkerEnd, end: urlEnd, style: 'linkUrl' });
                out.push({ start: urlEnd, end: closeEnd, style: 'marker' });
                i += m[0].length;
                continue;
            }
        }

        i += 1;
    }
}

/**
 * Tokenize `text` into highlight ranges. Block constructs (fenced code,
 * headings, blockquotes, list markers) are detected per line; inline spans are
 * scanned within non-fenced lines.
 */
const FENCE_OPEN = /^(\s*)(`{3,}|~{3,})\s*(\S*)/;

export interface FenceOpen {
    /** The full opening fence run, e.g. "```" or "~~~~". */
    marker: string;
    /** First info-string token (the language), or '' when absent. */
    lang: string;
}

/** Recognize an opening code fence line (3+ backticks or tildes). */
export function matchFenceOpen(line: string): FenceOpen | null {
    const match = FENCE_OPEN.exec(line);
    return match ? { marker: match[2], lang: match[3] || '' } : null;
}

/**
 * A closing fence: the same fence character, at least as long as the opening
 * run, and nothing but whitespace after it — so a `` ```js `` line inside a
 * block is treated as content, not a close. Shared with highlightFencedCode so
 * both agree on fence boundaries.
 */
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
        // Advance past this line plus its trailing newline for the next iteration.
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

/**
 * Split `text` into styled parts from a set of (possibly overlapping) ranges.
 * Each output part carries a single className; adjacent parts that share a
 * className are coalesced. Returns null when there is nothing to highlight so
 * callers can skip the overlay entirely for plain text.
 */
export function buildHighlightParts(
    text: string,
    ranges: HighlightRange[],
): HighlightPart[] | null {
    if (!text || ranges.length === 0) return null;

    const len = text.length;
    const bounds = new Set<number>([0, len]);
    for (const range of ranges) {
        if (range.start > 0 && range.start < len) bounds.add(range.start);
        if (range.end > 0 && range.end < len) bounds.add(range.end);
    }
    const sorted = [...bounds].sort((a, b) => a - b);

    // Sweep the boundaries keeping an "active" set of ranges covering the
    // current segment, so each segment costs O(active) instead of O(ranges).
    // (Boundaries include every range start/end, so any active range that has
    // started and not ended necessarily spans the whole segment.)
    // Keep original index so ties (equal priority) resolve to the earliest
    // range in input order — matching the prior straight O(n) scan.
    const byStart = ranges
        .map((range, index) => ({ range, index }))
        .filter((item) => item.range.end > item.range.start)
        .sort((a, b) => a.range.start - b.range.start);

    const parts: HighlightPart[] = [];
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
        for (const { range, index } of active) {
            const priority = range.priority ?? STYLE_PRIORITY[range.style];
            if (priority > bestPriority || (priority === bestPriority && index < bestIndex)) {
                bestPriority = priority;
                bestIndex = index;
                bestRange = range;
            }
        }

        const className = bestRange
            ? (bestRange.className ?? STYLE_CLASS[bestRange.style])
            : DEFAULT_CLASS;
        const segText = text.slice(segStart, segEnd);
        const last = parts[parts.length - 1];
        if (last && last.className === className) {
            last.text += segText;
        } else {
            parts.push({ text: segText, className });
        }
    }

    return parts.length > 0 ? parts : null;
}

export function mentionRangesToHighlightRanges(mentions: MentionRange[]): HighlightRange[] {
    return mentions.map((mention) => ({
        start: mention.start,
        end: mention.end,
        style: mention.kind === 'file' ? 'mentionFile' : 'mentionAgent',
    }));
}
