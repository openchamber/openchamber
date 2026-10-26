import { getUnsupportedAttachmentInputs } from '@/sync/attachment-files';

interface ImageAttachmentCandidate {
    name: string;
    type?: string;
}

interface CitationRange {
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

/** Next unused `pasted-context-N.txt` name for a large text paste attachment. */
export const nextPastedContextFilename = (existingFilenames: string[]): string => {
    const used = new Set(existingFilenames.map(normalizeFilenameKey));

    for (let index = 1; index < Number.MAX_SAFE_INTEGER; index += 1) {
        const candidate = `pasted-context-${index}.txt`;
        if (!used.has(normalizeFilenameKey(candidate))) {
            return candidate;
        }
    }

    return `pasted-context-${Date.now()}.txt`;
};

/** The attachment carries the name its citation uses. */
export const renameFileForAttachmentCitation = (file: File, filename: string): File => {
    if (file.name === filename) {
        return file;
    }

    return new File([file], filename, {
        type: file.type,
        lastModified: file.lastModified,
    });
};

export const buildAttachmentCitationText = (filenames: string[]): string => (
    filenames.map((filename) => `[${filename}]`).join(' ')
);

/**
 * Markdown links to images saved where OpenCode runs, so a model without image
 * input (or its subagent) can open them by path. A plain link: a draft that
 * starts with `!` switches the composer into shell mode, so `![name](path)`
 * cannot lead a message. Windows paths get forward slashes, which every
 * Windows tool accepts and markdown does not read as escapes; a path with
 * spaces or parentheses goes in angle brackets.
 */
export const buildImagePathCitationText = (images: Array<{ filename: string; path: string }>): string => (
    images.map(({ filename, path }) => {
        const target = path.replace(/\\/g, '/');
        return `[${filename}](${/[\s()]/.test(target) ? `<${target}>` : target})`;
    }).join(' ')
);

/**
 * What the composer does with an image while the "save pasted images as files"
 * setting is on (`attach` while it is off). `instead`: a model without image
 * input gets the saved file linked by path and no attachment, which it could
 * not read (#5087). `alongside`: the model gets the attachment and the message
 * also links the saved file, for tools that need it (#5218). Unknown model
 * metadata counts as a model that takes the attachment.
 */
export const imageSaveModeForModel = (
    savePastedImagesAsFiles: boolean,
    inputModalities: string[] | undefined,
): 'instead' | 'alongside' | 'attach' => {
    if (!savePastedImagesAsFiles) return 'attach';
    if (inputModalities && getUnsupportedAttachmentInputs([{ mimeType: 'image/png' }], inputModalities).length > 0) {
        return 'instead';
    }
    return 'alongside';
};

/** Names of the markdown links already in the text, so a new paste picks a free one. */
export const findImagePathCitationNames = (text: string): string[] => (
    Array.from(text.matchAll(/\[([^\]\n]+)\]\(/g), (match) => match[1])
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
