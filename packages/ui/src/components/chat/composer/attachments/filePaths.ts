
const FILE_URI_PREFIX = 'file://';

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

export function toServerFileUrl(filepath: string): string {
    const normalized = filepath.replace(/\\/g, '/').trim();
    if (normalized.toLowerCase().startsWith(FILE_URI_PREFIX)) {
        return normalized;
    }
    return `file://${encodeFilePath(normalized)}`;
}

export function isLikelyAbsolutePath(value: string): boolean {
    return value.startsWith('/')
        || value.startsWith('\\\\')
        || /^[A-Za-z]:[\\/]/.test(value);
}

export function toLikelyFileDropReference(value: string): string | null {
    const trimmed = value.trim().replace(/^['"]+|['"]+$/g, '');
    if (!trimmed) return null;
    if (/[\r\n]/.test(trimmed)) return null;
    if (trimmed.toLowerCase().startsWith(FILE_URI_PREFIX)) return trimmed;
    if (isLikelyAbsolutePath(trimmed)) return trimmed;
    return null;
}

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

export function normalizeDroppedPath(rawPath: string): string {
    const input = rawPath.trim();
    if (!input.toLowerCase().startsWith(FILE_URI_PREFIX)) {
        return input;
    }

    try {
        let pathname = decodeURIComponent(new URL(input).pathname || '');
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

export { normalizePath } from '@/lib/pathNormalization';

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

export const VS_CODE_DROP_DATA_TYPES = [
    'CodeFiles',
    'codefiles',
    'application/vnd.code.tree',
    'application/vnd.code.tree.explorer',
    'text/uri-list',
    'text/plain',
];
