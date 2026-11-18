import React from 'react';
import type { ReferencePickerState } from './referencePickerState';

export function useComposerReferencePickerState() {
    const [referencePicker, setReferencePicker] = React.useState<ReferencePickerState>(null);

    return {
        referencePicker, setReferencePicker,
    };
}
