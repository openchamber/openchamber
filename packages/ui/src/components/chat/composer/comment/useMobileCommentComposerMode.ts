
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
    directory: string | null;
    sessionKey: string | null;
    mobileShell: MobileComposerShell;
}

export interface MobileCommentMode {
    active: boolean;
    draft: ReturnType<typeof useMobileCommentDraft>;
    handlers: MobileCommentComposerHandlers;
    submit(): void;
}

export function useMobileCommentComposerMode(options: MobileCommentModeOptions): MobileCommentMode {
    const { isMobile, runtimeKey, directory, sessionKey, mobileShell } = options;
    const { t } = useI18n();
    const controller = useMobileCommentComposerController();
    const draft = useMobileCommentDraft(controller);
    const active = isMobile && draft.status === 'open';

    const scope = React.useMemo<MobileCommentScope | null>(
        () => (!runtimeKey || !directory || !sessionKey
            ? null
            : { runtimeKey, directory, sessionKey }),
        [directory, runtimeKey, sessionKey],
    );
    React.useLayoutEffect(() => {
        controller?.setScope(scope);
        return () => controller?.setScope(null);
    }, [controller, scope]);

    const prevActiveRef = React.useRef(false);
    React.useEffect(() => {
        if (active && !prevActiveRef.current && mobileShell.dictationActive) {
            mobileShell.onDictationActiveChange(false);
        }
        prevActiveRef.current = active;
    }, [active, mobileShell]);

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
                toast.error(t('inlineComment.toast.noRoom'));
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
