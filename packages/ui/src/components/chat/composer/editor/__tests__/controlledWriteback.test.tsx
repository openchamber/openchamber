import { describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { EditorState, type TransactionSpec } from '@codemirror/state';
import { createRoot } from 'react-dom/client';

import { ComposerEditor, type ComposerEditorHandle, type ComposerEditorProps } from '../ComposerEditor';
import type { ComposerEditorViewStore } from '../viewStore';

class ClassListStub {
    add(): void {}
    remove(): void {}
    contains(): boolean { return false; }
}

class StyleStub {
    maxHeight = '';
    setProperty(): void {}
    getPropertyValue(): string { return ''; }
}

type DocumentStub = {
    nodeType: 9;
    defaultView: WindowStub;
    activeElement: ElementStub | null;
    body: ElementStub;
    documentElement: ElementStub;
    createElement(tag: string): ElementStub;
    createElementNS(namespace: string, tag: string): ElementStub;
    createTextNode(text: string): TextStub;
    addEventListener(): void;
    removeEventListener(): void;
};

class TextStub {
    readonly nodeType = 3 as const;
    readonly nodeName = '#text';
    parentNode: ElementStub | null = null;

    constructor(
        readonly ownerDocument: DocumentStub,
        public textContent: string,
    ) {}
}

class ElementStub {
    readonly nodeType = 1 as const;
    readonly namespaceURI = 'http://www.w3.org/1999/xhtml';
    readonly style = new StyleStub();
    readonly classList = new ClassListStub();
    readonly childNodes: Array<ElementStub | TextStub> = [];
    parentNode: ElementStub | null = null;
    textContent = '';
    innerHTML = '';

    constructor(
        readonly ownerDocument: DocumentStub,
        readonly tagName: string,
    ) {}

    get nodeName(): string {
        return this.tagName;
    }

    addEventListener(): void {}
    removeEventListener(): void {}
    setAttribute(): void {}
    removeAttribute(): void {}
    focus(): void {}
    blur(): void {}

    appendChild(child: ElementStub | TextStub): ElementStub | TextStub {
        child.parentNode = this;
        this.childNodes.push(child);
        return child;
    }

    insertBefore(child: ElementStub | TextStub, reference: ElementStub | TextStub | null): ElementStub | TextStub {
        child.parentNode = this;
        if (reference === null) {
            this.childNodes.push(child);
            return child;
        }
        const index = this.childNodes.indexOf(reference);
        if (index === -1) {
            this.childNodes.push(child);
            return child;
        }
        this.childNodes.splice(index, 0, child);
        return child;
    }

    removeChild(child: ElementStub | TextStub): ElementStub | TextStub {
        const index = this.childNodes.indexOf(child);
        if (index !== -1) this.childNodes.splice(index, 1);
        child.parentNode = null;
        return child;
    }

    remove(): void {
        this.parentNode?.removeChild(this);
    }
}

type WindowStub = {
    document: DocumentStub;
    navigator: { userAgent: string; platform: string; maxTouchPoints: number };
    addEventListener(): void;
    removeEventListener(): void;
    getComputedStyle(): { lineHeight: string };
    HTMLIFrameElement: typeof HostConstructor;
    HTMLFrameSetElement: typeof HostConstructor;
    HTMLInputElement: typeof HostConstructor;
    HTMLTextAreaElement: typeof HostConstructor;
    HTMLSelectElement: typeof HostConstructor;
    HTMLOptionElement: typeof HostConstructor;
    HTMLAnchorElement: typeof HostConstructor;
};

class HostConstructor {}

type GlobalMap = {
    document: DocumentStub;
    window: WindowStub;
    navigator: WindowStub['navigator'];
    requestAnimationFrame: (callback: FrameRequestCallback) => number;
    cancelAnimationFrame: () => void;
    getComputedStyle: () => { lineHeight: string };
    IS_REACT_ACT_ENVIRONMENT: boolean;
    Element: typeof HostConstructor;
    HTMLElement: typeof HostConstructor;
    HTMLIFrameElement: typeof HostConstructor;
    HTMLFrameSetElement: typeof HostConstructor;
    HTMLInputElement: typeof HostConstructor;
    HTMLTextAreaElement: typeof HostConstructor;
    HTMLSelectElement: typeof HostConstructor;
    HTMLOptionElement: typeof HostConstructor;
    HTMLAnchorElement: typeof HostConstructor;
};

type GlobalKey =
    | 'document'
    | 'window'
    | 'navigator'
    | 'requestAnimationFrame'
    | 'cancelAnimationFrame'
    | 'getComputedStyle'
    | 'IS_REACT_ACT_ENVIRONMENT'
    | 'Element'
    | 'HTMLElement'
    | 'HTMLIFrameElement'
    | 'HTMLFrameSetElement'
    | 'HTMLInputElement'
    | 'HTMLTextAreaElement'
    | 'HTMLSelectElement'
    | 'HTMLOptionElement'
    | 'HTMLAnchorElement';

class MutableDocumentStub implements DocumentStub {
    readonly nodeType = 9 as const;
    defaultView!: WindowStub;
    activeElement: ElementStub | null = null;
    body!: ElementStub;
    documentElement!: ElementStub;

    createElement(tag: string): ElementStub {
        return new ElementStub(this, tag.toUpperCase());
    }

    createElementNS(_namespace: string, tag: string): ElementStub {
        return this.createElement(tag);
    }

    createTextNode(text: string): TextStub {
        return new TextStub(this, text);
    }

    addEventListener(): void {}
    removeEventListener(): void {}
}

function installMinimalDom() {
    const descriptors = new Map<GlobalKey, PropertyDescriptor | undefined>();
    const setGlobal = <K extends GlobalKey>(name: K, value: GlobalMap[K]) => {
        descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
        Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    };

    const document = new MutableDocumentStub();
    const window: WindowStub = {
        document,
        navigator: { userAgent: 'test', platform: 'test', maxTouchPoints: 0 },
        addEventListener() {},
        removeEventListener() {},
        getComputedStyle() {
            return { lineHeight: '16px' };
        },
        HTMLIFrameElement: HostConstructor,
        HTMLFrameSetElement: HostConstructor,
        HTMLInputElement: HostConstructor,
        HTMLTextAreaElement: HostConstructor,
        HTMLSelectElement: HostConstructor,
        HTMLOptionElement: HostConstructor,
        HTMLAnchorElement: HostConstructor,
    };

    document.defaultView = window;
    document.body = document.createElement('body');
    document.documentElement = document.createElement('html');

    setGlobal('document', document);
    setGlobal('window', window);
    setGlobal('navigator', window.navigator);
    setGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
        callback(0);
        return 1;
    });
    setGlobal('cancelAnimationFrame', () => {});
    setGlobal('getComputedStyle', () => ({ lineHeight: '16px' }));
    setGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    setGlobal('Element', HostConstructor);
    setGlobal('HTMLElement', HostConstructor);
    setGlobal('HTMLIFrameElement', HostConstructor);
    setGlobal('HTMLFrameSetElement', HostConstructor);
    setGlobal('HTMLInputElement', HostConstructor);
    setGlobal('HTMLTextAreaElement', HostConstructor);
    setGlobal('HTMLSelectElement', HostConstructor);
    setGlobal('HTMLOptionElement', HostConstructor);
    setGlobal('HTMLAnchorElement', HostConstructor);

    const container = document.createElement('div');

    return {
        container,
        document,
        restore() {
            for (const [name, descriptor] of descriptors) {
                if (descriptor) {
                    Object.defineProperty(globalThis, name, descriptor);
                } else {
                    Reflect.deleteProperty(globalThis, name);
                }
            }
        },
    };
}

