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

import { DELIVERY_CONFIRMATION_TIMEOUT_MS, canCommentOnDocument, composingThreadFate, nextDraftId, reconcileThreadFate, resolveCommentFilePath, resolveCommentOrigin, selectionLineRange, shiftLineRangeOnEdits, shouldAbandonUnconfirmed, shouldDisposeOnEmptyBody, snapshotOwnsThread, type CommentOrigin, type LineEdit, type LineRange } from './inlineCommentSelection';

// Also written literally in package.json, which gates the thread menus with
// `commentController == openchamber.inlineComments`. JSON cannot import, so the
// two have to be kept in step by hand.
const INLINE_COMMENT_CONTROLLER_ID = 'openchamber.inlineComments';

/** The setting that decides where a code comment's text is written. */
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
    /** Whether the text is written in the chat composer instead of the editor thread. */
    openInComposer?: boolean;
}

interface OpenChamberCommentThread extends vscode.CommentThread {
    /** Whether the rendered comment still carries the "not delivered" label. */
    commentPending?: boolean;
    draftId?: string;
    /** Whether this thread's text is written in the chat composer. */
    composedInChat?: boolean;
    /** Diff identity captured while the thread's editor is authoritative. */
    commentOrigin?: CommentOrigin;
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
    /**
     * The chat webview holding this comment's draft.
     *
     * Only that surface's snapshots can decide this thread's fate; every other
     * webview has its own store where the draft never existed.
     */
    surfaceId?: string;
    /** Deadline for the composer to confirm it holds this draft. */
    confirmationTimer?: ReturnType<typeof setTimeout>;
}

/** Identifies one chat webview: a session panel id, or the sidebar. */
export const SIDEBAR_SURFACE_ID = 'sidebar';

/**
 * A comment whose text is being written in the chat composer.
 *
 * Nothing is anchored in the editor until the draft has text, so this records
 * what the thread will need when it appears.
 */
interface PendingComposition {
    uri: vscode.Uri;
    range: vscode.Range;
    /** Captured while the editor is still active; the chat reveal moves focus away. */
    origin: CommentOrigin;
    /** The chat webview that accepted the draft; only its snapshots can decide this comment's fate. */
    surfaceId: string;
    /** Set once a snapshot has shown the draft, so a later absence means it was cancelled. */
    confirmed?: boolean;
    confirmationTimer?: ReturnType<typeof setTimeout>;
}

export interface InlineCommentThreadsOptions {
    /**
     * Hands a finished draft to a chat webview.
     *
     * Returns the id of the surface that accepted it, or null when none did.
     * The identity matters: only that surface's later snapshots can speak for
     * this comment, because every webview holds its own draft store.
     */
    submitDraft: (payload: InlineCommentDraftPayload) => Promise<string | null> | string | null;
    /** Asks the webview to drop a draft the user removed from the editor side. */
    removeDraft: (draftId: string) => void;
    /** Tells the user a comment never reached the composer and was given up on. */
    reportUndelivered: () => void;
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
    private readonly compositionsByDraftId = new Map<string, PendingComposition>();
    /** Watches the documents of pending comments so their anchor lines keep up. */
    private pendingAnchorListener: vscode.Disposable | undefined;
    private readonly options: InlineCommentThreadsOptions;

    constructor(options: InlineCommentThreadsOptions) {
        this.options = options;
        this.controller = vscode.comments.createCommentController(
            INLINE_COMMENT_CONTROLLER_ID,
            'OpenChamber',
        );
        // Any line of a workspace file can take a comment, which is what puts
        // the `+` in the gutter. That `+` is not a shortcut to the thread
        // above: the workbench creates the thread itself through
        // `createCommentThreadTemplate` and renders its own header and input,
        // and an extension can neither observe nor restyle it. In `chat`
        // placement the comment belongs in the composer, so the range is not
        // offered rather than opening a box the setting opted out of.
        this.controller.commentingRangeProvider = {
            provideCommentingRanges: (document) => {
                if (!this.canCommentOn(document.uri)) return [];
                if (writesInChatComposer()) return [];
                return [new vscode.Range(0, 0, Math.max(document.lineCount - 1, 0), 0)];
            },
        };
    }

