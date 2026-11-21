
import * as vscode from 'vscode';

import { DELIVERY_CONFIRMATION_TIMEOUT_MS, canCommentOnDocument, composingThreadFate, nextDraftId, reconcileThreadFate, resolveCommentFilePath, resolveCommentOrigin, selectionLineRange, shiftLineRangeOnEdits, shouldAbandonUnconfirmed, shouldDisposeOnEmptyBody, snapshotOwnsThread, type CommentOrigin, type LineEdit, type LineRange } from './inlineCommentSelection';

const INLINE_COMMENT_CONTROLLER_ID = 'openchamber.inlineComments';

export function writesInChatComposer(): boolean {
    return vscode.workspace.getConfiguration('openchamber').get<string>('lineCommentPlacement') === 'chat';
}

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
    openInComposer?: boolean;
}

export type LineCommentMessage = Omit<InlineCommentDraftPayload, 'draftId'> & { draftId?: string };

interface OpenChamberCommentThread extends vscode.CommentThread {
    draftId?: string;
    composedInChat?: boolean;
    anchorLines?: LineRange;
    commentOrigin?: CommentOrigin;
    commentBody?: string;
    confirmed?: boolean;
    surfaceId?: string;
    confirmationTimer?: ReturnType<typeof setTimeout>;
}

export const SIDEBAR_SURFACE_ID = 'sidebar';

