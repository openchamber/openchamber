import { getLanguageFromExtension } from '@/lib/toolHelpers';
import { attachmentBasename } from '@/lib/attachmentIdentity';
import { normalizeDroppedPath } from '@/components/chat/composer/attachments/filePaths';
import type { ToolPopupContent } from '@/components/chat/message/types';

const TEXT_LIKE_MIME_PREFIXES = ['text/', 'application/json'];
const DIRECTORY_MIME = 'application/x-directory';
const REPOSITORY_ISSUE_LINK_MIME = 'application/vnd.openchamber.repository-issue-link';
// Messages shown before the provider moved into a parameter carry one type
// per provider; they stay readable as that provider's issue links.
const LEGACY_REPOSITORY_ISSUE_LINK_MIMES: ReadonlyMap<string, string> = new Map([
    ['application/vnd.github.issue-link', 'github'],
    ['application/vnd.openchamber.gitlab-issue-link', 'gitlab'],
]);
// Every provider's change requests share this type; the chip's mark is the generic pull request.
const CHANGE_REQUEST_LINK_MIME = 'application/vnd.github.pull-request-link';
const TRACKER_ITEM_LINK_MIME = 'application/vnd.openchamber.tracker-item-link';
// Messages shown before trackers had one type carry Linear's own.
const LEGACY_LINEAR_ISSUE_LINK_MIME = 'application/vnd.openchamber.linear-issue-link';
const GUEST_ISSUE_LINK_MIME = 'application/vnd.openchamber.guest-issue-link';
const GUEST_PR_LINK_MIME = 'application/vnd.openchamber.guest-pr-link';

export type IssueLinkKind = 'repository-issue' | 'change-request' | 'tracker-item' | 'guest-issue' | 'guest-pr';

/** The display type of a repository issue link part: the provider rides as a parameter. */
export const repositoryIssueLinkMime = (provider: string): string => `${REPOSITORY_ISSUE_LINK_MIME}; provider=${provider}`;

/** The display type of a tracker item link part: the tracker rides as a parameter. */
export const trackerItemLinkMime = (provider: string): string => `${TRACKER_ITEM_LINK_MIME}; provider=${provider}`;

/** The `provider` parameter of a type that is `base`; `''` when it has none, null for another type. */
const providerParameterOf = (mime: string, base: string): string | null => {
    const [type, ...parameters] = mime.split(';').map((segment) => segment.trim());
    if (type.toLowerCase() !== base) return null;
    for (const parameter of parameters) {
        const [name, value] = parameter.split('=');
        if (name?.trim().toLowerCase() === 'provider' && value) return value.trim();
    }
    return '';
};

/**
 * The provider of a repository issue link part, or null for any other part.
 * A neutral type without a `provider` parameter names no provider (`''`).
 */
export const getRepositoryIssueLinkProvider = (file: { mime?: string }): string | null => {
    if (!file.mime) return null;
    const legacy = LEGACY_REPOSITORY_ISSUE_LINK_MIMES.get(file.mime);
    if (legacy) return legacy;
    return providerParameterOf(file.mime, REPOSITORY_ISSUE_LINK_MIME);
};

/** The tracker of a tracker item link part (`''` when it names none), or null for any other part. */
export const getTrackerItemLinkProvider = (file: { mime?: string }): string | null => {
    if (!file.mime) return null;
    if (file.mime === LEGACY_LINEAR_ISSUE_LINK_MIME) return 'linear';
    return providerParameterOf(file.mime, TRACKER_ITEM_LINK_MIME);
};

/** The tracked-item kind of an issue/PR reference part, or null for an ordinary file. */
export const getIssueLinkKind = (file: { mime?: string }): IssueLinkKind | null => {
    if (getRepositoryIssueLinkProvider(file) !== null) return 'repository-issue';
    if (file.mime === CHANGE_REQUEST_LINK_MIME) return 'change-request';
    if (getTrackerItemLinkProvider(file) !== null) return 'tracker-item';
    if (file.mime === GUEST_ISSUE_LINK_MIME) return 'guest-issue';
    if (file.mime === GUEST_PR_LINK_MIME) return 'guest-pr';
    return null;
};

/** True when a file part's MIME type is text the popup can render as content. */
export const isTextLikeFile = (file: { mime?: string }): boolean => {
    const mime = file.mime;
    return mime !== undefined && TEXT_LIKE_MIME_PREFIXES.some((prefix) => mime.startsWith(prefix));
};

