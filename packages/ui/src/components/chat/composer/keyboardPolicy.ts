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
    const enterSendsByDefault = !input.isMobile && !input.isDesktopExpanded;
    const isCtrlEnter = input.ctrlKey || input.metaKey;
    if (!input.enterToSendConfigured) {
        return !input.shiftKey && (enterSendsByDefault || isCtrlEnter);
    }
    const enterSends = input.enterToSend;
    const sendsWithEnter = enterSends
        ? !input.shiftKey
        : input.shiftKey;

    return isCtrlEnter || sendsWithEnter;
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