const LANGUAGE_CONTEXT: ComposerEditorProps['languageContext'] = {
    inputMode: 'normal',
    knownAgentNames: new Set(),
    confirmedMentions: new Set(),
    knownSlashNames: new Set(),
    knownSnippetTriggers: new Set(),
    attachmentFilenames: [],
};

class KeptViewHarness {
    state: EditorState;
    compositionStarted = false;
    hasFocus = false;
    readonly dom: ElementStub;
    readonly contentDOM = {
        isContentEditable: true,
        setAttribute() {},
        focus: () => {
            this.hasFocus = true;
        },
        blur: () => {
            this.hasFocus = false;
        },
    };
    readonly scrollDOM = {
        style: { maxHeight: '' },
        scrollTop: 0,
        scrollHeight: 48,
    };

    constructor(document: DocumentStub, value: string) {
        this.state = EditorState.create({ doc: value });
        this.dom = document.createElement('div');
    }

    requestMeasure(): void {}

    dispatch(spec: TransactionSpec): void {
        if (spec.changes === undefined && spec.selection === undefined && spec.userEvent === undefined) {
            return;
        }
        this.state = this.state.update(spec).state;
    }
}

function renderEditor(initialValue: string) {
    const dom = installMinimalDom();
    // @ts-expect-error TS2345 -- SAFETY: React only uses the DOM container subset implemented by the ElementStub test double.
    const root = createRoot(dom.container);
    const ref = React.createRef<ComposerEditorHandle>();
    const keptView = new KeptViewHarness(dom.document, initialValue);
    const store: ComposerEditorViewStore = {
        // @ts-expect-error TS2352 -- SAFETY: ComposerEditor uses only the kept-view EditorView subset implemented by KeptViewHarness.
        view: keptView,
        handlers: null,
    };

    const render = (value: string) => {
        act(() => {
            root.render(
                <ComposerEditor
                    ref={ref}
                    value={value}
                    onChange={() => {}}
                    languageContext={LANGUAGE_CONTEXT}
                    fillContainer={true}
                    viewStore={store}
                />,
            );
        });
    };

    render(initialValue);

    return {
        ref,
        render,
        teardown() {
            act(() => {
                root.unmount();
            });
            dom.restore();
        },
    };
}

describe('ComposerEditor controlled writeback', () => {
    test('normalizes CRLF rewrites and leaves the caret at the normalized document end', () => {
        const editor = renderEditor('a');
        try {
            editor.render('x\r\ny');
            expect(editor.ref.current?.getValue()).toBe('x\ny');
            expect(editor.ref.current?.getSelection()).toEqual({ start: 3, end: 3 });
        } finally {
            editor.teardown();
        }
    });

    test('places the caret at the end of a plain external rewrite', () => {
        const editor = renderEditor('a');
        try {
            editor.render('xyz');
            expect(editor.ref.current?.getValue()).toBe('xyz');
            expect(editor.ref.current?.getSelection()).toEqual({ start: 3, end: 3 });
        } finally {
            editor.teardown();
        }
    });
});
