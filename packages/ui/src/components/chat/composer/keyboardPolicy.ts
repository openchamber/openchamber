export interface EnterKeyPolicyInput {
    isMobile: boolean;
    isDesktopExpanded: boolean;
    enterToSend: boolean;
    enterToSendConfigured: boolean;
    shiftKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
}

export const shouldSubmitEnter = (input: EnterKeyPolicyInput): boolean => {
    const isCtrlEnter = input.ctrlKey || input.metaKey;
    if (input.isDesktopExpanded) return isCtrlEnter;

    const enterSendsByDefault = !input.isMobile;
    if (!input.enterToSendConfigured) {
        // Unconfigured desktop sends on bare Enter only: Ctrl/Cmd+Enter
        // inserts a newline (#3614). Unconfigured mobile keeps the hardware
        // keyboard fallback where Ctrl/Cmd+Enter sends.
        if (enterSendsByDefault) return !input.shiftKey && !isCtrlEnter;
        return !input.shiftKey && isCtrlEnter;
    }
    if (input.enterToSend) {
        // "Send with Enter": only a bare Enter (no modifiers) sends;
        // Ctrl/Cmd+Enter inserts a newline (#3614).
        return !input.shiftKey && !isCtrlEnter;
    }
    // "Send with Ctrl/Cmd+Enter": Ctrl/Cmd+Enter (or Shift+Enter) sends.
    return isCtrlEnter || input.shiftKey;
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