/**
 * Decodes the base64 data URL the message pipeline stores for pasted files
 * (`data:<mime>;base64,<data>`) into UTF-8 text. Returns null for any other
 * URL shape.
 */
export const decodeDataUrlText = (url: string): string | null => {
    const match = /^data:[^,]*;base64,(.+)$/.exec(url);
    if (!match) return null;
    try {
        const bytes = Uint8Array.from(atob(match[1]), (char) => char.charCodeAt(0));
        return new TextDecoder().decode(bytes);
    } catch {
        return null;
    }
};

/** The name an attachment chip shows: the basename of its file name. */
const attachmentDisplayName = (filename: string | undefined): string => {
    if (!filename) return 'file';
    return attachmentBasename(filename);
};

/** The fields of a message file part that decide how it opens. */
type AttachmentFile = { mime?: string; url?: string; filename?: string };

const isFileUrl = (url: string): boolean => url.toLowerCase().startsWith('file://');

/**
 * What opening an attachment of a sent message does:
 * - `external`: an issue or PR reference opens its page.
 * - `popup`: an image opens the image viewer with the message's other images,
 *   text sent inline (a pasted text, a picked text file) opens the text dialog.
 * - `file`: a file attached by path (`file://`, VS Code attachments and
 *   `@` mentions) opens in the app's file viewer, or the editor in VS Code.
 */
export type AttachmentOpenTarget =
    | { kind: 'external'; url: string }
    | { kind: 'popup'; popup: ToolPopupContent }
    | { kind: 'file'; path: string };

const imageGalleryOf = (files: readonly AttachmentFile[]) => files.flatMap((part) => (
    part.url && part.mime?.startsWith('image/') && !isFileUrl(part.url)
        ? [{ url: part.url, mimeType: part.mime, filename: attachmentDisplayName(part.filename) }]
        : []
));

/**
 * Resolves what clicking `file` opens; `files` are the message's attachments,
 * the gallery an image opens in. Null when there is nothing the app can show:
 * a PDF or other binary sent inline, a folder, text that does not decode.
 */
export const resolveAttachmentOpenTarget = (
    file: AttachmentFile | undefined,
    files: readonly AttachmentFile[],
): AttachmentOpenTarget | null => {
    if (!file?.url) return null;
    if (getIssueLinkKind(file) !== null) return { kind: 'external', url: file.url };

    // The server reads a by-path attachment from disk; the file viewer shows
    // it from there, whatever its type.
    if (isFileUrl(file.url)) {
        if (file.mime === DIRECTORY_MIME) return null;
        const path = normalizeDroppedPath(file.url);
        return path && !isFileUrl(path) ? { kind: 'file', path } : null;
    }

    const filename = attachmentDisplayName(file.filename);
    const mime = file.mime ?? '';
    if (mime.startsWith('image/')) {
        const gallery = imageGalleryOf(files);
        return {
            kind: 'popup',
            popup: {
                open: true,
                title: filename,
                content: '',
                metadata: { tool: 'image-preview', filename, mime },
                image: {
                    url: file.url,
                    mimeType: mime,
                    filename,
                    gallery,
                    index: Math.max(0, gallery.findIndex((entry) => entry.url === file.url)),
                },
            },
        };
    }

    if (!isTextLikeFile(file)) return null;
    const text = decodeDataUrlText(file.url);
    if (text === null) return null;
    return {
        kind: 'popup',
        popup: {
            open: true,
            title: filename,
            content: text,
            language: getLanguageFromExtension(filename) || undefined,
        },
    };
};

const filenameKey = (filename: string): string => attachmentBasename(filename).trim().toLowerCase();

/**
 * The message file a `[name]` citation names. Citations match attachments
 * case-insensitively (`findAttachmentCitationRanges`), so the lookup does too.
 */
export const findAttachmentPart = <T extends AttachmentFile>(
    filename: string | null | undefined,
    files: readonly T[],
): T | undefined => {
    const wanted = filenameKey(filename ?? '');
    if (!wanted) return undefined;
    return files.find((file) => file.filename !== undefined && filenameKey(file.filename) === wanted);
};

/** Normalized names of the attachments a citation chip can open, for `isOpenableAttachmentName`. */
export const collectOpenableAttachmentNames = (files: readonly AttachmentFile[]): ReadonlySet<string> => new Set(
    files.flatMap((file) => (
        file.filename && resolveAttachmentOpenTarget(file, files) !== null ? [filenameKey(file.filename)] : []
    )),
);

export const isOpenableAttachmentName = (openable: ReadonlySet<string>, filename: string): boolean => (
    openable.has(filenameKey(filename))
);
