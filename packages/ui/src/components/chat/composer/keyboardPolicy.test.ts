import { describe, expect, test } from 'bun:test';

import {
    restoreDeferredEnterModifiers,
    shouldSubmitEnter,
    type EnterKeyPolicyInput,
    type EnterModifierState,
} from './keyboardPolicy';

const policy = (overrides: Partial<EnterKeyPolicyInput>): EnterKeyPolicyInput => ({
    isMobile: false,
    isDesktopExpanded: false,
    enterToSend: false,
    enterToSendConfigured: false,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    ...overrides,
});

const enterPolicyCases: Array<[string, Partial<EnterKeyPolicyInput>, boolean]> = [
        ['mobile default Enter inserts a newline', { isMobile: true }, false],
        ['desktop default Enter sends', {}, true],
        ['desktop focus mode default Enter inserts a newline', { isDesktopExpanded: true }, false],
        ['configured enabled Enter sends on desktop', { enterToSendConfigured: true, enterToSend: true }, true],
        ['configured enabled Shift+Enter inserts a newline', { enterToSendConfigured: true, enterToSend: true, shiftKey: true }, false],
        ['configured disabled Enter inserts a newline', { enterToSendConfigured: true, enterToSend: false }, false],
        ['configured disabled Shift+Enter sends', { enterToSendConfigured: true, enterToSend: false, shiftKey: true }, true],
        ['configured Ctrl+Enter sends on desktop', { enterToSendConfigured: true, isDesktopExpanded: true, shiftKey: true, ctrlKey: true }, true],
        ['configured Meta+Enter sends on desktop', { enterToSendConfigured: true, isDesktopExpanded: true, shiftKey: true, metaKey: true }, true],
        ['desktop default Ctrl+Enter inserts a newline', { ctrlKey: true }, false],
        ['desktop default Cmd+Enter inserts a newline', { metaKey: true }, false],
        ['configured enabled Ctrl+Enter inserts a newline', { enterToSendConfigured: true, enterToSend: true, ctrlKey: true }, false],
        ['configured enabled Cmd+Enter inserts a newline', { enterToSendConfigured: true, enterToSend: true, metaKey: true }, false],
        ['configured enabled Shift+Ctrl+Enter inserts a newline', { enterToSendConfigured: true, enterToSend: true, shiftKey: true, ctrlKey: true }, false],
        ['configured disabled Ctrl+Enter sends', { enterToSendConfigured: true, enterToSend: false, ctrlKey: true }, true],
        ['mobile default Ctrl+Enter sends', { isMobile: true, ctrlKey: true }, true],
        ['expanded composer Enter inserts a newline when Enter-to-send is enabled', { isDesktopExpanded: true, enterToSendConfigured: true, enterToSend: true }, false],
        ['expanded composer Shift+Enter inserts a newline when Enter-to-send is disabled', { isDesktopExpanded: true, enterToSendConfigured: true, enterToSend: false, shiftKey: true }, false],
        ['expanded composer Ctrl+Enter sends despite Enter-to-send being disabled', { isDesktopExpanded: true, enterToSendConfigured: true, ctrlKey: true }, true],
        ['expanded composer Cmd+Enter sends despite Enter-to-send being enabled', { isDesktopExpanded: true, enterToSendConfigured: true, enterToSend: true, metaKey: true }, true],
        ['mobile expanded Ctrl+Enter sends', { enterToSendConfigured: true, isMobile: true, isDesktopExpanded: true, shiftKey: true, ctrlKey: true }, true],
        ['mobile expanded Meta+Enter sends', { enterToSendConfigured: true, isMobile: true, isDesktopExpanded: true, shiftKey: true, metaKey: true }, true],
];

describe('Enter key policy', () => {
    test('mobile requires Ctrl/Cmd to submit regardless of synced settings or Shift', () => {
        for (const enterToSendConfigured of [false, true]) {
            for (const enterToSend of [false, true]) {
                for (const shiftKey of [false, true]) {
                    for (const ctrlKey of [false, true]) {
                        for (const metaKey of [false, true]) {
                            expect(shouldSubmitEnter(policy({
                                isMobile: true,
                                enterToSendConfigured,
                                enterToSend,
                                shiftKey,
                                ctrlKey,
                                metaKey,
                            }))).toBe(ctrlKey || metaKey);
                        }
                    }
                }
            }
        }
    });

    for (const surface of [{}, { isMobile: true }, { isDesktopExpanded: true }]) {
        for (const modifiers of [{}, { ctrlKey: true }, { metaKey: true }, { ctrlKey: true, metaKey: true }]) {
            test(`untouched Shift+Enter requires Ctrl/Cmd and a mobile or expanded composer: ${JSON.stringify({ ...surface, ...modifiers })}`, () => {
                expect(shouldSubmitEnter(policy({ ...surface, ...modifiers, shiftKey: true })))
                    .toBe(Boolean((surface.isMobile || surface.isDesktopExpanded) && (modifiers.ctrlKey || modifiers.metaKey)));
            });
        }
    }

    for (const [name, overrides, expected] of enterPolicyCases) {
        test(name, () => {
        expect(shouldSubmitEnter(policy(overrides))).toBe(expected);
        });
    }
});

const deferredModifierCases: Array<[string, EnterModifierState]> = [
        ['Shift', { shiftKey: true, ctrlKey: false, metaKey: false }],
        ['Ctrl', { shiftKey: false, ctrlKey: true, metaKey: false }],
        ['Meta', { shiftKey: false, ctrlKey: false, metaKey: true }],
        ['Shift+Ctrl+Meta', { shiftKey: true, ctrlKey: true, metaKey: true }],
];

describe('deferred Enter modifiers', () => {
    test('Android deferred Enter ignores the synced desktop preference and keeps Ctrl/Cmd', () => {
        for (const enterToSend of [false, true]) {
            for (const modifiers of deferredModifierCases.map(([, value]) => value)) {
                const event = { shiftKey: false, ctrlKey: false, metaKey: false };
                // Configured mobile autocapitalization deliberately skips Shift restoration.
                restoreDeferredEnterModifiers(event, modifiers, false);
                expect(shouldSubmitEnter(policy({
                    isMobile: true,
                    enterToSendConfigured: true,
                    enterToSend,
                    ...event,
                }))).toBe(modifiers.ctrlKey || modifiers.metaKey);
            }
        }
    });

    for (const modifiers of [{ shiftKey: true, ctrlKey: true, metaKey: false }, { shiftKey: true, ctrlKey: false, metaKey: true }]) {
        test(`mobile deferred Ctrl/Cmd submits even with Shift: ${JSON.stringify(modifiers)}`, () => {
            const event = { shiftKey: false, ctrlKey: false, metaKey: false };
            restoreDeferredEnterModifiers(event, modifiers, true);
            expect(shouldSubmitEnter(policy({ isMobile: true, ...event }))).toBe(true);
        });
    }

    for (const [name, modifiers] of deferredModifierCases) {
        test(`preserves ${name}`, () => {
        const event = { shiftKey: false, ctrlKey: false, metaKey: false };

        restoreDeferredEnterModifiers(event, modifiers);

        expect(event).toEqual(modifiers);
        });
    }

    test('does not restore iOS auto-capitalization as Shift', () => {
        const event = { shiftKey: false, ctrlKey: false, metaKey: false };

        restoreDeferredEnterModifiers(event, { shiftKey: true, ctrlKey: false, metaKey: false }, false);

        expect(event).toEqual({ shiftKey: false, ctrlKey: false, metaKey: false });
    });
});
