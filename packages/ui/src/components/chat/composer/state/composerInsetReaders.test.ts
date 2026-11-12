import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import {
    publishComposerInsets,
    publishFloatingPanelClearance,
    registerComposerInsetReader,
    registerFloatingPanelClearanceReader,
    withdrawComposerInsets,
    withdrawFloatingPanelClearance,
} from './composerInsetReaders';

const DOM_GLOBAL_NAMES = ['window', 'document', 'HTMLElement'] as const;

describe('composer inset readers', () => {
    let win: Window;
    let restoreGlobals: () => void;
    let column: HTMLElement;
    let transcriptRow: HTMLElement;
    let spacer: HTMLElement;
    let band: HTMLElement;
    const releases: Array<() => void> = [];

    const register = (element: HTMLElement) => {
        const release = registerComposerInsetReader(element);
        if (release) releases.push(release);
    };
    const registerClearance = (element: HTMLElement) => {
        const release = registerFloatingPanelClearanceReader(element);
        if (release) releases.push(release);
    };

    beforeEach(() => {
        win = new Window();
        const previous = DOM_GLOBAL_NAMES.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
        const values = { window: win, document: win.document, HTMLElement: win.HTMLElement };
        for (const name of DOM_GLOBAL_NAMES) Object.defineProperty(globalThis, name, { value: values[name], configurable: true, writable: true });
        restoreGlobals = () => {
            for (const [name, descriptor] of previous) {
                if (descriptor) Object.defineProperty(globalThis, name, descriptor);
                else Reflect.deleteProperty(globalThis, name);
            }
        };
        column = document.createElement('div');
        transcriptRow = document.createElement('div');
        spacer = document.createElement('div');
        band = document.createElement('div');
        column.append(transcriptRow, spacer, band);
        document.body.append(column);
    });

    afterEach(() => {
        for (const release of releases.splice(0)) release();
        restoreGlobals();
        void win.happyDOM.close();
    });

    test('writes the insets onto the readers, never onto the column or the transcript', () => {
        register(spacer);
        register(band);

        publishComposerInsets(column, { inset: 118, tailInset: 198 });

        for (const reader of [spacer, band]) {
            expect(reader.style.getPropertyValue('--chat-composer-inset')).toBe('118px');
            expect(reader.style.getPropertyValue('--chat-composer-tail-inset')).toBe('198px');
        }
        expect(column.style.getPropertyValue('--chat-composer-inset')).toBe('');
        expect(column.style.getPropertyValue('--chat-composer-tail-inset')).toBe('');
        expect(transcriptRow.style.getPropertyValue('--chat-composer-inset')).toBe('');
    });

    test('a reader mounted after the column published takes its current values', () => {
        publishComposerInsets(column, { inset: 150, tailInset: 210 });
        register(spacer);

        expect(spacer.style.getPropertyValue('--chat-composer-tail-inset')).toBe('210px');
    });

    test('readers of another column are left alone', () => {
        const other = document.createElement('div');
        const otherSpacer = document.createElement('div');
        other.append(otherSpacer);
        document.body.append(other);
        register(spacer);
        register(otherSpacer);

        publishComposerInsets(column, { inset: 118, tailInset: 198 });

        expect(otherSpacer.style.getPropertyValue('--chat-composer-tail-inset')).toBe('');
    });

    test('withdrawing returns the readers to their CSS fallbacks', () => {
        register(spacer);
        publishComposerInsets(column, { inset: 118, tailInset: 198 });

        withdrawComposerInsets(column);

        expect(spacer.style.getPropertyValue('--chat-composer-inset')).toBe('');
        expect(spacer.style.getPropertyValue('--chat-composer-tail-inset')).toBe('');
    });

    test('a released reader is no longer written', () => {
        const release = registerComposerInsetReader(spacer);
        release?.();

        publishComposerInsets(column, { inset: 118, tailInset: 198 });

        expect(spacer.style.getPropertyValue('--chat-composer-tail-inset')).toBe('');
    });

    test('the floating panel clearance goes onto its readers, never onto the column or the transcript', () => {
        const overlay = document.createElement('div');
        column.append(overlay);
        register(spacer);
        registerClearance(overlay);

        publishFloatingPanelClearance(column, 64);

        expect(spacer.style.getPropertyValue('--chat-floating-panel-clearance')).toBe('64px');
        expect(overlay.style.getPropertyValue('--chat-floating-panel-clearance')).toBe('64px');
        expect(column.style.getPropertyValue('--chat-floating-panel-clearance')).toBe('');
        expect(transcriptRow.style.getPropertyValue('--chat-floating-panel-clearance')).toBe('');
        // A clearance-only reader does not take the composer insets.
        publishComposerInsets(column, { inset: 118, tailInset: 198 });
        expect(overlay.style.getPropertyValue('--chat-composer-inset')).toBe('');
    });

    test('a clearance reader mounted while a panel is docked takes its clearance', () => {
        publishFloatingPanelClearance(column, 52);
        const overlay = document.createElement('div');
        column.append(overlay);
        registerClearance(overlay);

        expect(overlay.style.getPropertyValue('--chat-floating-panel-clearance')).toBe('52px');
    });

    test('the clearance and the insets publish and withdraw independently', () => {
        register(spacer);
        publishComposerInsets(column, { inset: 118, tailInset: 198 });
        publishFloatingPanelClearance(column, 64);

        withdrawFloatingPanelClearance(column);

        expect(spacer.style.getPropertyValue('--chat-floating-panel-clearance')).toBe('');
        expect(spacer.style.getPropertyValue('--chat-composer-tail-inset')).toBe('198px');

        publishFloatingPanelClearance(column, 40);
        withdrawComposerInsets(column);

        expect(spacer.style.getPropertyValue('--chat-floating-panel-clearance')).toBe('40px');
        expect(spacer.style.getPropertyValue('--chat-composer-tail-inset')).toBe('');
    });
});
