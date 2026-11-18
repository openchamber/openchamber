import { FilesystemError } from '@/lib/api/files-errors';
import type { AttachedFile } from '@/stores/types/sessionTypes';
import { isLikelyAbsolutePath, normalizeDroppedPath } from './filePaths';

export interface DirectoryLister {
    listLocalDirectory(directory: string): Promise<Array<{ path: string }>>;
}

export const INLINE_SERVER_ATTACHMENT_ID_PREFIX = 'inline-server-';

const normalizePath = (path: string): string => {
    const normalized = path.replace(/\\/g, '/').replace(/\/+/g, '/');
    return normalized.length > 1 ? normalized.replace(/\/$/, '') : normalized;
};

const parentDirectoryOf = (path: string): string => {
    const normalized = normalizePath(path);
    const index = normalized.lastIndexOf('/');
    if (index <= 0) return '/';
    return normalized.slice(0, index);
};

const comparablePath = (raw: string | undefined): string | null => {
    if (!raw) return null;
    const input = raw.trim();
    if (/^file:\/\/[^/]/i.test(input) && !/^file:\/\/localhost\//i.test(input)) return null;
    const path = normalizeDroppedPath(input).replace(/\\/g, '/');
    return isLikelyAbsolutePath(path) ? path.replace(/\/$/, '') : null;
};

export function isMentionAlreadyAttached(
    mention: { serverPath: string; filename: string },
    attachments: readonly AttachedFile[],
): boolean {
    const mentionPath = comparablePath(mention.serverPath);
    if (!mentionPath) return false;
    return attachments.some((attachment) => {
        if (attachment.vscodeSource === 'selection') return false;
        const attachedPath = comparablePath(attachment.serverPath) ?? comparablePath(attachment.vscodePath);
        return attachedPath === mentionPath;
    });
}

export interface FilteredInlineAttachments {
    sendable: AttachedFile[];
    skippedNames: string[];
}

// external: #3898 OpenCode rejects the whole prompt when a guessed file attachment does not exist.
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

    const missingPaths = await findMissingPaths(inline.map((attachment) => attachment.serverPath), lister);
    if (missingPaths.size === 0) {
        return { sendable: [...attachments], skippedNames: [] };
    }
    const missing = new Set<AttachedFile>(inline.filter((attachment) => missingPaths.has(attachment.serverPath)));
    return {
        sendable: attachments.filter((attachment) => !missing.has(attachment)),
        skippedNames: [...missing].map((attachment) => attachment.filename),
    };
}

export async function findMissingPaths(
    paths: readonly string[],
    lister: DirectoryLister,
): Promise<Set<string>> {
    const byDirectory = new Map<string, string[]>();
    for (const path of paths) {
        const directory = parentDirectoryOf(path);
        const group = byDirectory.get(directory) ?? [];
        group.push(path);
        byDirectory.set(directory, group);
    }

    const results = await Promise.all([...byDirectory].map(async ([directory, files]) => {
        try {
            return { files, entries: await lister.listLocalDirectory(directory) };
        } catch (error) {
            const parentMissing = error instanceof FilesystemError
                && (error.reason === 'not-found' || error.reason === 'not-directory');
            return { files, entries: parentMissing ? [] : null };
        }
    }));

    const missing = new Set<string>();
    for (const { files, entries } of results) {
        if (entries === null) continue;
        const present = new Set(entries.map((entry) => normalizePath(entry.path)));
        const presentFolded = new Set([...present].map((path) => path.toLowerCase()));
        for (const file of files) {
            const target = normalizePath(file);
            if (!present.has(target) && !presentFolded.has(target.toLowerCase())) {
                missing.add(file);
            }
        }
    }
    return missing;
}