interface PendingComposition {
    uri: vscode.Uri;
    lines: LineRange;
    origin: CommentOrigin;
    surfaceId: string;
    confirmed?: boolean;
    confirmationTimer?: ReturnType<typeof setTimeout>;
}

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
    private readonly compositionsByDraftId = new Map<string, PendingComposition>();
    private pendingAnchorListener: vscode.Disposable | undefined;
    private readonly placementListener: vscode.Disposable;
    private readonly options: InlineCommentThreadsOptions;

    constructor(options: InlineCommentThreadsOptions) {
        this.options = options;
        this.controller = vscode.comments.createCommentController(
            INLINE_COMMENT_CONTROLLER_ID,
            'OpenChamber',
        );
        this.assignCommentingRanges();
        this.placementListener = vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration('openchamber.lineCommentPlacement')) this.assignCommentingRanges();
        });
    }

    private assignCommentingRanges(): void {
        this.controller.commentingRangeProvider = {
            provideCommentingRanges: (document) => {
                if (!this.canCommentOn(document.uri)) return [];
                if (writesInChatComposer()) return [];
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

    public async composeInChat(uri: vscode.Uri, range: vscode.Range): Promise<void> {
        const origin = this.resolveOrigin(uri);
        const { payload, lines } = await this.buildPayload(uri, range, '', origin);
        payload.openInComposer = true;

        const surfaceId = await this.options.submitDraft(payload);
        if (!surfaceId) {
            this.options.reportUndelivered();
            return;
        }

        const pending: PendingComposition = {
            uri,
            lines,
            origin,
            surfaceId,
            confirmationTimer: setTimeout(() => {
                const current = this.compositionsByDraftId.get(payload.draftId);
                if (!current || current.confirmed) return;
                this.compositionsByDraftId.delete(payload.draftId);
                this.options.removeDraft(payload.draftId);
                this.options.reportUndelivered();
            }, DELIVERY_CONFIRMATION_TIMEOUT_MS),
        };
        this.compositionsByDraftId.set(payload.draftId, pending);
        this.ensurePendingAnchorListener();
    }

    private ensurePendingAnchorListener(): void {
        this.pendingAnchorListener ??= vscode.workspace.onDidChangeTextDocument((event) => {
            this.shiftPendingAnchors(event.document.uri, event.contentChanges);
        });
    }

    private shiftPendingAnchors(uri: vscode.Uri, changes: readonly vscode.TextDocumentContentChangeEvent[]): void {
        if (changes.length === 0) return;
        const edits: LineEdit[] = changes.map((change) => ({
            startLine: change.range.start.line + 1,
            endLine: change.range.end.line + 1,
            insertedLines: change.text.split('\n').length,
            endsAtLineStart: change.range.end.character === 0,
        }));
        for (const pending of this.compositionsByDraftId.values()) {
            if (pending.uri.toString() !== uri.toString()) continue;
            pending.lines = shiftLineRangeOnEdits(pending.lines, edits);
        }
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
        const { payload, lines } = await this.buildPayload(thread.uri, range, reply.text, origin);

        thread.label = this.options.strings.threadLabel(lines);

        const surfaceId = await this.options.submitDraft(payload);
        if (!surfaceId) {
            this.disposeThread(thread);
            return;
        }

        this.markAttached(thread, surfaceId, payload.draftId, reply.text);
    }

    private reconcileCompositions(surfaceId: string, byId: ReadonlyMap<string, string>): void {
        for (const [draftId, pending] of [...this.compositionsByDraftId]) {
            if (pending.surfaceId !== surfaceId) continue;
            const text = byId.get(draftId);

            if (text !== undefined && !pending.confirmed) {
                pending.confirmed = true;
                if (pending.confirmationTimer) {
                    clearTimeout(pending.confirmationTimer);
                    pending.confirmationTimer = undefined;
                }
            }

            const fate = composingThreadFate(text, Boolean(pending.confirmed));
            if (fate === 'wait') continue;

            this.compositionsByDraftId.delete(draftId);
            if (pending.confirmationTimer) clearTimeout(pending.confirmationTimer);
            if (this.compositionsByDraftId.size === 0) {
                this.pendingAnchorListener?.dispose();
                this.pendingAnchorListener = undefined;
            }
            if (fate === 'create' && text !== undefined) this.createComposedThread(draftId, pending, text);
        }
    }

    private createComposedThread(draftId: string, pending: PendingComposition, text: string): void {
        const { startLine, endLine } = pending.lines;
        const range = new vscode.Range(startLine - 1, 0, endLine - 1, 0);
        // SAFETY: this controller creates and owns the thread; the added fields
        // are optional extension-local bookkeeping on VS Code's mutable object.
        const thread = this.controller.createCommentThread(pending.uri, range, []) as OpenChamberCommentThread;
        thread.commentOrigin = pending.origin;
        thread.anchorLines = pending.lines;
        thread.label = this.options.strings.threadLabel(pending.lines);
        thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
        thread.confirmed = true;
        thread.composedInChat = true;
        this.markAttached(thread, pending.surfaceId, draftId, text);
    }

    private parkComposition(thread: OpenChamberCommentThread, surfaceId: string): void {
        const draftId = thread.draftId;
        const lines = thread.anchorLines ?? (thread.range ? selectionLineRange(thread.range) : undefined);
        if (!draftId || !lines) return;
        this.compositionsByDraftId.set(draftId, {
            uri: thread.uri,
            lines,
            origin: thread.commentOrigin ?? { source: 'file' },
            surfaceId,
            confirmed: true,
        });
        this.ensurePendingAnchorListener();
    }

    private markAttached(thread: OpenChamberCommentThread, surfaceId: string, draftId: string, text: string): void {
        thread.surfaceId = surfaceId;
        thread.draftId = draftId;
        thread.commentBody = text;
        thread.canReply = false;
        thread.contextValue = 'openchamberAttached';
        thread.comments = [this.buildComment(text)];
        this.threadsByDraftId.set(draftId, thread);
        this.startConfirmationTimer(thread);
    }

    private async buildPayload(
        uri: vscode.Uri,
        range: vscode.Range,
        text: string,
        origin: CommentOrigin,
    ): Promise<{ payload: InlineCommentDraftPayload; lines: LineRange }> {
        const document = await vscode.workspace.openTextDocument(uri);
        const lines = selectionLineRange(range);

        const filePath = resolveCommentFilePath(uri.fsPath, uri.query);
        const fileUri = vscode.Uri.file(filePath);

        return {
            lines,
            payload: {
                draftId: nextDraftId(Date.now(), Math.random()),
                filePath,
                relativePath: vscode.workspace.asRelativePath(fileUri, false),
                ...origin,
                startLine: lines.startLine,
                endLine: lines.endLine,
                code: document.getText(range),
                language: document.languageId,
                comment: text,
            },
        };
    }

    private startConfirmationTimer(thread: OpenChamberCommentThread): void {
        const draftId = thread.draftId;
        if (thread.confirmed || !draftId) return;
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

        this.reconcileCompositions(surfaceId, byId);

        for (const [draftId, thread] of [...this.threadsByDraftId]) {
            if (!snapshotOwnsThread(thread.surfaceId, surfaceId)) continue;
            const text = byId.get(draftId);

            if (thread.composedInChat) {
                const emptied = composingThreadFate(text, true);
                if (emptied !== 'create') {
                    if (emptied === 'wait') this.parkComposition(thread, surfaceId);
                    this.disposeThread(thread);
                    continue;
                }
            }

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
        for (const pending of this.compositionsByDraftId.values()) {
            if (pending.confirmationTimer) clearTimeout(pending.confirmationTimer);
        }
        this.compositionsByDraftId.clear();
        this.pendingAnchorListener?.dispose();
        this.pendingAnchorListener = undefined;
        for (const thread of this.threadsByDraftId.values()) {
            if (thread.confirmationTimer) clearTimeout(thread.confirmationTimer);
        }
        this.threadsByDraftId.clear();
        this.placementListener.dispose();
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
