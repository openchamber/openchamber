type MarkdownPlainTextOptions = {
    code?: 'keep' | 'drop';
};

export const PLAIN_TEXT_SOURCE_CHARS = 4000;

const BACKTICK_FENCE = /^ {0,3}(`{3,})(?!`)[^\n`]*\n([\s\S]*?)^ {0,3}\1`*[ \t]*$/gm;
const TILDE_FENCE = /^ {0,3}(~{3,})(?!~)[^\n]*\n([\s\S]*?)^ {0,3}\1~*[ \t]*$/gm;
const TAIL_BACKTICK_FENCE = /^ {0,3}`{3,}[^\n`]*$/m;
const TAIL_TILDE_FENCE = /^ {0,3}~{3,}[^\n]*$/m;
const INLINE_CODE_RUN = /`+/g;
const HTML_COMMENT = /<!--[\s\S]*?-->/g;
const LINK_OR_IMAGE = /!?\[([^\]]*)\]\([^)]*\)/g;
const BLOCK_MARKERS = [
    /^ {0,3}(?:>\s?)+/gm,
    /^ {0,3}#{1,6}\s+/gm,
    /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm,
    /^ {0,3}(?:[*+-]|\d{1,9}[.)])[ \t]+/gm,
];
const EMPHASIS_UNDERSCORE = /(?<![\p{L}\p{N}_])(_{1,3})(?!_)(?!\s)([\s\S]*?[^\s_])\1(?![\p{L}\p{N}_])/gu;
const EMPHASIS_STAR = /(?<!\*)(\*{1,3})(?!\*)(?!\s)([\s\S]*?[^\s*])\1(?!\*)/g;
const CLEANUP_PASSES = 3;

const plainTextSentinel = (text: string): string => {
    let sentinel = '\uE000';
    for (let candidate = 0xe000; candidate <= 0xf8ff && text.includes(sentinel); candidate += 1) {
        sentinel = String.fromCharCode(candidate);
    }
    return sentinel;
};

const protectInlineCode = (text: string, protect: (code: string) => string): string => {
    const runs = Array.from(text.matchAll(INLINE_CODE_RUN), (match) => ({ start: match.index, length: match[0].length }));
    if (runs.length < 2) {
        return text;
    }

    const nextOfLength: number[] = runs.map(() => -1);
    const lastOfLength = new Map<number, number>();
    for (let index = runs.length - 1; index >= 0; index -= 1) {
        const run = runs[index];
        if (!run) {
            continue;
        }
        const next = lastOfLength.get(run.length);
        if (next !== undefined) {
            nextOfLength[index] = next;
        }
        lastOfLength.set(run.length, index);
    }

    let output = '';
    let cursor = 0;
    for (let index = 0; index < runs.length - 1; index += 1) {
        const open = runs[index];
        if (!open || open.start < cursor) {
            continue;
        }
        const close = nextOfLength[index] ?? -1;
        const closeRun = runs[close];
        if (!closeRun) {
            continue;
        }
        output += text.slice(cursor, open.start) + protect(text.slice(open.start + open.length, closeRun.start));
        cursor = closeRun.start + open.length;
        index = close;
    }
    return output + text.slice(cursor);
};

const protectOpenTail = (text: string, code: 'keep' | 'drop', protect: (code: string) => string): string => {
    const tail = [TAIL_BACKTICK_FENCE.exec(text), TAIL_TILDE_FENCE.exec(text)]
        .filter((match) => match !== null)
        .sort((left, right) => left.index - right.index)[0];
    if (!tail) {
        return text;
    }

    const body = text.slice(tail.index + tail[0].length).replace(/^\n/, '').trim();
    return text.slice(0, tail.index) + (code === 'keep' ? protect(body) : ' ');
};

export const markdownToPlainText = (text: string, options: MarkdownPlainTextOptions = {}): string => {
    const code = options.code ?? 'keep';
    const sentinel = plainTextSentinel(text);
    const codeBlocks: string[] = [];
    const protect = (block: string) => `${sentinel}${codeBlocks.push(block) - 1}${sentinel}`;
    const keepFence = (block: string) => (code === 'keep' ? protect(block.trim()) : ' ');

    const fenced = text
        .replace(BACKTICK_FENCE, (_match, _fence: string, block: string) => keepFence(block))
        .replace(TILDE_FENCE, (_match, _fence: string, block: string) => keepFence(block));

    const prose = protectInlineCode(protectOpenTail(fenced, code, protect), protect)
        .replace(HTML_COMMENT, '')
        .replace(LINK_OR_IMAGE, '$1');

    let flattened = prose;
    for (let pass = 0; pass < CLEANUP_PASSES; pass += 1) {
        const next = BLOCK_MARKERS
            .reduce((value, marker) => value.replace(marker, ''), flattened)
            .replace(EMPHASIS_UNDERSCORE, '$2')
            .replace(EMPHASIS_STAR, '$2');
        if (next === flattened) {
            break;
        }
        flattened = next;
    }

    return flattened
        .split(sentinel)
        .map((part, index) => (index % 2 === 1 ? codeBlocks[Number(part)] ?? '' : part))
        .join('')
        .replace(/\s+/g, ' ')
        .trim();
};
