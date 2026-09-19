export type ImeTraceValue = boolean | number | string;

export interface ImeTraceEvent {
    t: number;
    name: string;
    data?: Record<string, ImeTraceValue>;
}

export interface ImeTraceConfig {
    traceEnabled: boolean;
    editContextDisabled: boolean;
    traceSource: 'query' | 'localStorage' | 'disabled';
    editContextSource: 'query' | 'default';
}

export interface ImeTraceSnapshot {
    config: ImeTraceConfig;
    events: ImeTraceEvent[];
}

export interface EditContextTarget {
    readonly prototype: object;
}

declare global {
    interface Window {
        __OPENCHAMBER_IME_TRACE__?: ImeTraceEvent[];
        __OPENCHAMBER_IME_TRACE_START__?: number;
    }
}

const MAX_IME_TRACE_EVENTS = 250;

export function parseImeTraceOptions(search: string, storageValue: string | null): ImeTraceConfig {
    const params = new URLSearchParams(search);
    const queryTrace = params.get('imeTrace') === '1';
    const storageTrace = storageValue === '1';
    const editContextDisabled = params.get('imeEditContext') === 'off';

    return {
        traceEnabled: queryTrace || storageTrace,
        editContextDisabled,
        traceSource: queryTrace ? 'query' : storageTrace ? 'localStorage' : 'disabled',
        editContextSource: editContextDisabled ? 'query' : 'default',
    };
}

function readRuntimeOptions(): ImeTraceConfig {
    const currentWindow = globalThis.window;
    if (!currentWindow) {
        return parseImeTraceOptions('', null);
    }
    try {
        return parseImeTraceOptions(currentWindow.location.search, currentWindow.localStorage.getItem('OPENCHAMBER_IME_TRACE'));
    } catch {
        return parseImeTraceOptions(currentWindow.location.search, null);
    }
}

const runtimeOptions = readRuntimeOptions();

export function imeTraceOptions(): ImeTraceConfig {
    return runtimeOptions;
}

export function imeTraceEnabled(): boolean {
    return runtimeOptions.traceEnabled;
}

export function configureImeEditContext(target: EditContextTarget): void {
    if (!runtimeOptions.editContextDisabled) return;
    if (Object.getOwnPropertyDescriptor(target, 'EDIT_CONTEXT')?.value === false) return;
    Object.defineProperty(target, 'EDIT_CONTEXT', {
        configurable: true,
        value: false,
        writable: true,
    });
}

export function imeEditContextEnabled(target: EditContextTarget): boolean {
    return Object.getOwnPropertyDescriptor(target, 'EDIT_CONTEXT')?.value !== false;
}

export function recordImeTrace(name: string, data?: Record<string, ImeTraceValue>): void {
    const currentWindow = globalThis.window;
    if (!runtimeOptions.traceEnabled || !currentWindow) return;
    const now = globalThis.performance?.now() ?? Date.now();
    currentWindow.__OPENCHAMBER_IME_TRACE_START__ ??= now;
    currentWindow.__OPENCHAMBER_IME_TRACE__ ??= [];
    const event: ImeTraceEvent = { t: Math.round(now - currentWindow.__OPENCHAMBER_IME_TRACE_START__), name };
    if (data) event.data = data;
    currentWindow.__OPENCHAMBER_IME_TRACE__.push(event);
    if (currentWindow.__OPENCHAMBER_IME_TRACE__.length > MAX_IME_TRACE_EVENTS) {
        currentWindow.__OPENCHAMBER_IME_TRACE__.splice(0, currentWindow.__OPENCHAMBER_IME_TRACE__.length - MAX_IME_TRACE_EVENTS);
    }
}

export function getImeTraceSnapshot(): ImeTraceSnapshot {
    return {
        config: runtimeOptions,
        events: globalThis.window ? [...(globalThis.window.__OPENCHAMBER_IME_TRACE__ ?? [])] : [],
    };
}
