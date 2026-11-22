
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
    plainText: string;
    markdownText: string;
    messageId: string | null;
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
        draftId?: string;
    };

export interface MobileCommentAttachPlan {
    scope: MobileCommentScope;
    target: InlineCommentDraftTarget;
    draftId?: string;
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

export const mobileCommentQuotePreview = (plainText: string): string =>
    plainText.trim();

export const isSameMobileCommentScope = (a: MobileCommentScope, b: MobileCommentScope): boolean =>
    a.runtimeKey === b.runtimeKey && a.directory === b.directory && a.sessionKey === b.sessionKey;

export interface MobileCommentDraftController {
    getState(): MobileCommentDraft;
    subscribe(listener: () => void): () => void;
    setScope(scope: MobileCommentScope | null): void;
    getScope(): MobileCommentScope | null;
    open(quote: MobileCommentQuote): boolean;
    openEdit(edit: { target: InlineCommentDraftTarget; draftId: string; quote: MobileCommentQuote; text: string }): boolean;
    cancel(generation?: number): boolean;
    setText(text: string, generation: number): void;
    insertText(text: string, generation: number): void;
    attach(generation: number): MobileCommentAttachPlan | null;
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
        draftId: open.draftId,
        draft: {
            source: 'chat-quote',
            fileLabel: open.quote.messageId ?? '',
            startLine: 1,
            endLine: 1,
            code: open.quote.markdownText,
            language: '',
            text: open.text.trim(),
            anchor: open.quote.anchor ?? undefined,
        },
    });

    const canOpen = (current: MobileCommentScope | null): current is MobileCommentScope =>
        Boolean(current && current.runtimeKey === getRuntimeKey() && current.directory && current.sessionKey);

    const attach = (atGeneration: number, text?: string): MobileCommentAttachPlan | null => {
        if (state.status !== 'open' || state.generation !== atGeneration) return null;
        if (!scope || scope.runtimeKey !== getRuntimeKey() || !isSameMobileCommentScope(scope, state.scope)) {
            update(CLOSED_MOBILE_COMMENT_DRAFT);
            return null;
        }
        const pending = text === undefined ? state : { ...state, text: appendInlineText(state.text, text) };
        const plan = planOf(pending);
        if (plan.draftId && !useInlineCommentDraftStore.getState().getDrafts(plan.target).some((draft) => draft.id === plan.draftId)) {
            update(CLOSED_MOBILE_COMMENT_DRAFT);
            return null;
        }
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
        getScope: () => scope,
        open(quote) {
            if (!canOpen(scope)) return false;
            if (!quote.markdownText.trim()) return false;
            generation += 1;
            update({ status: 'open', scope, quote, text: '', generation });
            return true;
        },
        openEdit({ target, draftId, quote, text }) {
            if (!canOpen(scope)) return false;
            if (target.directory !== scope.directory || target.sessionKey !== scope.sessionKey) return false;
            generation += 1;
            update({ status: 'open', scope, quote, text, generation, draftId });
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

export function applyMobileCommentAttach(plan: MobileCommentAttachPlan): boolean {
    if (plan.scope.runtimeKey !== getRuntimeKey()) return false;
    const store = useInlineCommentDraftStore.getState();
    if (plan.draftId) return store.updateDraft(plan.target, plan.draftId, { text: plan.draft.text });
    return store.addDraft(plan.target, plan.draft) !== null;
}
