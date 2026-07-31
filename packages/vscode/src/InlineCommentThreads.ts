/**
 * Code comments written in the editor itself.
 *
 * A comment is written while looking at the code it is about, so it is captured
 * where the code is: right-click a selection (or use the gutter `+`) and a
 * thread opens on those lines. The thread stays anchored there, showing what
 * will be sent, until the message goes out or the comment is dropped.
 *
 * The composer's chips remain the list of what is attached. This module is the
 * editor-side view of that same list, which is why it never owns a draft: it
 * mints the id, hands the draft to the webview, and disposes its thread when
 * the webview reports the draft gone. The webview store stays authoritative,
 * so a comment removed from the chip row cannot linger in the editor.
 */

import * as vscode from 'vscode';

import { nextDraftId, reconcileThreadFate, resolveCommentFilePath, selectionLineRange, shouldDisposeOnEmptyBody, type LineRange } from './inlineCommentSelection';

// Also written literally in package.json, which gates the thread menus with
// `commentController == openchamber.inlineComments`. JSON cannot import, so the
// two have to be kept in step by hand.
const INLINE_COMMENT_CONTROLLER_ID = 'openchamber.inlineComments';

export interface InlineCommentDraftPayload {
    draftId: string;
    filePath: string;
    relativePath: string;
    startLine: number;
    endLine: number;
    code: string;
    language: string;
    comment: string;
}

interface OpenChamberCommentThread extends vscode.CommentThread {
    draftId?: string;
    /** Last body written to this thread, so reconciliation can skip no-op renders. */
    commentBody?: string;
    /**
     * Whether the composer has ever reported holding this draft.
     *
     * Delivery is asynchronous, so a snapshot can arrive describing the moment
     * before the draft landed. Absence only means "removed" once presence has
     * been seen at least once.
     */
    confirmed?: boolean;
}

export interface InlineCommentThreadsOptions {
    /** Hands a finished draft to the chat webview. Returns false when nothing accepted it. */
    submitDraft: (payload: InlineCommentDraftPayload) => boolean | Promise<boolean>;
    /** Asks the webview to drop a draft the user removed from the editor side. */
    removeDraft: (draftId: string) => void;
    /** The extension's own icon, shown as the comment's avatar. */
    avatar: vscode.Uri;
    /** Localized strings, injected so this module does not reach for the l10n bundle. */
    strings: {
        threadLabel: (range: LineRange) => string;
        author: string;
        notSent: string;
    };
}

/**
 * Owns the comment controller and every thread currently on screen.
 *
 * Threads are keyed by draft id once submitted. Before submission a thread has
 * no draft yet, so it is tracked only by the controller and disposed on cancel.
 */
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
        // Any line of any file can take a comment; the gutter `+` follows from this.
        this.controller.commentingRangeProvider = {
            provideCommentingRanges: (document) => {
                if (document.uri.scheme === 'comment') return [];
                return [new vscode.Range(0, 0, Math.max(document.lineCount - 1, 0), 0)];
            },
        };
    }

    /** Opens an empty thread on a selection, with the reply box focused. */
    public openThread(uri: vscode.Uri, range: vscode.Range): vscode.CommentThread {
        const lines = selectionLineRange(range);
        const thread = this.controller.createCommentThread(uri, range, []) as OpenChamberCommentThread;
        thread.label = this.options.strings.threadLabel(lines);
        thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
        thread.canReply = true;
        thread.contextValue = 'openchamberPending';
        return thread;
    }

    /**
     * Turns a typed reply into a draft the composer will send.
     *
     * An empty body is a cancel: the thread is disposed rather than left behind
     * as a comment that will never be sent.
     */
    public async submitReply(reply: { thread: vscode.CommentThread; text: string }): Promise<void> {
        const thread = reply.thread as OpenChamberCommentThread;
        if (shouldDisposeOnEmptyBody(reply.text)) {
            this.disposeThread(thread);
            return;
        }

        // A thread whose range the editor dropped (the file was closed or edited
        // out from under it) has nothing to anchor a comment to.
        const range = thread.range;
        if (!range) {
            this.disposeThread(thread);
            return;
        }

        const document = await vscode.workspace.openTextDocument(thread.uri);
        const lines = selectionLineRange(range);
        const draftId = nextDraftId(Date.now(), Math.random());

        // The gutter `+` produces a thread VS Code created, which never went
        // through openThread and so carries no label. Set it here so both entry
        // points read the same.
        thread.label = this.options.strings.threadLabel(lines);

        // Quote the pane the user commented on, but name the real file: a diff's
        // original side is a `git:` document, and its raw path is not something
        // the composer can match against the workspace.
        const filePath = resolveCommentFilePath(thread.uri.fsPath, thread.uri.query);
        const fileUri = vscode.Uri.file(filePath);

        const payload: InlineCommentDraftPayload = {
            draftId,
            filePath,
            relativePath: vscode.workspace.asRelativePath(fileUri),
            startLine: lines.startLine,
            endLine: lines.endLine,
            code: document.getText(range),
            language: document.languageId,
            comment: reply.text,
        };

        const accepted = await this.options.submitDraft(payload);
        if (!accepted) {
            // Nothing took the draft (no chat surface open). Leaving the thread
            // would promise an attachment that does not exist.
            this.disposeThread(thread);
            return;
        }

        thread.draftId = draftId;
        thread.commentBody = reply.text;
        thread.canReply = false;
        thread.contextValue = 'openchamberAttached';
        thread.comments = [this.buildComment(reply.text)];
        this.threadsByDraftId.set(draftId, thread);
    }

    /**
     * Brings the editor threads in line with what the composer actually holds.
     *
     * The webview sends its whole current draft list rather than individual
     * events, so a dropped or reordered notification cannot leave a thread
     * anchored to a comment that will never be sent. Sending the message empties
     * the list, which clears every thread through the same path.
     *
     * Only threads this controller created are ever touched, so an unknown id in
     * the snapshot (a comment written in the in-app file viewer) is ignored
     * rather than treated as something to reconcile.
     */
    public reconcile(drafts: ReadonlyArray<{ id: string; text: string }>): void {
        const byId = new Map(drafts.map((draft) => [draft.id, draft.text]));

        for (const [draftId, thread] of [...this.threadsByDraftId]) {
            const text = byId.get(draftId);
            const fate = reconcileThreadFate(text, Boolean(thread.confirmed));

            if (fate === 'wait') continue;
            if (fate === 'dispose') {
                this.disposeThread(thread);
                continue;
            }

            thread.confirmed = true;
            if (text !== undefined && thread.commentBody !== text) {
                thread.commentBody = text;
                thread.comments = [this.buildComment(text)];
            }
        }
    }

    /**
     * Removes a thread from the editor side.
     *
     * A thread that already carries a draft has to tell the composer, or the
     * chip would stay attached with nothing shown in the code.
     */
    public removeThread(thread: vscode.CommentThread): void {
        const draftId = (thread as OpenChamberCommentThread).draftId;
        if (draftId) {
            this.options.removeDraft(draftId);
        }
        this.disposeThread(thread);
    }

    public dispose(): void {
        this.threadsByDraftId.clear();
        this.controller.dispose();
    }

    private buildComment(body: string): vscode.Comment {
        // The body is the user's own prose, not a document: rendering it as
        // Markdown would eat underscores and asterisks they meant literally,
        // and a comment on code is full of both.
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
        if (thread.draftId) {
            this.threadsByDraftId.delete(thread.draftId);
        }
        thread.dispose();
    }
}
