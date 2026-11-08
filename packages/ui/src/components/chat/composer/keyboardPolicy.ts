export interface EnterKeyPolicyInput {
    isMobile: boolean;
    isDesktopExpanded: boolean;
    enterToSend: boolean;
    enterToSendConfigured: boolean;
    shiftKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
    altKey: boolean;
    /** Mobile return-key send (enterkeyhint="send"); desktop ignores it. */
    returnKeySends?: boolean;
}

export const shouldSubmitEnter = (input: EnterKeyPolicyInput): boolean => {
    const isCtrlEnter = input.ctrlKey || input.metaKey;
    if (input.isMobile) return isCtrlEnter || (input.returnKeySends === true && !input.shiftKey && !input.altKey);
    if (input.isDesktopExpanded) return isCtrlEnter;

    if (!input.enterToSendConfigured) {
        return !input.shiftKey && (!input.altKey || isCtrlEnter);
    }
    const sendsWithEnter = input.enterToSend && !input.shiftKey && !input.altKey;

    return isCtrlEnter || sendsWithEnter;
};

export interface EnterModifierState {
    shiftKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
    altKey?: boolean;
}

/**
 * On mobile a deferred Enter keeps Shift only from a hardware keyboard, in both
 * Return modes: iOS autocapitalization arms a phantom Shift at sentence starts
 * on the soft keyboard, which must neither block Send nor continue a list.
 */
export const shouldPreserveDeferredEnterShift = (input: {
    isMobile: boolean;
    hasHardwareKeyboard: boolean;
}): boolean => !input.isMobile || input.hasHardwareKeyboard;

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
    if (modifiers.altKey) Object.defineProperty(event, 'altKey', { value: true });
};
