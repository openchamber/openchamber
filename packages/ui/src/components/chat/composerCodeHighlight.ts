/**
 * Per-language syntax highlighting for fenced code blocks in the chat composer.
 *
 * Reuses the editor's CodeMirror language resolver and Lezer parsers so a
 * ```bash / ```ts block in the composer is colored the same way it is in the
 * file editor and in rendered messages. Output is fed into the composer's
 * highlight overlay (see composerHighlight.ts), which sits behind a transparent
 * <textarea>; the overlay may only change color / decoration / background, never
 * glyph metrics, so every token class below is color-only.
 *
 * Only languages the resolver returns synchronously are highlighted. Unknown or
 * lazily-loaded languages fall back to the uniform `codeFence` styling.
 */

import { Language } from '@codemirror/language';
import { highlightTree, tagHighlighter, tags as t } from '@lezer/highlight';
import { codeBlockLanguageResolver } from '@/lib/codemirror/languageByExtension';
import { isFenceClose, matchFenceOpen, type HighlightRange } from './composerHighlight';

const CODE_BG = 'bg-[var(--surface-subtle)]';
// Within a highlighted block: a neutral base (just above the uniform codeFence
// fill at 90) for untagged text, then per-token colors on top. Both stay below
// @mention / command highlights (100).
const NEUTRAL_BASE_PRIORITY = 91;
const SYNTAX_PRIORITY = 94;

type SyntaxKey =
    | 'keyword' | 'string' | 'number' | 'comment'
    | 'function' | 'type' | 'variable' | 'operator';

// highlightTree returns the space-joined classes of every styled node covering
// a range (and container tags like lists bleed onto their whole subtree). We
// emit single-word keys here and pick the most specific one per segment, so a
// marker tagged e.g. `strong meta` resolves to one coherent color.
const KEY_PRIORITY: Record<SyntaxKey, number> = {
    keyword: 8, function: 7, type: 6, string: 5, number: 5, variable: 4, operator: 3, comment: 2,
};
const KEY_CLASS: Record<SyntaxKey, string> = {
    keyword: `${CODE_BG} text-[var(--syntax-keyword)]`,
    string: `${CODE_BG} text-[var(--syntax-string)]`,
    number: `${CODE_BG} text-[var(--syntax-number)]`,
    comment: `${CODE_BG} text-[var(--syntax-comment)]`,
    function: `${CODE_BG} text-[var(--syntax-function)]`,
    type: `${CODE_BG} text-[var(--syntax-type)]`,
    variable: `${CODE_BG} text-[var(--syntax-variable)]`,
    operator: `${CODE_BG} text-[var(--syntax-operator)]`,
};

const codeHighlighter = tagHighlighter([
    { tag: [t.comment, t.lineComment, t.blockComment, t.docComment, t.meta], class: 'comment' },
    {
        tag: [t.keyword, t.modifier, t.controlKeyword, t.operatorKeyword, t.definitionKeyword, t.moduleKeyword, t.self, t.null],
        class: 'keyword',
    },
    { tag: [t.string, t.special(t.string), t.docString, t.character, t.regexp], class: 'string' },
    { tag: [t.number, t.integer, t.float, t.bool, t.atom], class: 'number' },
    { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName, t.standard(t.variableName)], class: 'function' },
    { tag: [t.typeName, t.className, t.namespace, t.tagName], class: 'type' },
    { tag: [t.variableName, t.propertyName, t.attributeName, t.labelName, t.definition(t.variableName)], class: 'variable' },
    { tag: [t.operator, t.punctuation, t.bracket, t.derefOperator, t.separator], class: 'operator' },
    // Markup tags (markdown / html-ish code blocks). Container tags (list,
    // contentSeparator) are intentionally omitted — they bleed onto plain text.
    { tag: [t.heading, t.heading1, t.heading2, t.heading3, t.heading4, t.heading5, t.heading6, t.strong], class: 'keyword' },
    { tag: [t.emphasis, t.quote], class: 'type' },
    { tag: [t.link, t.url], class: 'function' },
    { tag: [t.monospace], class: 'string' },
    { tag: [t.strikethrough], class: 'comment' },
]);

const pickSyntaxClass = (classes: string): string | null => {
    let best: SyntaxKey | null = null;
    for (const key of classes.split(' ')) {
        const candidate = key as SyntaxKey;
        if (KEY_PRIORITY[candidate] !== undefined && (best === null || KEY_PRIORITY[candidate] > KEY_PRIORITY[best])) {
            best = candidate;
        }
    }
    return best ? KEY_CLASS[best] : null;
};

// Cap per-block parsing so a giant pasted block can't stall the keystroke path;
// such blocks still get the neutral code base, just no per-token coloring.
const MAX_PARSE_LENGTH = 20_000;

const resolveSyncLanguage = (info: string): Language | null => {
    if (!info) return null;
    try {
        const resolved = codeBlockLanguageResolver(info);
        return resolved instanceof Language ? resolved : null;
    } catch {
        return null;
    }
};

/**
 * Produce syntax-token highlight ranges for every fenced code block in `text`
 * whose language can be resolved synchronously. An unterminated block (still
 * being typed) is highlighted up to the end of the text.
 */
export function highlightFencedCode(text: string): HighlightRange[] {
    if (!text || (!text.includes('```') && !text.includes('~~~'))) return [];

    const ranges: HighlightRange[] = [];
    const lines = text.split('\n');
    let offset = 0;

    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        offset += line.length + 1; // advance to the start of the next line

        const fenceOpen = matchFenceOpen(line);
        if (!fenceOpen) continue;

        const lang = resolveSyncLanguage(fenceOpen.lang);

        // Collect the body up to the matching closing fence (or end of text).
        const bodyStart = offset;
        const bodyLines: string[] = [];
        let k = i + 1;
        let cursor = offset;
        for (; k < lines.length; k += 1) {
            const bodyLine = lines[k];
            if (isFenceClose(bodyLine, fenceOpen.marker)) {
                cursor += bodyLine.length + 1;
                break;
            }
            bodyLines.push(bodyLine);
            cursor += bodyLine.length + 1;
        }

        // Resume the outer scan past the block we just consumed.
        i = k;
        offset = cursor;

        if (!lang || bodyLines.length === 0) continue;

        const code = bodyLines.join('\n');
        if (!code.trim()) continue;

        // For highlighted blocks the untagged base is neutral code text, so
        // plain prose (e.g. inside a ```md block) is not tinted like a string.
        // Unhighlighted blocks keep their distinct inline-code color instead.
        ranges.push({
            start: bodyStart,
            end: bodyStart + code.length,
            style: 'codeFence',
            className: `${CODE_BG} text-[var(--syntax-foreground)]`,
            priority: NEUTRAL_BASE_PRIORITY,
        });

        if (code.length > MAX_PARSE_LENGTH) continue;

        try {
            const tree = lang.parser.parse(code);
            highlightTree(tree, codeHighlighter, (from, to, classes) => {
                const className = pickSyntaxClass(classes);
                if (!className) return;
                ranges.push({
                    start: bodyStart + from,
                    end: bodyStart + to,
                    style: 'codeFence',
                    className,
                    priority: SYNTAX_PRIORITY,
                });
            });
        } catch {
            // Parsing failed — leave the block with its neutral base fill.
        }
    }

    return ranges;
}
