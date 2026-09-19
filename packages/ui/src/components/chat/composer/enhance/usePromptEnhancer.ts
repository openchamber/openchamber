/**
 * The composer's Enhance Prompt state machine: one authoritative operation,
 * one AbortController, and the protected-token gate between the Small Model's
 * rewrite and the draft it would replace.
 *
 * The operation is scoped. It runs for the exact draft it was started from
 * and for the current draft scope (`scopeKey` — the runtime/directory/session
 * identity ChatInput derives), and it always settles promptly into one of the
 * terminal outcomes idle → running → applied | failed | cancelled |
 * timed-out | obsolete:
 *
 * - `applied` / `failed` — the rewrite landed (protected-token violations
 *   fail loudly) or a request failure surfaced; ChatInput maps the reasons
 *   that need their own copy to toasts.
 * - `cancelled` — the user tapped cancel; silent.
 * - `timed-out` — the client deadline fired before any usable response;
 *   surfaced as a toast.
 * - `obsolete` — the operation's premise disappeared before it settled: a
 *   newer enhance started, the draft was edited (`noteDraftChanged`), the
 *   scope moved (session/directory/runtime switch), or the composer
 *   unmounted. Late/obsolete outcomes are swallowed silently and their
 *   cleanup is forbidden from touching the busy state, so the spinner always
 *   settles promptly and the new scope/draft can enhance again immediately.
 *
 * Busy-ness is derived, not stored: the active operation carries its scope,
 * and `isEnhancing` is computed during render as "an operation is active and
 * belongs to the current scope". A scope switch therefore paints the new
 * scope non-busy in the very render that saw the switch — before any effect,
 * before paint. The scope `useEffect` only does transport-side cleanup: it
 * aborts and formally invalidates an operation that still belongs to the
 * previous scope.
 *
 * The hook owns everything ChatInput should not: request generations, stale
 * responses, cancellation, and validation. ChatInput only decides whether an
 * enhance may run, applies the returned text to the exact draft the request
 * was started from, and maps failure reasons to toasts. Live-draft reads are
 * ChatInput's own concern at both ends: its change handler passes the live
 * editor value into `noteDraftChanged`, and its apply-side backstop compares
 * the result's source snapshot against that same live value, so a keystroke
 * that has not reached the effect-synced ref yet still counts as the
 * composer's content.
 *
 * "Materially changed" means the registry behind the language context changed
 * — compared by value via `sameLanguageContext`, not by object identity. The
 * composer rebuilds its context object on ordinary re-renders even when every
 * field is unchanged, so identity would wrongly discard every successful
 * response whenever React re-rendered between the click and the reply.
 */

import * as React from 'react';

import type { I18nKey } from '@/lib/i18n';

import {
    enhancePrompt,
    PromptEnhanceError,
    type PromptEnhanceContext,
    type PromptEnhanceFailure,
} from './promptEnhancer';
import { validateProtectedTokensPreserved } from './protectedTokens';
import type { ComposerLanguageContext } from '../language/tokenize';

export type PromptEnhanceResult =
    | { outcome: 'applied'; text: string; sourceSnapshot: string }
    | { outcome: 'stale' }
    | { outcome: 'failed'; reason: PromptEnhanceFailure };

/**
 * Failure reasons ChatInput maps to Enhance-specific toast copy. Reasons left
 * out already surface exactly one toast elsewhere: `provider-failed` is covered
 * by the request layer's generic Small Model notification, while `aborted` and
 * stale responses are silent by convention.
 */
export const ENHANCE_FAILURE_TOAST_KEYS = {
    unavailable: 'chat.chatInput.toast.enhanceUnavailable',
    'context-too-small': 'chat.chatInput.toast.enhanceContextTooSmall',
    'empty-result': 'chat.chatInput.toast.enhanceEmptyResult',
    'invalid-result': 'chat.chatInput.toast.enhanceInvalidResult',
    'timed-out': 'chat.chatInput.toast.enhanceTimedOut',
    // The reasons below surface exactly one toast elsewhere, or stay silent:
    // `provider-failed` is covered by the request layer's generic Small Model
    // notification; `aborted` and stale responses are silent by convention.
    'provider-failed': null,
    'aborted': null,
} as const satisfies Record<PromptEnhanceFailure, I18nKey | null>;

