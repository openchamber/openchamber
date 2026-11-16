import type { Definition, Nodes, Root } from 'mdast';
import remarkParse from 'remark-parse';
import { defaultRemarkPlugins } from 'streamdown';
import { unified } from 'unified';

import type { SelectableUnit } from './selectableUnits';

type Replacement = { start: number; end: number; render: (rewrite: (start: number, end: number) => string) => string };

const parser = unified().use(remarkParse).use([defaultRemarkPlugins.gfm]);

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;

const escapeTitle = (title: string): string => title.replace(/[\\"&]/g, (char) => `\\${char}`);

const inlineDestination = (definition: Definition): string => {
    const url = definition.url;
    const destination = url === '' || /\s/.test(url)
        ? `<${url.replace(/[\\<>&]/g, (char) => `\\${char}`)}>`
        : url.replace(/[\\()&]/g, (char) => `\\${char}`);
    return definition.title ? `${destination} "${escapeTitle(definition.title)}"` : destination;
};

const offsets = (node: Nodes): { start: number; end: number } | null => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    return start === undefined || end === undefined ? null : { start, end };
};

const isEscaped = (source: string, index: number): boolean => {
    let backslashes = 0;
    for (let cursor = index - 1; cursor >= 0 && source[cursor] === '\\'; cursor -= 1) backslashes += 1;
    return backslashes % 2 === 1;
};

const closingBracket = (source: string, from: number, end: number): number => {
    for (let index = from; index < end; index += 1) {
        if (source[index] === ']' && !isEscaped(source, index)) return index;
    }
    return -1;
};

const referenceTextEnd = (source: string, span: { start: number; end: number }, referenceType: 'full' | 'collapsed' | 'shortcut'): number | null => {
    if (referenceType === 'shortcut') return span.end - 1;
    if (referenceType === 'collapsed') return source.endsWith('][]', span.end) ? span.end - 3 : null;
    for (let index = span.end - 2; index > span.start; index -= 1) {
        if (source[index] === '[' && !isEscaped(source, index)) return source[index - 1] === ']' ? index - 1 : null;
    }
    return null;
};

const collectDefinitions = (tree: Root): Map<string, Definition> => {
    const definitions = new Map<string, Definition>();
    const walk = (node: Nodes) => {
        if (node.type === 'definition' && !definitions.has(node.identifier)) definitions.set(node.identifier, node);
        if ('children' in node) node.children.forEach(walk);
    };
    walk(tree);
    return definitions;
};

const collectReplacements = (source: string, tree: Root, footnotePrefix: string): Replacement[] => {
    const definitions = collectDefinitions(tree);
    const replacements: Replacement[] = [];
    const walk = (node: Nodes) => {
        const span = offsets(node);
        if (span && node.type === 'definition') {
            replacements.push({ start: span.start, end: source[span.end] === '\n' ? span.end + 1 : span.end, render: () => '' });
            return;
        }
        if (span && (node.type === 'linkReference' || node.type === 'imageReference')) {
            const definition = definitions.get(node.identifier);
            const textStart = span.start + (node.type === 'imageReference' ? 2 : 1);
            const textEnd = referenceTextEnd(source, span, node.referenceType);
            if (definition && textEnd !== null && textEnd >= textStart) {
                const opener = node.type === 'imageReference' ? '![' : '[';
                replacements.push({
                    ...span,
                    render: (rewrite) => `${opener}${rewrite(textStart, textEnd)}](${inlineDestination(definition)})`,
                });
            }
        }
        if (span && node.type === 'footnoteReference' && source.startsWith('[^', span.start)) {
            const label = source.slice(span.start + 2, span.end - 1);
            replacements.push({ ...span, render: () => `[^${footnotePrefix}${label}]` });
        }
        if (span && node.type === 'footnoteDefinition' && source.startsWith('[^', span.start)) {
            const labelEnd = closingBracket(source, span.start + 2, span.end);
            if (labelEnd > 0 && source[labelEnd + 1] === ':') {
                const label = source.slice(span.start + 2, labelEnd);
                replacements.push({ start: span.start, end: labelEnd + 2, render: () => `[^${footnotePrefix}${label}]:` });
            }
        }
        if ('children' in node) node.children.forEach(walk);
    };
    walk(tree);
    return replacements.sort((left, right) => left.start - right.start || right.end - left.end);
};

const closeOpenFence = (source: string, tree: Root): string => {
    const last = tree.children.at(-1);
    const span = last ? offsets(last) : null;
    if (last?.type !== 'code' || !span || span.end < source.trimEnd().length) return source;
    const lines = source.slice(span.start, span.end).split('\n');
    const fence = FENCE_OPEN.exec(lines[0] ?? '')?.[1];
    if (!fence) return source;
    const closing = lines.length > 1 ? lines.at(-1)?.trim() ?? '' : '';
    const closed = closing.length >= fence.length && [...closing].every((char) => char === fence[0]);
    return closed ? source : `${source.trimEnd()}\n${fence}`;
};

export const isolateMessageMarkdown = (markdown: string, footnotePrefix: string): string => {
    const tree = parser.parse(markdown);
    const replacements = collectReplacements(markdown, tree, footnotePrefix);
    const rewrite = (start: number, end: number): string => {
        let output = '';
        let cursor = start;
        for (const replacement of replacements) {
            if (replacement.start < cursor || replacement.end > end) continue;
            if (replacement.start >= end) break;
            output += markdown.slice(cursor, replacement.start) + replacement.render(rewrite);
            cursor = replacement.end;
        }
        return output + markdown.slice(cursor, end);
    };
    const rewritten = rewrite(0, markdown.length);
    return closeOpenFence(rewritten, parser.parse(rewritten));
};

export const formatSelectionMarkdown = (units: readonly SelectableUnit[]): string => {
    let segmentIndex = 0;
    const isolate = (text: string) => {
        segmentIndex += 1;
        return isolateMessageMarkdown(text, `m${segmentIndex}-`).trim();
    };
    return units.map((unit) => (unit.kind === 'prompt'
        ? `**User**\n\n${isolate(unit.text)}`
        : `**Assistant**\n\n${unit.segments.map(isolate).join('\n\n')}`
    )).join('\n\n---\n\n');
};
