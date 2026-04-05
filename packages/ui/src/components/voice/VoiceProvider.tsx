import React from 'react';
import { useVoiceContext } from '@/hooks/useVoiceContext';
import { useConfigStore } from '@/stores/useConfigStore';

const VoiceContextBridge = React.memo(function VoiceContextBridge() {
    useVoiceContext();
    return null;
});

/**
 * Provider component that initializes voice context sync.
 * Wrap the app with this to enable voice session awareness.
 * 
 * @example
 * ```tsx
 * <VoiceProvider>
 *   <App />
 * </VoiceProvider>
 * ```
 */
export function VoiceProvider({ children }: { children: React.ReactNode }) {
    const voiceModeEnabled = useConfigStore((state) => state.voiceModeEnabled);

    return (
        <>
            {voiceModeEnabled ? <VoiceContextBridge /> : null}
            {children}
        </>
    );
}
