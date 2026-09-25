/**
 * State machine for the mobile composer's comment mode. On mobile a text
 * selection's "Comment" hands its quote to this controller and the chat
 * column's composer swaps its input for a comment shell
 * (`MobileCommentComposer.tsx`); attaching writes a `chat-quote` draft into
 * the inline comment draft store, joining the next message as context.
 *
 * Invariants (the risky part; unit-tested here):
 * - The (runtime, directory, session) scope captured at `open` is the only
 *   scope the quote may land in. Attach never re-resolves the current
 *   session, and a scope change closes the comment instead of re-targeting.
 * - Every mutation carries the generation of its open it belongs to, so a
 *   stale dictation transcript, a second attach, or a cancel arriving after a
 *   newer comment opened is rejected — `insertAndAttach` is atomic for the
 *   same reason: a stale insert-and-attach neither writes text nor attaches.
 */

import { getRuntimeKey } from '@/lib/runtime-switch';
import { useInlineCommentDraftStore, type InlineCommentDraftTarget } from '@/stores/useInlineCommentDraftStore';
import type { ChatQuoteAnchor } from '@/lib/chatQuoteAnchor';
import { appendInlineText } from '../text';

export interface MobileCommentScope {
    runtimeKey: string;
    directory: string;
    sessionKey: string;
}

export interface MobileCommentQuote {
    /** Plain text, used only for the single-line preview row. */
    plainText: string;
    /** Full markdown of the selection; attached verbatim as quote context. */
    markdownText: string;
    /** `data-message-id` the selection came from, when known. */
    messageId: string | null;
    /** Where the quote sits in that message, when it could be captured. */
    anchor?: ChatQuoteAnchor | null;
}

export type MobileCommentDraft =
    | { status: 'closed' }
    | {
        status: 'open';
        scope: MobileCommentScope;
        quote: MobileCommentQuote;
        text: string;
        generation: number;
    };

/** What attach produced: everything needed to write one chat-quote draft. */
export interface MobileCommentAttachPlan {
    scope: MobileCommentScope;
    target: InlineCommentDraftTarget;
    draft: {
        source: 'chat-quote';
        fileLabel: string;
        startLine: number;
        endLine: number;
        code: string;
        language: string;
        text: string;
        anchor?: ChatQuoteAnchor;
    };
}

export const CLOSED_MOBILE_COMMENT_DRAFT: MobileCommentDraft = { status: 'closed' };

/** Keep the full quote text; the shell clips and fades it at the row's edge. */
export const mobileCommentQuotePreview = (plainText: string): string =>
    plainText.trim();

export const isSameMobileCommentScope = (a: MobileCommentScope, b: MobileCommentScope): boolean =>
    a.runtimeKey === b.runtimeKey && a.directory === b.directory && a.sessionKey === b.sessionKey;

export interface MobileCommentDraftController {
    getState(): MobileCommentDraft;
    subscribe(listener: () => void): () => void;
    /** The mounted composer publishes its target, including pending BTW drafts. */
    setScope(scope: MobileCommentScope | null): void;
    /** Capture the composer's target and open a comment for the selection. */
    open(quote: MobileCommentQuote): boolean;
    /**
     * Discard the comment. The only exit that writes nothing. With a
     * generation, only that open is cancelled; returns whether a comment
     * closed, so a stale caller can skip its follow-up (focus restore etc.).
     */
    cancel(generation?: number): boolean;
    /** Comment text typed in the comment editor. */
    setText(text: string, generation: number): void;
    /** Append a dictation transcript to the comment text. */
    insertText(text: string, generation: number): void;
    /**
     * Store the open comment exactly once and close only after acceptance.
     * Rejection returns null and preserves the comment for editing or retry.
     */
    attach(generation: number): MobileCommentAttachPlan | null;
    /**
     * Dictation's insert-and-attach, atomic under one generation check: a
     * stale completion neither appends its text nor attaches the newer
     * comment that replaced the caller's.
     */
    insertAndAttach(text: string, generation: number): MobileCommentAttachPlan | null;
}

export function createMobileCommentDraftController(): MobileCommentDraftController {
    let state: MobileCommentDraft = CLOSED_MOBILE_COMMENT_DRAFT;
    let scope: MobileCommentScope | null = null;
    let generation = 0;
    const listeners = new Set<() => void>();

    const update = (next: MobileCommentDraft) => {
        if (next === state) return;
        state = next;
        for (const listener of listeners) listener();
    };

    const planOf = (open: Extract<MobileCommentDraft, { status: 'open' }>): MobileCommentAttachPlan => ({
        scope: open.scope,
        target: { directory: open.scope.directory, sessionKey: open.scope.sessionKey },
        draft: {
            source: 'chat-quote',
            fileLabel: open.quote.messageId ?? '',
            startLine: 1,
            endLine: 1,
            code: open.quote.markdownText,
            language: '',
            // The comment itself is optional; whitespace-only means none.
            text: open.text.trim(),
            anchor: open.quote.anchor ?? undefined,
        },
    });

    const attach = (atGeneration: number, text?: string): MobileCommentAttachPlan | null => {
        if (state.status !== 'open' || state.generation !== atGeneration) return null;
        if (!scope || scope.runtimeKey !== getRuntimeKey() || !isSameMobileCommentScope(scope, state.scope)) {
            update(CLOSED_MOBILE_COMMENT_DRAFT);
            return null;
        }
        const pending = text === undefined ? state : { ...state, text: appendInlineText(state.text, text) };
        const plan = planOf(pending);
        if (!applyMobileCommentAttach(plan)) {
            update(pending);
            return null;
        }
        update(CLOSED_MOBILE_COMMENT_DRAFT);
        return plan;
    };

    return {
        getState: () => state,
        subscribe(listener) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        setScope(nextScope) {
            scope = nextScope;
            if (state.status === 'open' && (!scope || !isSameMobileCommentScope(state.scope, scope))) {
                update(CLOSED_MOBILE_COMMENT_DRAFT);
            }
        },
        open(quote) {
            if (!scope || scope.runtimeKey !== getRuntimeKey() || !scope.directory || !scope.sessionKey) return false;
            if (!quote.markdownText.trim()) return false;
            generation += 1;
            update({ status: 'open', scope, quote, text: '', generation });
            return true;
        },
        cancel(atGeneration) {
            if (state.status !== 'open') return false;
            if (atGeneration !== undefined && state.generation !== atGeneration) return false;
            update(CLOSED_MOBILE_COMMENT_DRAFT);
            return true;
        },
        setText(text, atGeneration) {
            if (state.status !== 'open' || state.generation !== atGeneration) return;
            if (state.text === text) return;
            update({ ...state, text });
        },
        insertText(text, atGeneration) {
            if (state.status !== 'open' || state.generation !== atGeneration) return;
            const next = appendInlineText(state.text, text);
            if (next === state.text) return;
            update({ ...state, text: next });
        },
        attach,
        insertAndAttach(text, atGeneration) {
            return attach(atGeneration, text);
        },
    };
}

/**
 * Write an attach plan into the inline comment draft store. The runtime is
 * verified against the scope captured at open: `addDraft` keys by the CURRENT
 * runtime, so a plan from before a runtime switch must be dropped, not filed
 * under the new runtime's namespace. Directory and session are written exactly
 * as captured from the visible composer.
 */
export function applyMobileCommentAttach(plan: MobileCommentAttachPlan): boolean {
    if (plan.scope.runtimeKey !== getRuntimeKey()) return false;
    return useInlineCommentDraftStore.getState().addDraft(plan.target, plan.draft) !== null;
}
