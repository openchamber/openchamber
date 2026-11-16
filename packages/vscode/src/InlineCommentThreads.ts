
import * as vscode from 'vscode';

import { DELIVERY_CONFIRMATION_TIMEOUT_MS, canCommentOnDocument, nextDraftId, reconcileThreadFate, resolveCommentFilePath, resolveCommentOrigin, selectionLineRange, shouldAbandonUnconfirmed, shouldDisposeOnEmptyBody, snapshotOwnsThread, type CommentOrigin, type LineRange } from './inlineCommentSelection';

const INLINE_COMMENT_CONTROLLER_ID = 'openchamber.inlineComments';

export interface InlineCommentDraftPayload {
    draftId: string;
    filePath: string;
    relativePath: string;
    source: 'diff' | 'file';
    side?: 'original' | 'modified';
    startLine: number;
    endLine: number;
    code: string;
    language: string;
    comment: string;
}

interface OpenChamberCommentThread extends vscode.CommentThread {
    draftId?: string;
    commentOrigin?: CommentOrigin;
    commentBody?: string;
    confirmed?: boolean;
    surfaceId?: string;
    confirmationTimer?: ReturnType<typeof setTimeout>;
}

export const SIDEBAR_SURFACE_ID = 'sidebar';

export interface InlineCommentThreadsOptions {
    submitDraft: (payload: InlineCommentDraftPayload) => Promise<string | null> | string | null;
    removeDraft: (draftId: string) => void;
    reportUndelivered: () => void;
    avatar: vscode.Uri;
    strings: {
        threadLabel: (range: LineRange) => string;
        author: string;
        notSent: string;
    };
}

export class InlineCommentThreads implements vscode.Disposable {
    private readonly controller: vscode.CommentController;
    private readonly threadsByDraftId = new Map<string, OpenChamberCommentThread>();
    private readonly options: InlineCommentThreadsOptions;

    constructor(options: InlineCommentThreadsOptions) {
        this.options = options;
        this.controller = vscode.comments.createCommentController(
            INLINE_COMMENT_CONTROLLER_ID,
            'OpenChamber',
        );
        this.controller.commentingRangeProvider = {
            provideCommentingRanges: (document) => {
                if (!this.canCommentOn(document.uri)) return [];
                return [new vscode.Range(0, 0, Math.max(document.lineCount - 1, 0), 0)];
            },
        };
    }

