import * as React from 'react';

import { useMobileAppActions } from '@/apps/mobileAppContext';
import { useChatSessionSelection } from '@/components/chat/chatColumnSession';
import { useOpenTurnDiff } from '@/components/chat/message/useOpenTurnDiff';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import type { CommentLocationRequest } from '@/lib/commentLocation';
import { shortRef } from '@/lib/diffCommentOrigin';
import { isMiniChatWindow } from '@/lib/miniChatWindow';
import { normalizePath } from '@/lib/pathNormalization';
import { toAbsoluteFilePath } from '@/lib/path-utils';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useGitStore } from '@/stores/useGitStore';
import type { InlineCommentDraft, InlineCommentSource } from '@/stores/useInlineCommentDraftStore';
import { useUIStore } from '@/stores/useUIStore';

type CommentSource = Pick<InlineCommentDraft, 'fileLabel' | 'startLine' | 'side' | 'origin'>;

const OPENABLE_SOURCES: readonly InlineCommentSource[] = ['diff', 'file', 'file-quote'];

export const opensDiff = (origin: CommentSource['origin']): boolean => Boolean(origin && origin.kind !== 'working-tree');

export function useOpenCommentSource(directory: string | null) {
    const runtime = React.useContext(RuntimeAPIContext);
    const mobileActions = useMobileAppActions();
    const openTurnDiff = useOpenTurnDiff();
    const { sessionId } = useChatSessionSelection();
    const currentBranch = useGitStore((state) => (directory ? state.directories.get(directory)?.status?.current ?? null : null));
    const isVSCode = Boolean(runtime?.runtime.isVSCode);

    const canOpen = React.useCallback((comment: { source: InlineCommentSource; origin?: CommentSource['origin'] }): boolean => {
        if (!directory || isMiniChatWindow() || !OPENABLE_SOURCES.includes(comment.source)) return false;
        const { origin } = comment;
        if (!origin || origin.kind === 'working-tree') return true;
        if (origin.kind === 'turn') return Boolean(origin.turnId && sessionId);
        if (isVSCode) return false;
        if (origin.kind === 'branch' && (!origin.directory || normalizePath(origin.directory) === normalizePath(directory))) {
            return currentBranch !== null && shortRef(origin.headRef) === currentBranch;
        }
        return true;
    }, [currentBranch, directory, isVSCode, sessionId]);

    const open = React.useCallback((comment: CommentSource) => {
        if (!directory) return;
        const line = comment.startLine > 0 ? comment.startLine : null;
        const { origin } = comment;

        if (!origin || origin.kind === 'working-tree') {
            const filePath = toAbsoluteFilePath(directory, comment.fileLabel);
            if (runtime?.runtime.isVSCode && runtime.editor) {
                void runtime.editor.openFile(filePath, line ?? undefined);
                return;
            }
            const ui = useUIStore.getState();
            if (line) ui.openContextFileAtLine(directory, filePath, line, 1);
            else ui.openContextFile(directory, filePath);
            mobileActions?.openFiles();
            return;
        }

        if (origin.kind === 'turn') {
            if (origin.turnId && sessionId) openTurnDiff({ directory, file: comment.fileLabel, sessionId, turnId: origin.turnId });
            return;
        }

        const request: CommentLocationRequest = {
            runtimeKey: getRuntimeKey(),
            directory,
            filePath: comment.fileLabel,
            line,
            side: comment.side === 'original' ? 'deletions' : 'additions',
            origin,
        };
        if (mobileActions) {
            useUIStore.getState().setPendingCommentLocation(request);
            mobileActions.openChanges();
            return;
        }
        useUIStore.getState().openCommentLocation(request);
    }, [directory, mobileActions, openTurnDiff, runtime, sessionId]);

    return React.useMemo(() => ({ open, canOpen }), [canOpen, open]);
}
