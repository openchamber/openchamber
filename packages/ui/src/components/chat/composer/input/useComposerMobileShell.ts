import type { useComposerReferencePickerState } from './useComposerReferencePickerState';
import type { useComposerPreferences } from './useComposerPreferences';
import type { useComposerMobilePanels } from './useComposerMobilePanels';
import type { useComposerHistorySearchState } from './useComposerHistorySearchState';
import type { useComposerExpansion } from './useComposerExpansion';
import type { useComposerEditorState } from './useComposerEditorState';
import type { useComposerDropState } from './useComposerDropState';
import { useMobileComposerShell } from '../../composer/state/useMobileComposerShell';

type Dependencies = {
    preferences: Pick<ReturnType<typeof useComposerPreferences>, 'isMobile' | 'hasHardwareKeyboard' | 'isTabletLayout' | 'roomyForOnePanel'>;
    expansion: Pick<ReturnType<typeof useComposerExpansion>, 'setExpandedInput'>;
    referencePickerState: Pick<ReturnType<typeof useComposerReferencePickerState>, 'referencePicker'>;
    editorState: Pick<ReturnType<typeof useComposerEditorState>, 'composerRef' | 'composerFormRef'>;
    mobilePanels: Pick<ReturnType<typeof useComposerMobilePanels>, 'mobileControlsPanel' | 'mobileAttachMenuOpen' | 'mobileDraftPicker'>;
    historySearchState: Pick<ReturnType<typeof useComposerHistorySearchState>, 'promptHistorySearch' | 'historyFocusPending'>;
    dropState: Pick<ReturnType<typeof useComposerDropState>, 'isDragging'>;
};

export function useComposerMobileShell({
    preferences, expansion, referencePickerState, editorState, mobilePanels, historySearchState, dropState,
}: Dependencies) {
    const { isMobile, hasHardwareKeyboard, isTabletLayout, roomyForOnePanel } = preferences;
    const { setExpandedInput } = expansion;
    const { referencePicker } = referencePickerState;
    const { composerRef, composerFormRef } = editorState;
    const { mobileControlsPanel, mobileAttachMenuOpen, mobileDraftPicker } = mobilePanels;
    const { promptHistorySearch, historyFocusPending } = historySearchState;
    const { isDragging } = dropState;


    const mobileShell = useMobileComposerShell({
        isMobile,
        editorRef: composerRef,
        formRef: composerFormRef,
        setExpandedInput,
        alwaysExpanded: hasHardwareKeyboard || (isTabletLayout && !roomyForOnePanel),
        holders: {
            controlsPanelOpen: Boolean(mobileControlsPanel),
            attachMenuOpen: mobileAttachMenuOpen,
            draftPickerOpen: mobileDraftPicker !== null,
            referencePickerOpen: referencePicker !== null,
            promptHistorySearchOpen: promptHistorySearch !== null || historyFocusPending,
            isDragging,
        },
    });

    const mobileComposerExpanded = mobileShell.expanded;

    const mobileTextareaFocused = mobileShell.focused;

    return {
        mobileComposerExpanded, mobileShell, mobileTextareaFocused,
    };
}
