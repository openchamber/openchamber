import { resolveEnterSendMode, type EnterSendModeSettings } from '@/lib/enterSendMode';

export interface EnterKeyPolicyInput extends EnterSendModeSettings {
    isMobile: boolean;
    isDesktopExpanded: boolean;
    shiftKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
    altKey?: boolean;
    rightModifierHeld?: boolean;
}

export const shouldSubmitEnter = (input: EnterKeyPolicyInput): boolean => {
    const isCtrlEnter = input.ctrlKey || input.metaKey;
    if (input.isMobile) return isCtrlEnter;

    const mode = resolveEnterSendMode(input);
    if (mode === 'right-modifier') {
        return Boolean(input.rightModifierHeld) && !input.altKey;
    }
    if (input.isDesktopExpanded) return isCtrlEnter;
    if (mode === 'default') return !input.shiftKey;

    return isCtrlEnter || (mode === 'enter' && !input.shiftKey);
};

export interface EnterModifierState {
    shiftKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
}

export const restoreDeferredEnterModifiers = (
    event: EnterModifierState,
    modifiers: EnterModifierState,
    preserveShift = true,
): void => {
    if (preserveShift && modifiers.shiftKey) {
        Object.defineProperty(event, 'shiftKey', { value: true });
    }
    if (modifiers.ctrlKey) Object.defineProperty(event, 'ctrlKey', { value: true });
    if (modifiers.metaKey) Object.defineProperty(event, 'metaKey', { value: true });
};