/**
 * Whether two language contexts carry the same workspace knowledge — the
 * registries the protected-token gate resolves against. Compared by value:
 * the composer rebuilds its context object on ordinary re-renders even when
 * nothing changed, so object identity cannot distinguish "the registry
 * changed" from "React re-rendered". Set members are already-normalized
 * (lowercased) strings, so plain equality is enough.
 */
function sameLanguageContext(
    a: ComposerLanguageContext,
    b: ComposerLanguageContext,
): boolean {
    if (a === b) return true;
    if (a.inputMode !== b.inputMode) return false;
    const setFields = [
        'knownAgentNames',
        'confirmedMentions',
        'knownSlashNames',
        'knownSnippetTriggers',
    ] as const;
    return setFields.every((field) => {
        const aSet = a[field];
        const bSet = b[field];
        if (aSet.size !== bSet.size) return false;
        for (const member of aSet) {
            if (!bSet.has(member)) return false;
        }
        return true;
    })
        && a.attachmentFilenames.length === b.attachmentFilenames.length
        && a.attachmentFilenames.every((name, index) => name === b.attachmentFilenames[index]);
}

export interface PromptEnhancerInput {
    /**
     * The composer's language context. Read through a ref so a registry
     * change does not re-create the callbacks, and a response is validated
     * against the values the request was started with (a materially changed
     * context marks the response stale).
     */
    languageContext: ComposerLanguageContext;
    /**
     * Identity of the draft scope the enhance runs in — the runtime,
     * directory, and session ChatInput derives from the chat draft identity.
     * A change invalidates the active operation: its outcome becomes
     * obsolete and the new scope can enhance immediately.
     */
    scopeKey: string | null;
}

