/**
 * Path handling for composer attachments and dropped files.
 *
 * Three representations meet here: what the user sees in the prompt (a
 * project-relative mention), what the OpenCode server is given (a `file://`
 * URL), and what a host application hands over on drop (a native path, a
 * percent-encoded URI, or a JSON payload with either buried inside).
 */

const FILE_URI_PREFIX = 'file://';

/**
 * Percent-encode a path for use in a `file://` URL, leaving separators intact
 * and preserving a Windows drive letter, which must not be encoded.
 */
export function encodeFilePath(filepath: string): string {
    let normalized = filepath.replace(/\\/g, '/');
    if (/^[A-Za-z]:/.test(normalized)) {
        normalized = `/${normalized}`;
    }
    return normalized
        .split('/')
        .map((segment, index) => {
            if (index === 1 && /^[A-Za-z]:$/.test(segment)) return segment;
            return encodeURIComponent(segment);
        })
        .join('/');
}

/** The `file://` URL the server resolves an attachment from. */
export function toServerFileUrl(filepath: string): string {
    const normalized = filepath.replace(/\\/g, '/').trim();
    if (normalized.toLowerCase().startsWith(FILE_URI_PREFIX)) {
        return normalized;
    }
    return `file://${encodeFilePath(normalized)}`;
}

/** POSIX root, UNC share, or Windows drive letter. */
export function isLikelyAbsolutePath(value: string): boolean {
    return value.startsWith('/')
        || value.startsWith('\\\\')
        || /^[A-Za-z]:[\\/]/.test(value);
}

/**
 * Trim and unquote a candidate, returning it only if it actually looks like a
 * file reference. A multi-line value is rejected outright: it is a document,
 * not a path.
 */
export function toLikelyFileDropReference(value: string): string | null {
    const trimmed = value.trim().replace(/^['"]+|['"]+$/g, '');
    if (!trimmed) return null;
    if (/[\r\n]/.test(trimmed)) return null;
    if (trimmed.toLowerCase().startsWith(FILE_URI_PREFIX)) return trimmed;
    if (isLikelyAbsolutePath(trimmed)) return trimmed;
    return null;
}

/** Collect every string in a nested value, bounded so a cyclic-ish payload terminates. */
function collectStringLeaves(input: unknown, output: Set<string>, depth = 0): void {
    if (depth > 6 || input == null) return;

    if (typeof input === 'string') {
        output.add(input);
        return;
    }

    if (Array.isArray(input)) {
        for (const item of input) collectStringLeaves(item, output, depth + 1);
        return;
    }

    if (typeof input !== 'object') return;

    for (const value of Object.values(input)) collectStringLeaves(value, output, depth + 1);
}

/**
 * Extract file references from a drop payload. Hosts disagree on the shape:
 * a bare path, a newline-separated URI list, or JSON with the paths nested
 * somewhere inside — so try the text directly, then line by line, then again
 * over every string found in the parsed JSON.
 */
export function parseDroppedFileReferences(rawPayload: string): string[] {
    const extracted = new Set<string>();

    const addCandidatesFromText = (value: string): void => {
        const direct = toLikelyFileDropReference(value);
        if (direct) {
            extracted.add(direct);
            return;
        }
        for (const line of value.split(/\r?\n/)) {
            const candidate = toLikelyFileDropReference(line);
            if (candidate) extracted.add(candidate);
        }
    };

    addCandidatesFromText(rawPayload);

    try {
        const parsed = JSON.parse(rawPayload) as unknown;
        const leaves = new Set<string>();
        collectStringLeaves(parsed, leaves);
        for (const leaf of leaves) addCandidatesFromText(leaf);
    } catch {
        // Not JSON; the direct and line-wise passes already covered it.
    }

    return Array.from(extracted);
}

/** Turn a dropped `file://` URI back into a plain path. */
export function normalizeDroppedPath(rawPath: string): string {
    const input = rawPath.trim();
    if (!input.toLowerCase().startsWith(FILE_URI_PREFIX)) {
        return input;
    }

    try {
        let pathname = decodeURIComponent(new URL(input).pathname || '');
        // file:///C:/... parses with a leading slash before the drive letter.
        if (/^\/[A-Za-z]:\//.test(pathname)) {
            pathname = pathname.slice(1);
        }
        return pathname || input;
    } catch {
        const stripped = input.replace(/^file:\/\//i, '');
        try {
            return decodeURIComponent(stripped);
        } catch {
            return stripped;
        }
    }
}

/**
 * Normalize a directory or file path for comparison: forward slashes, no
 * trailing separator. Returns null for anything blank, so callers can treat
 * "no path" and "unusable path" the same way.
 */
export function normalizePath(value?: string | null): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    const normalized = trimmed.replace(/\\/g, '/');
    if (normalized === '/') return '/';
    return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
}

/**
 * Express an absolute path relative to the project root, so the prompt carries
 * the path the user recognizes. Paths outside the root are left absolute.
 */
export function toProjectRelativeMentionPath(absolutePath: string, root: string): string {
    const normalizedAbsolutePath = absolutePath.replace(/\\/g, '/').trim();
    const normalizedRoot = (root || '').replace(/\\/g, '/').replace(/\/+$/, '');
    if (!normalizedRoot) return normalizedAbsolutePath;
    if (normalizedAbsolutePath === normalizedRoot) return normalizedAbsolutePath;

    const rootWithSlash = `${normalizedRoot}/`;
    return normalizedAbsolutePath.startsWith(rootWithSlash)
        ? normalizedAbsolutePath.slice(rootWithSlash.length)
        : normalizedAbsolutePath;
}

/** Data transfer types VS Code uses when dragging from its explorer. */
export const VS_CODE_DROP_DATA_TYPES = [
    'CodeFiles',
    'codefiles',
    'application/vnd.code.tree',
    'application/vnd.code.tree.explorer',
    'text/uri-list',
    'text/plain',
];
