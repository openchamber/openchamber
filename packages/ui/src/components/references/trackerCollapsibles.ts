const OPEN = /^ {0,3}\+\+\+[ \t]+(\S.*?)[ \t]*$/;
const CLOSE = /^ {0,3}\+\+\+[ \t]*$/;
const FENCE_OPEN = /^[ \t]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+|>[ \t]?)*(`{3,}|~{3,})/;
const FENCE_CLOSE = /^[ \t]*(?:>[ \t]?)*(`{3,}|~{3,})[ \t]*$/;

const escapeTitle = (text: string) => text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replace(/[\\`*_[\]()!~|#]/g, (char) => `&#${char.charCodeAt(0)};`);

export function foldTrackerCollapsibles(markdown: string): string {
    if (!markdown.includes('+++')) return markdown;
    const lines = markdown.split('\n');
    const out: string[] = [];
    let fence: string | null = null;
    let open: { title: string; at: number } | null = null;

    for (const raw of lines) {
        const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
        if (fence) {
            const close = FENCE_CLOSE.exec(line)?.[1];
            if (close && close[0] === fence[0] && close.length >= fence.length) fence = null;
            out.push(raw);
            continue;
        }
        const fenceMark = FENCE_OPEN.exec(line)?.[1];
        if (fenceMark) {
            fence = fenceMark;
            out.push(raw);
            continue;
        }
        const title = OPEN.exec(line)?.[1];
        if (!open && title) {
            open = { title, at: out.length };
            out.push(raw);
            continue;
        }
        if (open && CLOSE.test(line)) {
            out[open.at] = `<details>\n<summary>${escapeTitle(open.title)}</summary>\n`;
            out.push('\n</details>');
            open = null;
            continue;
        }
        out.push(raw);
    }
    return out.join('\n');
}
