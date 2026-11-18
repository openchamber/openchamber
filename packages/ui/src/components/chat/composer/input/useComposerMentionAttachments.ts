import type { useComposerSessionScope } from './useComposerSessionScope';
import type { useComposerSelection } from './useComposerSelection';
import type { useComposerMentionPaths } from './useComposerMentionPaths';
import type { useComposerLanguage } from './useComposerLanguage';
import type { useComposerDraftText } from './useComposerDraftText';
import React from 'react';
import { prepareLocalAttachments } from '@/sync/input-store';
import { isReadOnSendMentionFilename } from '@/sync/attachment-files';
import type { AttachedFile } from '@/stores/types/sessionTypes';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { opencodeClient } from '@/lib/opencode/client';
import { isFileMentionCandidate, isMentionDismissed, scanMentions } from '../../composer/language/mentions';
import { toServerFileUrl } from '../../composer/attachments/filePaths';
import { INLINE_SERVER_ATTACHMENT_ID_PREFIX, findMissingPaths, isMentionAlreadyAttached } from '../../composer/attachments/inlineMentionAttachments';
import { useFileMentionCheck } from '../../composer/state/useFileMentionCheck';

type Dependencies = {
    language: Pick<ReturnType<typeof useComposerLanguage>, 'knownAgentNamesRef' | 'setConfirmedMentionsRevision'>;
    draftText: Pick<ReturnType<typeof useComposerDraftText>, 'confirmedMentionsRef' | 'composerText'>;
    mentionPaths: Pick<ReturnType<typeof useComposerMentionPaths>, 'chatSearchDirectory'>;
    sessionScope: Pick<ReturnType<typeof useComposerSessionScope>, 'inputMode' | 'isBtwActive'>;
    selection: Pick<ReturnType<typeof useComposerSelection>, 'agents'>;
};

