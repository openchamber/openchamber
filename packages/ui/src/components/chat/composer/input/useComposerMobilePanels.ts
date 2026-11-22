import React from 'react';
import { type MobileControlsPanel } from '../../mobileControlsUtils';



export function useComposerMobilePanels() {
    const [mobileControlsPanel, setMobileControlsPanel] = React.useState<MobileControlsPanel>(null);

    const [mobileAttachMenuOpen, setMobileAttachMenuOpen] = React.useState(false);

    const [mobileDraftPicker, setMobileDraftPicker] = React.useState<'project' | 'branch' | null>(null);

    return {
    mobileControlsPanel, setMobileControlsPanel, mobileAttachMenuOpen, setMobileAttachMenuOpen,
    mobileDraftPicker, setMobileDraftPicker,
    };
}
