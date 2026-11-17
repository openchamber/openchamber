import React from 'react';
import { useMobileComposerShell } from '../../composer/state/useMobileComposerShell';
import type { useComposerEnvironment } from './useComposerEnvironment';
import type { useComposerInputState } from './useComposerInputState';
import type { ReferencePickerState } from './referencePickerState';

type Dependencies = Pick<ReturnType<typeof useComposerEnvironment>, 'isMobile' | 'setExpandedInput' | 'hasHardwareKeyboard' | 'isTabletLayout' | 'roomyForOnePanel'>
    & Pick<ReturnType<typeof useComposerInputState>, 'composerRef' | 'composerFormRef' | 'mobileControlsPanel' | 'mobileAttachMenuOpen' | 'mobileDraftPicker' | 'promptHistorySearch' | 'historyFocusPending' | 'isDragging'>;

export function useComposerMobileShell({
    isMobile, composerRef, composerFormRef, setExpandedInput, hasHardwareKeyboard, isTabletLayout,
    roomyForOnePanel, mobileControlsPanel, mobileAttachMenuOpen, mobileDraftPicker, promptHistorySearch,
    historyFocusPending, isDragging,
}: Dependencies) {
    // Issue linking state
    const [referencePicker, setReferencePicker] = React.useState<ReferencePickerState>(null);

    // The paste-toast tap may need to reopen the collapsed mobile composer.
    const mobileShell = useMobileComposerShell({
        isMobile,
        editorRef: composerRef,
        formRef: composerFormRef,
        setExpandedInput,
        // Without a soft keyboard, keep the full composer up. So does a tablet,
        // except where only one side panel fits (an unfolded iPhone Duo, a
        // 13-inch iPad in portrait), which keeps the phone's pill.
        alwaysExpanded: hasHardwareKeyboard || (isTabletLayout && !roomyForOnePanel),
        holders: {
            controlsPanelOpen: Boolean(mobileControlsPanel),
            attachMenuOpen: mobileAttachMenuOpen,
            draftPickerOpen: mobileDraftPicker !== null,
            referencePickerOpen: referencePicker !== null,
            // Keep the editor mounted until the closing search hands focus back.
            promptHistorySearchOpen: promptHistorySearch !== null || historyFocusPending,
            isDragging,
        },
    });

    const mobileComposerExpanded = mobileShell.expanded;

    const mobileTextareaFocused = mobileShell.focused;

    return {
        mobileComposerExpanded, setReferencePicker, mobileShell, mobileTextareaFocused, referencePicker,
    };
}
