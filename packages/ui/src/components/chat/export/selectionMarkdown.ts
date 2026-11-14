import { Lexer, type Token } from 'marked';

export type SelectedConversationMessage = {
    key: string;
    role: 'user' | 'assistant';
    segments: readonly string[];
    attachments?: readonly { name: string; url?: string }[];
};

// Track original positions while Marked removes list/blockquote prefixes.
function sourcePositions(text: string, source: string, positions: readonly number[]): number[] {
    const result: number[] = [];
    let cursor = 0;
    for (const line of text.split('\n')) {
        const start = source.indexOf(line, cursor);
        if (start < 0) {
            if (!source.includes('\t')) return [];
            const expandedPositions: number[] = [];
            let expanded = '';
            for (let index = 0; index < source.length; index++) {
                const characters = source[index] === '\t' ? '    ' : source[index];
                expanded += characters;
                for (let count = 0; count < characters.length; count++) expandedPositions.push(positions[index]);
            }
            return sourcePositions(text, expanded, expandedPositions);
        }
        for (let index = 0; index < line.length; index++) result.push(positions[start + index]);
        cursor = start + line.length;
        const newline = source.indexOf('\n', cursor);
        if (result.length < text.length && newline >= 0) {
            result.push(positions[newline]);
            cursor = newline + 1;
        }
    }
    return result;
}

function visitTokens(
    tokens: readonly Token[],
    source: string,
    positions: readonly number[],
    visit: (token: Token, positions: readonly number[]) => void,
): void {
    let cursor = 0;
    for (const token of tokens) {
        const start = source.indexOf(token.raw, cursor);
        if (start < 0) continue;
        const mapped = positions.slice(start, start + token.raw.length);
        cursor = start + token.raw.length;
        visit(token, mapped);
        if (token.type === 'list') {
            visitTokens(token.items, token.raw, mapped, visit);
        } else if (token.type === 'table') {
            const tablePositions: number[] = [];
            let tableSource = '';
            for (let index = 0; index < token.raw.length; index++) {
                if (token.raw[index] === '\\' && token.raw[index + 1] === '|') continue;
                tableSource += token.raw[index];
                tablePositions.push(mapped[index]);
            }
            let cellCursor = 0;
            for (const cell of [...token.header, ...token.rows.flat()]) {
                const cellStart = tableSource.indexOf(cell.text, cellCursor);
                if (cellStart < 0) continue;
                cellCursor = cellStart + cell.text.length;
                visitTokens(cell.tokens, cell.text, tablePositions.slice(cellStart, cellCursor), visit);
            }
        } else if ('tokens' in token && token.tokens && 'text' in token) {
            visitTokens(token.tokens, token.text, sourcePositions(token.text, token.raw, mapped), visit);
        }
    }
}

function scanTokens(
    source: string,
    references: ReturnType<typeof Lexer.lex>['links'],
    visit: (token: Token, positions: readonly number[]) => void,
): void {
    const positions: number[] = [];
    let normalized = '';
    for (let index = 0; index < source.length; index++) {
        if (source[index] === '\r' && source[index + 1] === '\n') continue;
        normalized += source[index] === '\r' ? '\n' : source[index];
        positions.push(index);
    }
    const lexer = new Lexer();
    lexer.blockTokens(normalized, lexer.tokens);
    for (const [label, definition] of Object.entries(references)) {
        if (!lexer.tokens.links[label]) lexer.tokens.links[label] = definition;
    }
    for (const queued of lexer.inlineQueue) lexer.inlineTokens(queued.src, queued.tokens);
    visitTokens(lexer.tokens, normalized, positions, visit);
}

type Edit = { start: number; end: number; text: string };

function applyEdits(source: string, edits: Edit[]): string {
    for (const edit of edits.sort((a, b) => b.start - a.start)) {
        source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
    }
    return source;
}

function closeFences(source: string): string {
    const edits: Edit[] = [];
    scanTokens(source, {}, (token, positions) => {
        if (token.type !== 'code' || token.codeBlockStyle === 'indented' || !positions.length) return;
        const opener = /^( {0,3})(`{3,}|~{3,})[^\n]*(?:\n|$)/.exec(token.raw);
        if (!opener) return;
        const fence = opener[2];
        const lines = token.raw.replace(/\n$/, '').split('\n');
        const last = lines.at(-1) ?? '';
        if (lines.length > 1 && new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[ \\t]*$`).test(last)) return;
        const start = positions[0];
        const lineStart = source.lastIndexOf('\n', start - 1) + 1;
        // List markers become indentation; quote markers remain on the closing line.
        const prefix = source.slice(lineStart, start).replace(/(?:[-+*]|\d+[.)])([ \t]+)/g, (marker) => ' '.repeat(marker.length));
        const end = positions[positions.length - 1] + 1;
        edits.push({ start: end, end, text: `${source[end - 1] === '\n' ? '' : '\n'}${prefix}${opener[1]}${fence}\n` });
    });
    return applyEdits(source, edits);
}

