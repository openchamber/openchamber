import React from 'react';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionGoalArmStore } from '@/stores/useSessionGoalArmStore';
import { useBtwStore } from '@/stores/useBtwStore';
import { cn } from '@/lib/utils';
import { toast } from '@/components/ui';
import { usePermissionStore } from '@/stores/permissionStore';
import { cyclePermissionMode } from '../../permissionAutoAccept';
import { displayedPermissionMode, nextPermissionMode } from '@/stores/utils/permissionAutoAccept';
import { selectSafetyNetAvailable, useRoutingStore } from '@/stores/useRoutingStore';
import { useKeybind } from '@/hooks/useKeybind';
import { useOpenCodeStartupStore } from '@/sync/opencode-startup-gate';
import { useComposerTextValue } from '../../composer/state/composerText';
import { useMobileViewportPin } from '../../composer/state/useMobileViewportPin';
import type { useComposerInputState } from './useComposerInputState';
import type { useComposerEnvironment } from './useComposerEnvironment';
import type { useComposerSessionScope } from './useComposerSessionScope';
import type { useComposerMobileShell } from './useComposerMobileShell';
import type { useComposerReferenceActions } from './useComposerReferenceActions';
import type { useComposerDraftHistory } from './useComposerDraftHistory';
import type { useComposerMentionAttachments } from './useComposerMentionAttachments';

type Dependencies = Pick<ReturnType<typeof useComposerInputState>, 'composerFormRef' | 'setMobileAttachMenuOpen' | 'composerRef' | 'composerText' | 't'>
    & Pick<ReturnType<typeof useComposerEnvironment>, 'isMobile' | 'isMobileExpanded' | 'pendingBtwPermissionMode' | 'setSessionMode'>
    & Pick<ReturnType<typeof useComposerSessionScope>, 'newSessionDraftOpen' | 'isBtwActive' | 'btwSessionId' | 'currentSessionId' | 'currentManagementSessionId' | 'draftPermissionMode' | 'setDraftPermissionMode' | 'abortPromptSessionId' | 'acknowledgeSessionAbort'>
    & Pick<ReturnType<typeof useComposerMobileShell>, 'mobileTextareaFocused' | 'mobileComposerExpanded'>
    & Pick<ReturnType<typeof useComposerReferenceActions>, 'isVSCode'>
    & Pick<ReturnType<typeof useComposerDraftHistory>, 'isPromptHistorySearchOpen'>
    & Pick<ReturnType<typeof useComposerMentionAttachments>, 'prevWasAbortedRef'>;

