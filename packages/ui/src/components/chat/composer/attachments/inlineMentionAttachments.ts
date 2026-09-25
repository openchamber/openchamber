import { FilesystemError } from '@/lib/api/files-errors';
import type { AttachedFile } from '@/stores/types/sessionTypes';

/** Minimal surface of the directory listing used for existence checks. */
export interface DirectoryLister {
    listLocalDirectory(directory: string): Promise<Array<{ path: string }>>;
}

/**
 * ID prefix for attachments synthesized from inline `@`-mentions at send
 * time (see `extractInlineFileMentions` in ChatInput). The prefix is the only
 * marker distinguishing a guessed mention path from a file the user picked
 * deliberately, so keep both sites on this constant.
 */
export const INLINE_SERVER_ATTACHMENT_ID_PREFIX = 'inline-server-';

const normalizePath = (path: string): string => {
    const normalized = path.replace(/\\/g, '/').replace(/\/+/g, '/');
    // `@src/` names the directory itself; its listing entry has no slash.
    return normalized.length > 1 ? normalized.replace(/\/$/, '') : normalized;
};

const parentDirectoryOf = (path: string): string => {
    const normalized = normalizePath(path);
    const index = normalized.lastIndexOf('/');
    if (index <= 0) return '/';
    return normalized.slice(0, index);
};

export interface FilteredInlineAttachments {
    sendable: AttachedFile[];
    skippedNames: string[];
}

/**
 * Drop inline `@`-mention attachments whose file does not exist (#3898).
 *
 * Mention paths are guessed from text, so a handle or email domain
 * (`@masha.conner`) resolves to a `file://` URI that OpenCode stats on send
 * and rejects the whole prompt with a 400 when missing. The prompt text
 * itself is untouched — only the phantom attachment is dropped, so the rest
 * still submits.
 *
 * Fail open per directory: when a listing errors for any reason other than
 * the directory not existing, that directory's attachments are kept rather
 * than blocking the send on a check that could not run.
 */
type InlineServerAttachment = AttachedFile & { serverPath: string };

const isInlineServerAttachment = (
    attachment: AttachedFile,
): attachment is InlineServerAttachment =>
    attachment.source === 'server'
    && !!attachment.serverPath
    && attachment.id.startsWith(INLINE_SERVER_ATTACHMENT_ID_PREFIX);

export async function filterMissingInlineAttachments(
    attachments: readonly AttachedFile[],
    lister: DirectoryLister,
): Promise<FilteredInlineAttachments> {
    const inline = attachments.filter(isInlineServerAttachment);
    if (inline.length === 0) {
        return { sendable: [...attachments], skippedNames: [] };
    }

    const byDirectory = new Map<string, InlineServerAttachment[]>();
    for (const attachment of inline) {
        const directory = parentDirectoryOf(attachment.serverPath);
        const group = byDirectory.get(directory) ?? [];
        group.push(attachment);
        byDirectory.set(directory, group);
    }

    // Directories are listed in parallel: on a remote or relayed connection
    // each listing is a round-trip the send waits on.
    const results = await Promise.all([...byDirectory].map(async ([directory, files]) => {
        try {
            return { files, entries: await lister.listLocalDirectory(directory) };
        } catch (error) {
            // A parent directory that does not exist (`@types/node`,
            // `@acme.io/careers`) cannot hold the file. Any other failure
            // keeps that directory's attachments: the check could not run.
            const parentMissing = error instanceof FilesystemError
                && (error.reason === 'not-found' || error.reason === 'not-directory');
            return { files, entries: parentMissing ? [] : null };
        }
    }));

    const missing = new Set<AttachedFile>();
    for (const { files, entries } of results) {
        if (entries === null) continue;
        const present = new Set(entries.map((entry) => normalizePath(entry.path)));
        // Case-insensitive fallback: macOS and Windows resolve `readme.md` to
        // `README.md`, and VS Code reports a lowercase Windows drive letter.
        // On a case-sensitive disk this keeps the attachment, which is the
        // pre-check behaviour rather than a wrong drop.
        const presentFolded = new Set([...present].map((path) => path.toLowerCase()));
        for (const file of files) {
            const target = normalizePath(file.serverPath);
            if (!present.has(target) && !presentFolded.has(target.toLowerCase())) {
                missing.add(file);
            }
        }
    }
    if (missing.size === 0) {
        return { sendable: [...attachments], skippedNames: [] };
    }
    return {
        sendable: attachments.filter((attachment) => !missing.has(attachment)),
        skippedNames: [...missing].map((attachment) => attachment.filename),
    };
}
