
import { Language } from '@codemirror/language';
import { highlightTree, tagHighlighter, tags as t } from '@lezer/highlight';
import { codeBlockLanguageResolver } from '@/lib/codemirror/languageByExtension';
import { isFenceClose, matchFenceOpen, type HighlightRange } from './composerHighlight';

const CODE_BG = 'bg-[var(--surface-subtle)]';
const NEUTRAL_BASE_PRIORITY = 91;
const SYNTAX_PRIORITY = 94;

type SyntaxKey =
    | 'keyword' | 'string' | 'number' | 'comment'
    | 'function' | 'type' | 'variable' | 'operator';

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

export function highlightFencedCode(text: string): HighlightRange[] {
    if (!text || (!text.includes('```') && !text.includes('~~~'))) return [];

    const ranges: HighlightRange[] = [];
    const lines = text.split('\n');
    let offset = 0;

    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        offset += line.length + 1;

        const fenceOpen = matchFenceOpen(line);
        if (!fenceOpen) continue;

        const lang = resolveSyncLanguage(fenceOpen.lang);

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

        i = k;
        offset = cursor;

        if (!lang || bodyLines.length === 0) continue;

        const code = bodyLines.join('\n');
        if (!code.trim()) continue;

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
