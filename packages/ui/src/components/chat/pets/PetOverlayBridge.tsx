/**
 * Desktop-only bridge that keeps the always-on-top pet overlay window in
 * sync with the authoritative state in the main app: visibility, selected
 * pet, pet size, live status, and the assistant-reply preview.
 *
 * The main process owns the overlay window lifecycle (`pet_overlay_show` /
 * `pet_overlay_hide`); this bridge pushes the current display payload with
 * `pet_overlay_update` whenever any of its inputs change. The main process
 * replays the latest payload when the window is (re)created, so the overlay
 * never renders stale state even if it was hidden while the app ran.
 *
 * Non-desktop runtimes render the pet inline (PetBubble) and render nothing
 * here.
 */

import React from 'react';
import { isElectronShell, invokeDesktop } from '@/lib/desktop';
import { useUIStore } from '@/stores/useUIStore';
import { usePetPreference } from './petPreference';
import { usePetState } from './usePetState';
import { usePetAssistantPreview } from './usePetAssistantPreview';

export function PetOverlayBridge() {
    const showPet = useUIStore((state) => state.showPet);
    const petSize = useUIStore((state) => state.petSize);
    const petId = usePetPreference();
    const state = usePetState();
    const preview = usePetAssistantPreview();

    React.useEffect(() => {
        if (!isElectronShell()) return;
        if (showPet) {
            void invokeDesktop('pet_overlay_show');
        } else {
            void invokeDesktop('pet_overlay_hide');
        }
    }, [showPet]);

    React.useEffect(() => {
        if (!isElectronShell() || !showPet) return;
        void invokeDesktop('pet_overlay_update', { petId, state, petSize, preview });
    }, [showPet, petId, state, petSize, preview]);

    return null;
}