export function usePromptEnhancer(input: PromptEnhancerInput) {
    // The authoritative operation, if any. State is the reactive truth; the
    // ref mirror gives callbacks/effect synchronous reads.
    const [activeOp, setActiveOp] = React.useState<{ scopeKey: string | null; source: string } | null>(null);
    const activeOpRef = React.useRef(activeOp);
    activeOpRef.current = activeOp;
    // Monotonically increasing id of the latest authoritative operation; any
    // response from an older generation is stale and must not touch anything.
    // This ref is the single authority for "which enhance is current" — no
    // pending-count bookkeeping exists because exactly one operation is
    // authoritative at a time, and an older operation's cleanup observes a
    // generation mismatch and becomes a no-op.
    const generationRef = React.useRef(0);
    const abortRef = React.useRef<AbortController | null>(null);
    // Read through a ref so a registry change does not re-create the callback,
    // and a response is validated against the values the request was started
    // with (a materially changed context marks the response stale).
    const languageContextRef = React.useRef(input.languageContext);
    languageContextRef.current = input.languageContext;
    const scopeKeyRef = React.useRef(input.scopeKey);
    scopeKeyRef.current = input.scopeKey;

    // Derived, synchronous: a scope switch makes the previous scope's
    // operation non-busy for the new scope in the very render that saw the
    // switch — before any effect, before paint.
    const isEnhancing = activeOp !== null && activeOp.scopeKey === input.scopeKey;

    const cancel = React.useCallback(() => {
        abortRef.current?.abort();
    }, []);

    // Ends the active operation without waiting for its transport: the
    // generation bump makes its outcome obsolete, the abort stops the network
    // work, and the spinner is released at once. A no-op when nothing is
    // active — callers may notify unconditionally.
    const invalidateActive = React.useCallback(() => {
        if (activeOpRef.current === null) return;
        activeOpRef.current = null;
        generationRef.current += 1;
        abortRef.current?.abort();
        setActiveOp(null);
    }, []);

    // Draft-change notification from the composer's change handler: cheap by
    // design — a no-op while no operation is active or the draft still matches
    // the one the operation was started from. Once the draft moved, the
    // rewrite would answer for a draft that no longer exists, so the operation
    // is invalidated here instead of being raced against the response path.
    const noteDraftChanged = React.useCallback((liveDraft: string) => {
        const op = activeOpRef.current;
        if (!op || liveDraft === op.source) return;
        invalidateActive();
    }, [invalidateActive]);

    const enhance = React.useCallback(async (
        draft: string,
        context: PromptEnhanceContext,
    ): Promise<PromptEnhanceResult> => {
        const requestId = ++generationRef.current;
        // A newer request is the only authoritative one: abort whatever is
        // still in flight so it cannot land after this call.
        abortRef.current?.abort();
        const controller = new AbortController();
        abortRef.current = controller;
        const requestLanguageContext = languageContextRef.current;
        // Overwrite — a newer op always wins, even if it belongs to a
        // different scope (the scope effect's guard keeps that op alive).
        // The ref mirrors the new op synchronously so a passive effect that
        // runs before the next render (the scope effect) already sees it.
        const nextOp = { scopeKey: scopeKeyRef.current, source: draft };
        activeOpRef.current = nextOp;
        setActiveOp(nextOp);
        try {
            const cleaned = await enhancePrompt(draft, context, controller.signal);
            if (
                requestId !== generationRef.current
                || !sameLanguageContext(languageContextRef.current, requestLanguageContext)
            ) {
                return { outcome: 'stale' };
            }
            if (!validateProtectedTokensPreserved(draft, cleaned, requestLanguageContext)) {
                // Protected composer tokens were lost or invented: the draft
                // stays untouched and the failure is surfaced, not swallowed.
                return { outcome: 'failed', reason: 'invalid-result' };
            }
            return { outcome: 'applied', text: cleaned, sourceSnapshot: draft };
        } catch (error) {
            if (requestId !== generationRef.current) {
                return { outcome: 'stale' };
            }
            // Cancellation is the caller's decision, never an error to surface.
            // The abort may surface as a typed PromptEnhanceError('aborted')
            // (service layer) or as a raw DOMException AbortError (transport);
            // both names mean the same thing here.
            if (error instanceof PromptEnhanceError && error.reason === 'aborted') {
                return { outcome: 'stale' };
            }
            if (error instanceof Error && error.name === 'AbortError') {
                return { outcome: 'stale' };
            }
            const reason = error instanceof PromptEnhanceError ? error.reason : 'provider-failed';
            return { outcome: 'failed', reason };
        } finally {
            // Only the authoritative operation releases the busy state: an
            // older operation's cleanup observes a generation mismatch and
            // becomes a no-op, so it can never clear a newer operation's
            // spinner. With derivation, it also cannot make a newer-scope
            // operation look busy: busy-ness is re-evaluated against the
            // current scope on every render. With a single authoritative
            // operation there is no concurrency to count — no pending-request
            // bookkeeping needed.
            if (generationRef.current === requestId) {
                setActiveOp(null);
            }
        }
    }, []);

    // Transport-side scope cleanup: a session/directory/runtime switch moves
    // the draft scope, so an operation started for the previous scope can no
    // longer land anywhere meaningful — abort and invalidate it. The spinner
    // itself needs no work: busy-ness was already derived false for the new
    // scope in the render that saw the switch. Skipped on first mount
    // (nothing can be active yet, tracked via an undefined sentinel) and when
    // the key is unchanged (ordinary re-renders pass an equal key).
    const prevScopeKeyRef = React.useRef<string | null | undefined>(undefined);
    React.useEffect(() => {
        const previous = prevScopeKeyRef.current;
        prevScopeKeyRef.current = input.scopeKey;
        if (previous === undefined || previous === input.scopeKey) return;
        // A newer operation may already have started for the new scope (its
        // enhance overwrote activeOp before this effect ran); only invalidate
        // an operation that actually belongs to the previous scope.
        if (activeOpRef.current?.scopeKey !== previous) return;
        invalidateActive();
    }, [input.scopeKey, invalidateActive]);

    React.useEffect(() => () => {
        // Unmount invalidates every in-flight request and stops its network work.
        generationRef.current += 1;
        abortRef.current?.abort();
    }, []);

    return { isEnhancing, enhance, cancel, noteDraftChanged };
}
