
import React from 'react';

import {
    CLOSED_MOBILE_COMMENT_DRAFT,
    createMobileCommentDraftController,
    type MobileCommentDraft,
    type MobileCommentDraftController,
} from './mobileCommentDraft';

export const MobileCommentComposerContext = React.createContext<MobileCommentDraftController | null>(null);

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

export const useMobileCommentComposerController = (): MobileCommentDraftController | null =>
    React.useContext(MobileCommentComposerContext);

const noopSubscribe = () => () => {};

export const useMobileCommentDraft = (controller: MobileCommentDraftController | null): MobileCommentDraft =>
    React.useSyncExternalStore(
        controller?.subscribe ?? noopSubscribe,
        controller?.getState ?? (() => CLOSED_MOBILE_COMMENT_DRAFT),
        () => CLOSED_MOBILE_COMMENT_DRAFT,
    );