export function useComposerControls({
    composerFormRef, setMobileAttachMenuOpen, composerRef, isMobile, isMobileExpanded, newSessionDraftOpen,
    mobileTextareaFocused, composerText, mobileComposerExpanded, isVSCode, isBtwActive, btwSessionId,
    currentSessionId, currentManagementSessionId, pendingBtwPermissionMode, draftPermissionMode,
    setDraftPermissionMode, setSessionMode, t, isPromptHistorySearchOpen, abortPromptSessionId,
    prevWasAbortedRef, acknowledgeSessionAbort,
}: Dependencies) {
    /** Address the mobile mic action to this form even if another editor has focus. */
    const toggleDictation = React.useCallback(() => {
        window.dispatchEvent(new CustomEvent('openchamber:dictation-toggle', {
            detail: { composer: composerFormRef.current },
        }));
    }, [composerFormRef]);

    const openMobileAttachSheet = React.useCallback(() => {
        // Same order as handleOpenMobilePanel: mark the sheet open BEFORE the
        // blur so the collapse watcher sees an overlay when the keyboard-close
        // lands. The trigger button blocks the tap's own focus transfer, so
        // the keyboard must be dismissed explicitly here.
        setMobileAttachMenuOpen(true);
        composerRef.current?.blur();
    }, [composerRef, setMobileAttachMenuOpen]);

    // Mobile browsers pan the visual viewport instead of resizing the layout,
    // so the composer form is pinned to it explicitly.
    useMobileViewportPin({
        isMobile,
        isFullscreen: isMobileExpanded,
        isDraftScreen: newSessionDraftOpen,
        isFocused: mobileTextareaFocused,
        formRef: composerFormRef,
        editorRef: composerRef,
    });

    // The footer's objective counter shows only while a goal is armed; passing
    // the length otherwise would re-render the whole footer on every keystroke.
    const goalArmed = useSessionGoalArmStore((state) => state.armed);

    // Set by the footer's desktop dictation; the mobile overlay lives outside the box.
    const [desktopDictating, setDesktopDictating] = React.useState(false);

    const goalObjectiveLength = useComposerTextValue(composerText, (text) => (goalArmed ? text.length : 0));

    // The collapsed phone pill shows the draft; nothing can be typed into it.
    const pillText = useComposerTextValue(composerText, (text) => (isMobile && !mobileComposerExpanded ? text : ''));

    const waitingForOpenCode = useOpenCodeStartupStore((state) => state.waitingSends > 0);

    const footerPaddingClass = isMobile ? 'px-1.5 py-1.5' : (isVSCode ? 'px-1.5 py-1' : 'px-2.5 py-1.5');

    const buttonSizeClass = isMobile ? 'h-8 w-8' : (isVSCode ? 'h-5 w-5' : 'h-6 w-6');

    const sendIconSizeClass = isMobile ? 'h-4 w-4' : (isVSCode ? 'h-3.5 w-3.5' : 'h-4 w-4');

    // Inside the action disc, the send arrow's size.
    const stopIconSizeClass = isMobile ? 'h-4 w-4' : (isVSCode ? 'h-3.5 w-3.5' : 'h-4 w-4');

    // 16px on desktop, the size of the model controls' effort and agent icons
    // and of the send arrow, so the footer's glyphs read as one row.
    const iconSizeClass = isMobile ? 'h-[18px] w-[18px]' : 'h-4 w-4';

    const iconButtonBaseClass = 'flex cursor-pointer items-center justify-center text-foreground transition-none outline-none focus:outline-none flex-shrink-0 disabled:cursor-not-allowed';

    const footerIconButtonClass = cn(iconButtonBaseClass, buttonSizeClass);

    const permissionScopeSessionId = isBtwActive ? btwSessionId : currentSessionId ?? currentManagementSessionId;

    const safetyNetAvailable = useRoutingStore(selectSafetyNetAvailable);

    // A session not created yet (a draft, an unsent btw fork) shows its own
    // choice, else the mode the server will give it: the Settings default.
    // VS Code has no server to apply one.
    const defaultPermissionMode = useUIStore((state) => (isVSCode ? 'ask' : state.permissionDefaultMode));

    const permissionMode = usePermissionStore((state) => {
        if (isBtwActive && !btwSessionId) return pendingBtwPermissionMode ?? defaultPermissionMode;
        if (!permissionScopeSessionId) {
            return draftPermissionMode ?? defaultPermissionMode;
        }
        return state.getSessionMode(permissionScopeSessionId);
    });

    const shownPermissionMode = displayedPermissionMode(permissionMode, safetyNetAvailable);

    const isPermissionAutoAcceptInteractive = Boolean(permissionScopeSessionId || newSessionDraftOpen);

    const handlePermissionModeCycle = React.useCallback(() => {
        if (isBtwActive && !btwSessionId && currentSessionId) {
            useBtwStore.getState().setPanelState(currentSessionId, {
                pendingPermissionMode: nextPermissionMode(permissionMode, safetyNetAvailable),
            });
            return;
        }
        cyclePermissionMode({
            permissionScopeSessionId,
            newSessionDraftOpen,
            currentMode: permissionMode,
            safetyAvailable: safetyNetAvailable,
            setDraftPermissionMode,
            setSessionMode,
            onOpenSessionFirst: () => toast.error(t('chat.chatInput.toast.openSessionFirst')),
            onToggleFailed: () => toast.error(t('chat.chatInput.toast.togglePermissionAutoAcceptFailed')),
        });
    }, [
        newSessionDraftOpen,
        permissionMode,
        permissionScopeSessionId,
        safetyNetAvailable,
        isBtwActive,
        btwSessionId,
        currentSessionId,
        setDraftPermissionMode,
        setSessionMode,
        t,
    ]);

    useKeybind('toggle_permission_auto_accept', () => {
        if (!isPermissionAutoAcceptInteractive || isPromptHistorySearchOpen) return false;
        handlePermissionModeCycle();
    });

    // Acknowledging the abort record is what lets the working chip resume for
    // the next run; the old "Aborted" banner that used to accompany it is gone.
    React.useEffect(() => {
        const pendingAbort = Boolean(abortPromptSessionId) && abortPromptSessionId === currentSessionId;
        if (!prevWasAbortedRef.current && pendingAbort && currentSessionId) {
            acknowledgeSessionAbort(currentSessionId);
        }
        prevWasAbortedRef.current = pendingAbort;
    }, [abortPromptSessionId, acknowledgeSessionAbort, currentSessionId, prevWasAbortedRef]);

    return {
        pillText, footerIconButtonClass, iconSizeClass, sendIconSizeClass, stopIconSizeClass,
        openMobileAttachSheet, toggleDictation, desktopDictating, iconButtonBaseClass, goalObjectiveLength,
        footerPaddingClass, shownPermissionMode, isPermissionAutoAcceptInteractive,
        handlePermissionModeCycle, setDesktopDictating, waitingForOpenCode,
    };
}
