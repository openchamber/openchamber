/**
 * Per-chat-column owner of the mobile comment-mode controller.
 *
 * The controller is intentionally not a global: multiple embedded chat columns
 * can be mounted at once, and each column's selection menu must hand its quote
 * to its own composer. `ChatContainer` creates one controller per column (same
 * pattern as `chatColumnSession.ts`) and provides it here; the selection menu
 * opens through it and `ChatInput` renders from it.
 */

import React from 'react';

import {
    CLOSED_MOBILE_COMMENT_DRAFT,
    createMobileCommentDraftController,
    type MobileCommentDraft,
    type MobileCommentDraftController,
} from './mobileCommentDraft';

export const MobileCommentComposerContext = React.createContext<MobileCommentDraftController | null>(null);

/**
 * Create (once per column) the comment controller this column provides.
 * The column going away ends its comment; nothing outlives the owner.
 */
export function useMobileCommentComposerOwner(): MobileCommentDraftController {
    const controllerRef = React.useRef<MobileCommentDraftController | null>(null);
    if (controllerRef.current === null) {
        controllerRef.current = createMobileCommentDraftController();
    }
    React.useEffect(() => {
        const controller = controllerRef.current;
        if (!controller) return;
        return () => {
            controller.cancel();
        };
    }, []);
    return controllerRef.current;
}

/** The column's controller, or null outside a chat column. */
export const useMobileCommentComposerController = (): MobileCommentDraftController | null =>
    React.useContext(MobileCommentComposerContext);

const noopSubscribe = () => () => {};

/** Live comment draft state; always closed when there is no controller. */
export const useMobileCommentDraft = (controller: MobileCommentDraftController | null): MobileCommentDraft =>
    React.useSyncExternalStore(
        controller?.subscribe ?? noopSubscribe,
        controller?.getState ?? (() => CLOSED_MOBILE_COMMENT_DRAFT),
        () => CLOSED_MOBILE_COMMENT_DRAFT,
    );