export function useComposerMentionAttachments({
    language, draftText, mentionPaths, sessionScope, selection,
}: Dependencies) {
    const { knownAgentNamesRef, setConfirmedMentionsRevision } = language;
    const { confirmedMentionsRef, composerText } = draftText;
    const { chatSearchDirectory } = mentionPaths;
    const { inputMode, isBtwActive } = sessionScope;
    const { agents } = selection;

    const sanitizeAttachmentsForSend = React.useCallback(
        (files: readonly AttachedFile[] | undefined): AttachedFile[] => [...(files ?? [])]
            .map((file) => ({
                ...file,
                dataUrl: file.source === 'server' && file.serverPath
                    ? toServerFileUrl(file.serverPath)
                    : file.dataUrl,
            })),
        [],
    );

    const resolveInlineFileMention = React.useCallback((mentionPath: string): { serverPath: string; filename: string; root: string } | null => {
        const isCandidate = isFileMentionCandidate(mentionPath, {
            knownAgentNames: knownAgentNamesRef.current,
            confirmedMentions: confirmedMentionsRef.current,
        });
        if (!isCandidate) return null;

        const normalizedMentionPath = mentionPath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
        if (!normalizedMentionPath) return null;

        const clientDirectory = opencodeClient.getDirectory() || '';
        const root = (chatSearchDirectory || clientDirectory).replace(/\\/g, '/').replace(/\/+$/, '');
        let serverPath: string | null = null;
        if (mentionPath.startsWith('/')) {
            serverPath = mentionPath.replace(/\\/g, '/');
        } else if (root) {
            serverPath = `${root}/${normalizedMentionPath}`;
        }
        if (!serverPath) return null;

        return {
            serverPath: serverPath.replace(/\/+/g, '/'),
            filename: normalizedMentionPath.split('/').filter(Boolean).pop() || normalizedMentionPath,
            root,
        };
    }, [chatSearchDirectory, confirmedMentionsRef, knownAgentNamesRef]);

    const resolveFileMentionPath = React.useCallback(
        (name: string) => resolveInlineFileMention(name)?.serverPath ?? null,
        [resolveInlineFileMention],
    );

    const repaintConfirmedMentions = React.useCallback(() => setConfirmedMentionsRevision((revision) => revision + 1), [setConfirmedMentionsRevision]);

    useFileMentionCheck({
        text: composerText,
        enabled: inputMode === 'normal' && !isBtwActive,
        confirmedMentionsRef,
        resolvePath: resolveFileMentionPath,
        lister: opencodeClient,
        onConfirmed: repaintConfirmedMentions,
    });

    const mentionableAgents = React.useCallback(
        () => agents.filter((agent) => !isMentionDismissed(agent.name.toLowerCase(), confirmedMentionsRef.current)),
        [agents, confirmedMentionsRef],
    );

    const extractInlineFileMentions = React.useCallback((
        rawText: string,
        preparedMentions: ReadonlyMap<string, AttachedFile[]>,
        existingAttachments: readonly AttachedFile[],
    ) => {
        if (!rawText || !rawText.includes('@')) {
            return { sanitizedText: rawText, attachments: [] };
        }

        const seenPaths = new Set<string>();
        const attachments: AttachedFile[] = [];

        for (const token of scanMentions(rawText, confirmedMentionsRef.current)) {
            const mention = resolveInlineFileMention(token.name);
            if (!mention || seenPaths.has(mention.serverPath)) continue;
            if (isMentionAlreadyAttached(mention, existingAttachments)) continue;
            seenPaths.add(mention.serverPath);

            const prepared = preparedMentions.get(mention.serverPath);
            if (prepared) {
                attachments.push(...prepared);
                continue;
            }
            attachments.push({
                id: `${INLINE_SERVER_ATTACHMENT_ID_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
                file: new File([], mention.filename, { type: 'text/plain' }),
                filename: mention.filename,
                mimeType: 'text/plain',
                size: 0,
                dataUrl: toServerFileUrl(mention.serverPath),
                source: 'server',
                serverPath: mention.serverPath,
            });
        }

        return {
            sanitizedText: rawText,
            attachments,
        };
    }, [resolveInlineFileMention, confirmedMentionsRef]);

    type ReadOnSendMentionPreparation =
        | { status: 'ready'; prepared: Map<string, AttachedFile[]> }
        | { status: 'failed'; filename: string }
        | { status: 'runtime-changed' };

    const prepareReadOnSendMentions = React.useCallback(async (
        texts: readonly string[],
        reservedFilenames: Set<string>,
        runtimeKey: string,
        alreadyAttached: readonly AttachedFile[],
    ): Promise<ReadOnSendMentionPreparation> => {
        const prepared = new Map<string, AttachedFile[]>();
        for (const rawText of texts) {
            const mentions = scanMentions(rawText, confirmedMentionsRef.current).flatMap((token) => {
                const mention = resolveInlineFileMention(token.name);
                return mention && isReadOnSendMentionFilename(mention.filename) ? [mention] : [];
            });
            const missing = await findMissingPaths(mentions.map((mention) => mention.serverPath), opencodeClient);
            if (getRuntimeKey() !== runtimeKey) return { status: 'runtime-changed' };
            for (const mention of mentions) {
                if (
                    missing.has(mention.serverPath)
                    || prepared.has(mention.serverPath)
                    || isMentionAlreadyAttached(mention, alreadyAttached)
                ) {
                    continue;
                }
                try {
                    const response = await runtimeFetch('/api/fs/raw', {
                        query: { path: mention.serverPath, directory: mention.root || undefined },
                    });
                    if (!response.ok) throw new Error(`Failed to read ${mention.filename}`);
                    const sourceBlob = await response.blob();
                    if (getRuntimeKey() !== runtimeKey) return { status: 'runtime-changed' };
                    const source = new File([sourceBlob], mention.filename);
                    const converted = await prepareLocalAttachments(source, reservedFilenames);
                    if (!converted || converted.length === 0) throw new Error(`Failed to prepare ${mention.filename}`);
                    if (getRuntimeKey() !== runtimeKey) return { status: 'runtime-changed' };
                    prepared.set(mention.serverPath, converted);
                    for (const attachment of converted) reservedFilenames.add(attachment.filename);
                } catch {
                    if (getRuntimeKey() !== runtimeKey) return { status: 'runtime-changed' };
                    return { status: 'failed', filename: mention.filename };
                }
            }
        }
        return { status: 'ready', prepared };
    }, [resolveInlineFileMention, confirmedMentionsRef]);

    return {
        sanitizeAttachmentsForSend, prepareReadOnSendMentions, mentionableAgents, extractInlineFileMentions,
    };
}