function namespaceReferences(source: string, index: number, references: ReturnType<typeof Lexer.lex>['links']): string {
    const edits: Edit[] = [];
    const localReferences = Lexer.lex(source).links;
    const protectedPositions = new Set<number>();
    const namespace = (label: string) => label.startsWith('^') ? `^oc-${index + 1}-${label.slice(1)}` : `oc-${index + 1}-${label}`;
    scanTokens(source, references, (token, positions) => {
        if (!positions.length) return;
        if (token.type === 'code' || token.type === 'codespan' || token.type === 'escape' || token.type === 'html') {
            for (const position of positions) protectedPositions.add(position);
        }
        if (token.type === 'def') {
            const label = /^ {0,3}\[([^\]]+)\]:/.exec(token.raw);
            if (label) {
                const start = token.raw.indexOf('[') + 1;
                edits.push({ start: positions[start], end: positions[start + label[1].length - 1] + 1, text: namespace(label[1]) });
                for (const position of positions) protectedPositions.add(position);
            }
        }
        if (token.type !== 'link' && token.type !== 'image') return;
        // Inline destinations and autolinks are already self-contained.
        const reference = /^(!?\[([\s\S]*?)\])(?:\[([^\]]*)\])?$/.exec(token.raw);
        if (!reference) {
            for (const position of positions) protectedPositions.add(position);
            return;
        }
        const label = reference[3] || reference[2];
        if (label.startsWith('^')) return; // Footnotes are handled below.
        const normalizedLabel = label.replace(/\s+/g, ' ').toLowerCase();
        if (!localReferences[normalizedLabel]) {
            for (let offset = 0; offset < token.raw.length; offset++) {
                if (token.raw[offset] === '[') edits.push({ start: positions[offset], end: positions[offset], text: '\\' });
            }
            for (const position of positions) protectedPositions.add(position);
            return;
        }
        if (reference[3] !== undefined) {
            const start = reference[1].length + 1;
            edits.push({ start: positions[start], end: positions[positions.length - 1], text: namespace(label) });
        } else {
            const end = positions[positions.length - 1] + 1;
            edits.push({ start: end, end, text: `[${namespace(label)}]` });
        }
        for (const position of positions) protectedPositions.add(position);
    });
    const definedFootnotes = new Set(Object.keys(localReferences).filter((label) => label.startsWith('^')));
    for (const match of source.matchAll(/^ {0,3}\[\^([^\]\n]+)\]:/gm)) {
        const start = match.index + match[0].indexOf('[');
        if (!protectedPositions.has(start)) definedFootnotes.add(`^${match[1].replace(/\s+/g, ' ').toLowerCase()}`);
    }
    for (const match of source.matchAll(/\[\^([^\]\n]+)\]/g)) {
        if (protectedPositions.has(match.index)) continue;
        if (definedFootnotes.has(`^${match[1].replace(/\s+/g, ' ').toLowerCase()}`)) {
            edits.push({ start: match.index + 2, end: match.index + match[0].length - 1, text: `oc-${index + 1}-${match[1]}` });
        } else {
            edits.push({ start: match.index, end: match.index, text: '\\' });
        }
    }
    return applyEdits(source, edits);
}

function escapeLabel(label: string): string {
    return label.replace(/\\/g, '\\\\').replace(/([*_[\]`<>])/g, '\\$1').replace(/[\r\n]/g, ' ');
}

function publicAttachmentUrl(value: string | undefined): string | undefined {
    if (!value) return undefined;
    if (/^data:[^,\s]+,/i.test(value)) return value;
    try {
        const url = new URL(value);
        const host = url.hostname.toLowerCase();
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return undefined;
        if (host.startsWith('[') || !host.includes('.') || /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(host)) return undefined;
        if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
            const [a, b] = host.split('.').map(Number);
            if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return undefined;
        }
        if (/\/(?:api|auth)(?:\/|$)/i.test(url.pathname)) return undefined;
        return url.href;
    } catch {
        return undefined;
    }
}

export function formatSelectedConversationMarkdown(
    messages: readonly SelectedConversationMessage[],
    labels: { user: string; assistant: string; attachment: string },
): string {
    const sources = messages.map((message) => message.segments.map(closeFences).join('\n\n'));
    const references: ReturnType<typeof Lexer.lex>['links'] = Object.create(null);
    for (const source of sources) Object.assign(references, Lexer.lex(source).links);
    return messages.map((message, index) => {
        const parts = [namespaceReferences(sources[index], index, references)];
        for (const attachment of message.attachments ?? []) {
            const name = escapeLabel(attachment.name);
            const url = publicAttachmentUrl(attachment.url);
            const destination = url?.replace(/[<>\\\s]/g, (character) => encodeURIComponent(character));
            parts.push(destination ? `[${name}](<${destination}>)` : `${escapeLabel(labels.attachment)}: ${name}`);
        }
        return `**${escapeLabel(labels[message.role])}**\n\n${parts.filter((part) => part.length > 0).join('\n\n')}`;
    }).join('\n\n---\n\n');
}
