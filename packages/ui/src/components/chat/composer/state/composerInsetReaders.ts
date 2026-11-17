
interface ComposerInsets {
    readonly inset: number;
    readonly tailInset: number;
}

type ReaderRelease = () => void;

const setPx = (element: HTMLElement, property: string, px: number | null) => {
    if (px === null) {
        element.style.removeProperty(property);
        return;
    }
    const value = `${px}px`;
    if (element.style.getPropertyValue(property) !== value) element.style.setProperty(property, value);
};

const createReaderChannel = <TValue>(attribute: string, apply: (reader: HTMLElement, value: TValue | null) => void) => {
    const readers = new Set<HTMLElement>();
    const publishedByColumn = new WeakMap<HTMLElement, TValue>();
    const applyInside = (column: HTMLElement, value: TValue | null) => {
        for (const reader of readers) {
            if (column.contains(reader)) apply(reader, value);
        }
    };
    return {
        register(reader: HTMLElement): ReaderRelease {
            readers.add(reader);
            const column = reader.closest<HTMLElement>(`[${attribute}]`);
            apply(reader, column ? publishedByColumn.get(column) ?? null : null);
            return () => {
                readers.delete(reader);
            };
        },
        read(column: HTMLElement): TValue | undefined {
            return publishedByColumn.get(column);
        },
        publish(column: HTMLElement, value: TValue) {
            column.setAttribute(attribute, '');
            publishedByColumn.set(column, value);
            applyInside(column, value);
        },
        withdraw(column: HTMLElement) {
            column.removeAttribute(attribute);
            publishedByColumn.delete(column);
            applyInside(column, null);
        },
    };
};

const composerInsets = createReaderChannel<ComposerInsets>('data-composer-inset-column', (reader, insets) => {
    setPx(reader, '--chat-composer-inset', insets?.inset ?? null);
    setPx(reader, '--chat-composer-tail-inset', insets?.tailInset ?? null);
});

interface FloatingPanelClearance {
    readonly clearance: number;
    readonly tailReserve: number;
}

const floatingPanelClearance = createReaderChannel<FloatingPanelClearance>('data-floating-panel-clearance-column', (reader, value) => {
    setPx(reader, '--chat-floating-panel-clearance', value?.clearance ?? null);
    setPx(reader, '--chat-floating-panel-reserve', value?.tailReserve ?? null);
});

export const registerComposerInsetReader = (reader: HTMLElement | null): ReaderRelease | undefined => {
    if (!reader) return undefined;
    const releaseInsets = composerInsets.register(reader);
    const releaseClearance = floatingPanelClearance.register(reader);
    return () => {
        releaseInsets();
        releaseClearance();
    };
};

export const registerFloatingPanelClearanceReader = (reader: HTMLElement | null): ReaderRelease | undefined => {
    if (!reader) return undefined;
    return floatingPanelClearance.register(reader);
};

export const publishComposerInsets = (column: HTMLElement, insets: ComposerInsets): void => {
    composerInsets.publish(column, insets);
};

export const withdrawComposerInsets = (column: HTMLElement): void => {
    composerInsets.withdraw(column);
};

export const publishFloatingPanelClearance = (column: HTMLElement, value: FloatingPanelClearance): void => {
    floatingPanelClearance.publish(column, value);
};

export const readFloatingPanelTailReserve = (column: HTMLElement): number => floatingPanelClearance.read(column)?.tailReserve ?? 0;

export const withdrawFloatingPanelClearance = (column: HTMLElement): void => {
    floatingPanelClearance.withdraw(column);
};
