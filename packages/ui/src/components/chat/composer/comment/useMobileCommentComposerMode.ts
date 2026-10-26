/**
 * Owns ChatInput's comment subscription, scope checks, and attach/cancel focus
 * handoff. Callbacks capture the rendered generation; ChatInput keys the shell
 * by it. A quote stays in its captured scope or is dropped, never re-targeted.
 */

import React from 'react';
import { flushSync } from 'react-dom';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';

import type { MobileComposerShell } from '../state/useMobileComposerShell';
import { useMobileCommentComposerController, useMobileCommentDraft } from './MobileCommentComposerContext';
import type { MobileCommentComposerHandlers } from './MobileCommentComposer';
import type { MobileCommentScope } from './mobileCommentDraft';

export interface MobileCommentModeOptions {
    isMobile: boolean;
    runtimeKey: string;
    /** Session the composer's inline drafts target ('' when there is none). */
    directory: string | null;
    sessionKey: string | null;
    mobileShell: MobileComposerShell;
}

export interface MobileCommentMode {
    active: boolean;
    draft: ReturnType<typeof useMobileCommentDraft>;
    /** Wiring for the comment shell; callbacks are bound to the rendered open. */
    handlers: MobileCommentComposerHandlers;
    /** Attach whatever comment is open right now (form submit path). */
    submit(): void;
}

export function useMobileCommentComposerMode(options: MobileCommentModeOptions): MobileCommentMode {
    const { isMobile, runtimeKey, directory, sessionKey, mobileShell } = options;
    const { t } = useI18n();
    const controller = useMobileCommentComposerController();
    const draft = useMobileCommentDraft(controller);
    const active = isMobile && draft.status === 'open';

    const scope = React.useMemo<MobileCommentScope | null>(
        () => (!isMobile || !runtimeKey || !directory || !sessionKey
            ? null
            : { runtimeKey, directory, sessionKey }),
        [isMobile, directory, runtimeKey, sessionKey],
    );
    // Publish the committed composer's target before a selection-menu tap can
    // open a comment. The menu must not derive a second target from the parent.
    React.useLayoutEffect(() => {
        controller?.setScope(scope);
        return () => controller?.setScope(null);
    }, [controller, scope]);

    // Entering comment mode unmounts the wrapper-level dictation engine (the
    // shell mounts its own, comment-scoped one); a stale active flag from it
    // must not hold the shell expanded for the comment's lifetime.
    const prevActiveRef = React.useRef(false);
    React.useEffect(() => {
        if (active && !prevActiveRef.current && mobileShell.dictationActive) {
            mobileShell.onDictationActiveChange(false);
        }
        prevActiveRef.current = active;
    }, [active, mobileShell]);

    // Attach inside the tap: expand() flushes the shell swap and focuses the
    // restored composer in the same call stack, as iOS requires for the soft
    // keyboard. A stale or scope-mismatched open restores nothing.
    const attach = React.useCallback((generation: number, text?: string) => {
        if (!controller) return;
        let attached = false;
        flushSync(() => {
            attached = (text === undefined
                ? controller.attach(generation)
                : controller.insertAndAttach(text, generation)) !== null;
        });
        if (attached) {
            mobileShell.expand();
        } else {
            const open = controller.getState();
            if (open.status === 'open' && open.generation === generation) {
                toast.error(t('chat.textSelection.comment.attachFailed'));
            }
        }
    }, [controller, mobileShell, t]);

    const cancel = React.useCallback((generation: number) => {
        if (!controller) return;
        let closed = false;
        flushSync(() => {
            closed = controller.cancel(generation);
        });
        if (closed) mobileShell.expand();
    }, [controller, mobileShell]);

    const submit = React.useCallback(() => {
        if (!controller) return;
        const open = controller.getState();
        if (open.status === 'open') attach(open.generation);
    }, [attach, controller]);

    const handlers = React.useMemo<MobileCommentComposerHandlers>(() => {
        if (draft.status !== 'open') {
            const noop = () => undefined;
            return {
                onTextChange: noop,
                onCancel: noop,
                onAttach: noop,
                onDictationInsert: noop,
                onDictationInsertAndSend: noop,
                onEditorFocus: noop,
                onEditorBlur: noop,
                onDictationActiveChange: noop,
            };
        }
        const generation = draft.generation;
        return {
            onTextChange: (text) => controller?.setText(text, generation),
            onCancel: () => cancel(generation),
            onAttach: () => attach(generation),
            onDictationInsert: (text) => controller?.insertText(text, generation),
            onDictationInsertAndSend: (text) => attach(generation, text),
            onEditorFocus: mobileShell.onEditorFocus,
            onEditorBlur: mobileShell.onEditorBlur,
            onDictationActiveChange: mobileShell.onDictationActiveChange,
        };
    }, [attach, cancel, controller, draft, mobileShell]);

    return { active, draft, handlers, submit };
}
