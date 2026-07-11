export interface ImageAttachmentCandidate {
    name: string;
    type?: string;
}

export interface CitationRange {
    start: number;
    end: number;
}

const GENERIC_IMAGE_BASENAMES = new Set([
    'image',
    'screenshot',
    'screen-shot',
    'clipboard',
    'pasted-image',
    'pastedimage',
    'untitled',
    'unknown',
    'file',
    'blob',
]);

const IMAGE_MIME_EXTENSIONS: Record<string, string> = {
    'image/avif': 'avif',
    'image/bmp': 'bmp',
    'image/gif': 'gif',
    'image/heic': 'heic',
    'image/heif': 'heif',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/svg+xml': 'svg',
    'image/tiff': 'tiff',
    'image/webp': 'webp',
};

const normalizeFilenameKey = (filename: string): string => filename.trim().toLowerCase();

const isUnsafeFilenameChar = (char: string): boolean => (
    char.charCodeAt(0) < 32 || '<>:"/\\|?*[]'.includes(char)
);

const sanitizeFilename = (name: string): string => {
    const basename = name.replace(/\\/g, '/').split('/').pop() ?? '';
    return Array.from(basename)
        .map((char) => (isUnsafeFilenameChar(char) ? '-' : char))
        .join('')
        .replace(/\s+/g, ' ')
        .replace(/-+/g, '-')
        .trim();
};

const getMimeExtension = (mimeType?: string): string => {
    const normalized = mimeType?.trim().toLowerCase() ?? '';
    return IMAGE_MIME_EXTENSIONS[normalized] ?? 'png';
};

const splitImageFilename = (candidate: ImageAttachmentCandidate): { base: string; ext: string } => {
    const clean = sanitizeFilename(candidate.name);
    const fallbackExt = getMimeExtension(candidate.type);
    const lastDot = clean.lastIndexOf('.');

    if (lastDot > 0 && lastDot < clean.length - 1) {
        const rawExt = clean.slice(lastDot + 1).toLowerCase();
        if (/^[a-z0-9]{1,10}$/.test(rawExt)) {
            return {
                base: clean.slice(0, lastDot).trim() || 'image',
                ext: rawExt,
            };
        }
    }

    return {
        base: clean.trim() || 'image',
        ext: fallbackExt,
    };
};

export const isGenericImageFilename = (filename: string): boolean => {
    const { base } = splitImageFilename({ name: filename });
    const normalized = base
        .trim()
        .toLowerCase()
        .replace(/[\s_]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');

    if (GENERIC_IMAGE_BASENAMES.has(normalized)) {
        return true;
    }

    const withoutCopyCounter = normalized.replace(/-\(\d+\)$/g, '');
    if (withoutCopyCounter !== normalized && GENERIC_IMAGE_BASENAMES.has(withoutCopyCounter)) {
        return true;
    }

    return /^(image|file|unknown|untitled|blob)-\d+$/.test(normalized);
};

const withExtension = (base: string, ext: string): string => `${base}.${ext}`;

const nextUniqueFilename = (base: string, ext: string, used: Set<string>): string => {
    const first = withExtension(base, ext);
    if (!used.has(normalizeFilenameKey(first))) {
        return first;
    }

    for (let index = 2; index < Number.MAX_SAFE_INTEGER; index += 1) {
        const candidate = withExtension(`${base}-${index}`, ext);
        if (!used.has(normalizeFilenameKey(candidate))) {
            return candidate;
        }
    }

    return withExtension(`${base}-${Date.now()}`, ext);
};

const nextGeneratedImageFilename = (ext: string, used: Set<string>): string => {
    for (let index = 1; index < Number.MAX_SAFE_INTEGER; index += 1) {
        const candidate = withExtension(`image-${index}`, ext);
        const generatedBaseTaken = Array.from(used).some((filename) => filename.startsWith(`image-${index}.`));
        if (!generatedBaseTaken && !used.has(normalizeFilenameKey(candidate))) {
            return candidate;
        }
    }

    return withExtension(`image-${Date.now()}`, ext);
};

export const assignImageAttachmentFilenames = (
    files: ImageAttachmentCandidate[],
    existingFilenames: string[],
): string[] => {
    const used = new Set(existingFilenames.map(normalizeFilenameKey));

    return files.map((file) => {
        const { base, ext } = splitImageFilename(file);
        const filename = isGenericImageFilename(withExtension(base, ext))
            ? nextGeneratedImageFilename(ext, used)
            : nextUniqueFilename(base, ext, used);
        used.add(normalizeFilenameKey(filename));
        return filename;
    });
};

export const buildAttachmentCitationText = (filenames: string[]): string => (
    filenames.map((filename) => `[${filename}]`).join(' ')
);

export const findAttachmentCitationRanges = (text: string, filenames: string[]): CitationRange[] => {
    if (!text || !text.includes('[') || filenames.length === 0) {
        return [];
    }

    const known = new Set(filenames.map(normalizeFilenameKey));
    const ranges: CitationRange[] = [];
    let cursor = 0;

    while (cursor < text.length) {
        const start = text.indexOf('[', cursor);
        if (start === -1) {
            break;
        }

        const end = text.indexOf(']', start + 1);
        if (end === -1) {
            break;
        }

        // Markdown links keep their normal link highlighting; attachment citations
        // are plain bracket references like [desktop.png].
        if (text[end + 1] !== '(') {
            const name = text.slice(start + 1, end).trim();
            if (known.has(normalizeFilenameKey(name))) {
                ranges.push({ start, end: end + 1 });
            }
        }

        cursor = end + 1;
    }

    return ranges;
};
