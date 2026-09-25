/**
 * The parts a user message shows.
 *
 * Two things happen here. Linked issues and pull requests render as link
 * attachments rather than context cards, so their context parts are mapped to
 * the display-only file part `FileAttachment` understands. And a file part that
 * merely repeats the range an inline comment already quotes is dropped, so the
 * message does not show the same lines twice.
 */

import type { FilePart, Part, TextPart } from '@/lib/opencode/model';
import { readContextPart } from '@/lib/messages/contextParts';

const redundantCommentFileUrls = (parts: Part[]): Set<string> => {
    const comments = parts
        .map((part) => readContextPart(part))
        .filter((payload) => payload?.kind === 'code-comment');
    if (comments.length === 0) return new Set();

    const redundant = new Set<string>();
    for (const part of parts) {
        if (part.type !== 'file') continue;
        const { url } = part;
        const range = url.match(/[?&]start=(\d+)&end=(\d+)/);
        if (!range) continue;
        const encodedPath = url.replace(/^file:\/\//, '').split('?')[0];
        let path = encodedPath;
        try {
            path = decodeURIComponent(encodedPath);
        } catch {
            // Keep the encoded path; malformed URLs must not break rendering.
        }
        path = path.replace(/\\/g, '/');
        const matches = comments.some((comment) => {
            const commentPath = comment.fileLabel.replace(/\\/g, '/');
            return comment.startLine === Number(range[1])
                && comment.endLine === Number(range[2])
                && (path === commentPath || path.endsWith(`/${commentPath}`));
        });
        if (matches) redundant.add(url);
    }
    return redundant;
};

/**
 * The display-only file part a linked issue or pull request renders as. It
 * keeps the identity of the context part it replaces, and never goes back to
 * the server.
 */
const linkAttachmentPart = (part: TextPart): FilePart | null => {
    const payload = readContextPart(part);
    if (!payload) return null;

    const identity = { id: part.id, sessionID: part.sessionID, messageID: part.messageID };

    switch (payload.kind) {
        case 'github-issue':
            return {
                ...identity,
                type: 'file',
                mime: 'application/vnd.github.issue-link',
                filename: `Issue #${payload.number}: ${payload.title}`,
                url: payload.url,
            };
        case 'github-pr':
            return {
                ...identity,
                type: 'file',
                mime: 'application/vnd.github.pull-request-link',
                filename: `PR #${payload.number}: ${payload.title}`,
                url: payload.url,
            };
        case 'linear-issue':
            return {
                ...identity,
                type: 'file',
                mime: 'application/vnd.openchamber.linear-issue-link',
                filename: `${payload.identifier}: ${payload.title}`,
                url: payload.url,
            };
        case 'guest-issue':
            return {
                ...identity,
                type: 'file',
                mime: 'application/vnd.openchamber.guest-issue-link',
                filename: `${payload.id}: ${payload.title}`,
                url: payload.url,
            };
        case 'guest-pr':
            return {
                ...identity,
                type: 'file',
                mime: 'application/vnd.openchamber.guest-pr-link',
                filename: `PR ${payload.id}: ${payload.title}`,
                url: payload.url,
            };
        default:
            return null;
    }
};

export const normalizeUserDisplayParts = (parts: Part[]): Part[] => {
    const redundantFileUrls = redundantCommentFileUrls(parts);
    return parts
        .filter((part) => !(part.type === 'file' && redundantFileUrls.has(part.url)))
        .map((part) => (part.type === 'text' ? linkAttachmentPart(part) ?? part : part));
};
