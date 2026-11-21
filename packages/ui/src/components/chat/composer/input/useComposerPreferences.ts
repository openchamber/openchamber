import React from 'react';
import { useUIStore } from '@/stores/useUIStore';
import { useTabletLayout } from '@/lib/device';
import { useHardwareKeyboard } from '@/lib/hardwareKeyboard';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { getEffectiveShortcutCombo } from '@/lib/shortcuts';



export function useComposerPreferences() {
    const isMobile = useUIStore((state) => state.isMobile);

    const hasHardwareKeyboard = useHardwareKeyboard();

    const enterToSend = useUIStore((state) => state.enterToSend);

    const enterToSendConfigured = useUIStore((state) => state.enterToSendConfigured);

    const mobileReturnKeySends = useUIStore((state) => state.mobileReturnKeySends);

    const { enabled: isTabletLayout, roomyForOnePanel } = useTabletLayout();
    const inputBarOffset = useUIStore((state) => state.inputBarOffset);

    const inputSpellcheckEnabled = useUIStore((state) => state.inputSpellcheckEnabled);

    const largeTextPasteBehavior = useUIStore((state) => state.largeTextPasteBehavior);
    const cycleAgentShortcutOverride = useUIStore((state) => state.shortcutOverrides.cycle_agent);

    const cycleAgentShortcut = React.useMemo(() => (
        getEffectiveShortcutCombo('cycle_agent', cycleAgentShortcutOverride ? { cycle_agent: cycleAgentShortcutOverride } : undefined)
    ), [cycleAgentShortcutOverride]);

    const { currentTheme } = useThemeSystem();
    const chatInputRadius = isMobile ? '1.25rem' : 'var(--radius-xl)';

    return {
    isMobile, hasHardwareKeyboard, enterToSend, enterToSendConfigured, mobileReturnKeySends,
    isTabletLayout, roomyForOnePanel, inputBarOffset, inputSpellcheckEnabled, largeTextPasteBehavior,
    cycleAgentShortcut, currentTheme, chatInputRadius,
    };
}