    /**
     * Whether this document can take a comment.
     *
     * Both entry points ask, so the gutter `+` and the right-click command
     * agree: a comment is filed against a workspace-relative path, and one
     * written outside the workspace would name a file that does not resolve.
     */
    public canCommentOn(uri: vscode.Uri): boolean {
        const filePath = resolveCommentFilePath(uri.fsPath, uri.query);
        const inWorkspace = Boolean(vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath)));
        return canCommentOnDocument(uri.scheme, inWorkspace);
    }

    /** Opens an empty thread on a selection, with the reply box focused. */
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

    /**
     * Opens a comment that is written in the chat composer instead of here.
     *
     * The editor keeps the anchor: the thread appears on these lines as soon as
     * the draft has text, and follows it from then on. The note itself is typed
     * above the composer, where the composer's own field lives.
     */
    public async composeInChat(uri: vscode.Uri, range: vscode.Range): Promise<void> {
        // Captured before the chat reveal: once the sidebar or a session panel
        // takes focus, the active tab no longer names the diff pane the user
        // commented on.
        const origin = this.resolveOrigin(uri);
        const { payload } = await this.buildPayload(uri, range, '', origin);
        payload.openInComposer = true;

        const surfaceId = await this.options.submitDraft(payload);
        if (!surfaceId) {
            this.options.reportUndelivered();
            return;
        }

        const pending: PendingComposition = {
            uri,
            range,
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

    /** Watches the documents of pending comments, once there is one to watch. */
    private ensurePendingAnchorListener(): void {
        this.pendingAnchorListener ??= vscode.workspace.onDidChangeTextDocument((event) => {
            this.shiftPendingAnchors(event.document.uri, event.contentChanges);
        });
    }

    /**
     * Keeps a pending comment on the code it was written against.
     *
     * The editor has no thread for it yet, so VS Code cannot move the anchor;
     * an agent editing the file while the comment is typed would otherwise
     * leave the thread on whatever now occupies those lines.
     */
    private shiftPendingAnchors(uri: vscode.Uri, changes: readonly vscode.TextDocumentContentChangeEvent[]): void {
        if (changes.length === 0) return;
        const edits: LineEdit[] = changes.map((change) => ({
            startLine: change.range.start.line + 1,
            endLine: change.range.end.line + 1,
            insertedLines: change.text.split('\n').length,
        }));
        for (const pending of this.compositionsByDraftId.values()) {
            if (pending.uri.toString() !== uri.toString()) continue;
            const lines = shiftLineRangeOnEdits(selectionLineRange(pending.range), edits);
            pending.range = new vscode.Range(lines.startLine - 1, 0, lines.endLine - 1, 0);
        }
    }

    /**
     * Turns a typed reply into a draft the composer will send.
     *
     * An empty body is a cancel: the thread is disposed rather than left behind
     * as a comment that will never be sent.
     */
    public async submitReply(reply: { thread: vscode.CommentThread; text: string }): Promise<void> {
        // SAFETY: this command is registered only for threads created by this
        // controller, which are initialized as OpenChamberCommentThread above.
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

        // Capture before the first await. Opening a git document can yield long
        // enough for tab focus to move, while the thread still belongs to the
        // diff pane where the user submitted it.
        const origin = thread.commentOrigin ?? this.resolveOrigin(thread.uri);
        thread.commentOrigin = origin;
        const { payload, lines } = await this.buildPayload(thread.uri, range, reply.text, origin);

        // The gutter `+` produces a thread VS Code created, which never went
        // through openThread and so carries no label. Set it here so both entry
        // points read the same.
        thread.label = this.options.strings.threadLabel(lines);

        const surfaceId = await this.options.submitDraft(payload);
        if (!surfaceId) {
            // Nothing took the draft (no chat surface open). Leaving the thread
            // would promise an attachment that does not exist.
            this.disposeThread(thread);
            return;
        }

        this.markAttached(thread, surfaceId, payload.draftId, reply.text);
    }

    /**
     * Turns a draft written in the composer into an editor thread the first time
     * it carries text, and forgets one cancelled before anything was written.
     */
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

    /** The thread a comment written in the composer anchors to, once it has text. */
    private createComposedThread(draftId: string, pending: PendingComposition, text: string): void {
        // SAFETY: this controller creates and owns the thread; the added fields
        // are optional extension-local bookkeeping on VS Code's mutable object.
        const thread = this.controller.createCommentThread(pending.uri, pending.range, []) as OpenChamberCommentThread;
        thread.commentOrigin = pending.origin;
        thread.label = this.options.strings.threadLabel(selectionLineRange(pending.range));
        thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
        // The snapshot that carried the text already confirmed the delivery.
        thread.confirmed = true;
        thread.composedInChat = true;
        this.markAttached(thread, pending.surfaceId, draftId, text);
    }

    /**
     * Takes a composed thread off screen without dropping the comment.
     *
     * Emptying the field leaves the draft in place, so its anchor goes back to
     * waiting for text instead of being disposed with it: retyping re-creates
     * the thread on the same lines, and only a draft that is actually gone ends
     * the comment.
     */
    private parkComposition(thread: OpenChamberCommentThread, surfaceId: string): void {
        const draftId = thread.draftId;
        const range = thread.range;
        if (!draftId || !range) return;
        this.compositionsByDraftId.set(draftId, {
            uri: thread.uri,
            range,
            origin: thread.commentOrigin ?? { source: 'file' },
            surfaceId,
            // The composer already reported holding this draft.
            confirmed: true,
        });
        this.ensurePendingAnchorListener();
    }

    /** Turns an editor thread into the read-only view of an attached draft. */
    private markAttached(thread: OpenChamberCommentThread, surfaceId: string, draftId: string, text: string): void {
        thread.surfaceId = surfaceId;
        thread.draftId = draftId;
        thread.commentBody = text;
        thread.canReply = false;
        thread.contextValue = 'openchamberAttached';
        thread.commentPending = !thread.confirmed;
        thread.comments = [this.buildComment(text, thread.commentPending)];
        this.threadsByDraftId.set(draftId, thread);
        this.startConfirmationTimer(thread);
    }

    /**
     * The draft a comment becomes, wherever its text is written.
     *
     * The origin is passed in rather than resolved here: a caller that already
     * captured the diff identity must not have it replaced by whatever tab is
     * active after an await.
     */
    private async buildPayload(
        uri: vscode.Uri,
        range: vscode.Range,
        text: string,
        origin: CommentOrigin,
    ): Promise<{ payload: InlineCommentDraftPayload; lines: LineRange }> {
        const document = await vscode.workspace.openTextDocument(uri);
        const lines = selectionLineRange(range);

        // Quote the pane the user commented on, but name the real file: a diff's
        // original side is a `git:` document, and its raw path is not something
        // the composer can match against the workspace.
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

    /**
     * Gives up on a thread whose draft the composer never confirmed.
     *
     * Accepting the draft is not the same as it landing. A panel whose webview
     * never boots leaves the thread showing "Not sent yet" for a comment that
     * will never be sent and cannot be rewritten, so it is given up on rather
     * than left as a standing promise.
     */
    private startConfirmationTimer(thread: OpenChamberCommentThread): void {
        const draftId = thread.draftId;
        if (thread.confirmed || !draftId) return;
        thread.confirmationTimer = setTimeout(() => {
            thread.confirmationTimer = undefined;
            if (!shouldAbandonUnconfirmed(thread.confirmed)) return;
            // Retract it everywhere before saying it was discarded. Dropping only
            // the thread leaves the payload in a panel's hold, so a webview that
            // boots after the deadline would still file the draft and send a
            // comment the user was just told had been thrown away.
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
     *
     * A snapshot speaks only for the surface that sent it. Every webview keeps
     * its own draft store, so a second session tab reporting an empty list says
     * nothing about a comment attached to the first one.
     */
    public reconcile(surfaceId: string, drafts: ReadonlyArray<{ id: string; text: string }>): void {
        const byId = new Map(drafts.map((draft) => [draft.id, draft.text]));

        this.reconcileCompositions(surfaceId, byId);

        for (const [draftId, thread] of [...this.threadsByDraftId]) {
            if (!snapshotOwnsThread(thread.surfaceId, surfaceId)) continue;
            const text = byId.get(draftId);

            // A comment written in the composer is only on screen while it has
            // text. Emptying the field takes the thread away, not the comment:
            // the anchor waits for text, so retyping brings the thread back and
            // only a gone draft ends it.
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
            if (text !== undefined && (thread.commentBody !== text || thread.commentPending)) {
                thread.commentBody = text;
                thread.commentPending = false;
                thread.comments = [this.buildComment(text, false)];
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
        this.controller.dispose();
    }

    private buildComment(body: string, pending = false): vscode.Comment {
        // The body is the user's own prose, not a document: rendering it as
        // Markdown would eat underscores and asterisks they meant literally,
        // and a comment on code is full of both.
        const rendered = new vscode.MarkdownString();
        rendered.appendText(body);

        return {
            body: rendered,
            mode: vscode.CommentMode.Preview,
            author: { name: this.options.strings.author, iconPath: this.options.avatar },
            // Only while the composer has not confirmed it holds the draft:
            // the label belongs to that delivery deadline, not to the message.
            label: pending ? this.options.strings.notSent : undefined,
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