    public canCommentOn(uri: vscode.Uri): boolean {
        const filePath = resolveCommentFilePath(uri.fsPath, uri.query);
        const inWorkspace = Boolean(vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath)));
        return canCommentOnDocument(uri.scheme, inWorkspace);
    }

    public openThread(uri: vscode.Uri, range: vscode.Range): vscode.CommentThread {
        const lines = selectionLineRange(range);
        // SAFETY: this controller creates and owns the thread; the added fields
        // are optional extension-local bookkeeping on VS Code's mutable object.
        const thread = this.controller.createCommentThread(uri, range, []) as OpenChamberCommentThread;
        thread.commentOrigin = this.resolveOrigin(uri);
        thread.label = this.options.strings.threadLabel(lines);
        thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
        thread.canReply = true;
        thread.contextValue = 'openchamberPending';
        return thread;
    }

    public async submitReply(reply: { thread: vscode.CommentThread; text: string }): Promise<void> {
        // SAFETY: this command is registered only for threads created by this
        // controller, which are initialized as OpenChamberCommentThread above.
        const thread = reply.thread as OpenChamberCommentThread;
        if (shouldDisposeOnEmptyBody(reply.text)) {
            this.disposeThread(thread);
            return;
        }

        const range = thread.range;
        if (!range) {
            this.disposeThread(thread);
            return;
        }

        const origin = thread.commentOrigin ?? this.resolveOrigin(thread.uri);
        thread.commentOrigin = origin;
        const document = await vscode.workspace.openTextDocument(thread.uri);
        const lines = selectionLineRange(range);
        const draftId = nextDraftId(Date.now(), Math.random());

        thread.label = this.options.strings.threadLabel(lines);

        const filePath = resolveCommentFilePath(thread.uri.fsPath, thread.uri.query);
        const fileUri = vscode.Uri.file(filePath);

        const payload: InlineCommentDraftPayload = {
            draftId,
            filePath,
            relativePath: vscode.workspace.asRelativePath(fileUri, false),
            ...origin,
            startLine: lines.startLine,
            endLine: lines.endLine,
            code: document.getText(range),
            language: document.languageId,
            comment: reply.text,
        };

        const surfaceId = await this.options.submitDraft(payload);
        if (!surfaceId) {
            this.disposeThread(thread);
            return;
        }

        thread.surfaceId = surfaceId;
        thread.draftId = draftId;
        thread.commentBody = reply.text;
        thread.canReply = false;
        thread.contextValue = 'openchamberAttached';
        thread.comments = [this.buildComment(reply.text)];
        this.threadsByDraftId.set(draftId, thread);

        thread.confirmationTimer = setTimeout(() => {
            thread.confirmationTimer = undefined;
            if (!shouldAbandonUnconfirmed(thread.confirmed)) return;
            this.options.removeDraft(draftId);
            this.disposeThread(thread);
            this.options.reportUndelivered();
        }, DELIVERY_CONFIRMATION_TIMEOUT_MS);
    }

    private resolveOrigin(uri: vscode.Uri): CommentOrigin {
        const activeTabInput = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
        if (activeTabInput instanceof vscode.TabInputTextDiff) {
            return resolveCommentOrigin(uri.toString(), uri.scheme, {
                original: activeTabInput.original.toString(),
                modified: activeTabInput.modified.toString(),
            });
        }
        return resolveCommentOrigin(uri.toString(), uri.scheme);
    }

    public reconcile(surfaceId: string, drafts: ReadonlyArray<{ id: string; text: string }>): void {
        const byId = new Map(drafts.map((draft) => [draft.id, draft.text]));

        for (const [draftId, thread] of [...this.threadsByDraftId]) {
            if (!snapshotOwnsThread(thread.surfaceId, surfaceId)) continue;
            const text = byId.get(draftId);
            const fate = reconcileThreadFate(text, Boolean(thread.confirmed));

            if (fate === 'wait') continue;
            if (fate === 'dispose') {
                this.disposeThread(thread);
                continue;
            }

            thread.confirmed = true;
            if (thread.confirmationTimer) {
                clearTimeout(thread.confirmationTimer);
                thread.confirmationTimer = undefined;
            }
            if (text !== undefined && thread.commentBody !== text) {
                thread.commentBody = text;
                thread.comments = [this.buildComment(text)];
            }
        }
    }

    public removeThread(thread: vscode.CommentThread): void {
        // SAFETY: removeThread is wired only to this controller's comment menu.
        const draftId = (thread as OpenChamberCommentThread).draftId;
        if (draftId) {
            this.options.removeDraft(draftId);
        }
        this.disposeThread(thread);
    }

    public dispose(): void {
        for (const thread of this.threadsByDraftId.values()) {
            if (thread.confirmationTimer) clearTimeout(thread.confirmationTimer);
        }
        this.threadsByDraftId.clear();
        this.controller.dispose();
    }

    private buildComment(body: string): vscode.Comment {
        const rendered = new vscode.MarkdownString();
        rendered.appendText(body);

        return {
            body: rendered,
            mode: vscode.CommentMode.Preview,
            author: { name: this.options.strings.author, iconPath: this.options.avatar },
            label: this.options.strings.notSent,
            contextValue: 'openchamberAttached',
        };
    }

    private disposeThread(thread: OpenChamberCommentThread): void {
        if (thread.confirmationTimer) {
            clearTimeout(thread.confirmationTimer);
            thread.confirmationTimer = undefined;
        }
        if (thread.draftId) {
            this.threadsByDraftId.delete(thread.draftId);
        }
        thread.dispose();
    }
}
