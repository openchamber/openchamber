/**
 * Publishes the floating composer's geometry onto the elements that read it.
 *
 * `--chat-composer-inset` (the slot's height, read by the transcript's end
 * fade band), `--chat-composer-tail-inset` (read by the list footer's tail
 * spacer) and `--chat-floating-panel-clearance` (the height of a panel docked
 * above the composer, read by both of them and by the overlays riding the
 * composer's top edge) change with every composer line or panel resize.
 * Written on the chat column, they inherited into the whole transcript, and
 * each change restyled every element of it (about 50,000 in a long session,
 * 60-90 ms per new composer line). The readers are leaves or small overlays,
 * so the values are written on them directly: a reader registers when it
 * mounts and gets the column's current values at once, and the column's
 * observer updates the registered readers inside it.
 */

interface ComposerInsets {
    /** The composer slot's height, px. */
    readonly inset: number;
    /** The band the list footer reserves for the composer, px. */
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

/**
 * One published value per column, and the readers it is written onto. The
 * column carries `attribute` while it publishes, so a reader mounting later
 * finds the value it falls under.
 */
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

const floatingPanelClearance = createReaderChannel<number>('data-floating-panel-clearance-column', (reader, px) => {
    setPx(reader, '--chat-floating-panel-clearance', px);
});

/**
 * Registers an element that reads the composer insets and the floating panel
 * clearance (the tail spacer and the end fade band; use as a ref callback).
 * Until its column publishes, the reader keeps its CSS fallbacks.
 */
export const registerComposerInsetReader = (reader: HTMLElement | null): ReaderRelease | undefined => {
    if (!reader) return undefined;
    const releaseInsets = composerInsets.register(reader);
    const releaseClearance = floatingPanelClearance.register(reader);
    return () => {
        releaseInsets();
        releaseClearance();
    };
};

/**
 * Registers an element that reads only the floating panel clearance (the
 * overlays that ride above the composer; use as a ref callback).
 */
export const registerFloatingPanelClearanceReader = (reader: HTMLElement | null): ReaderRelease | undefined => {
    if (!reader) return undefined;
    return floatingPanelClearance.register(reader);
};

/** The column's composer measured these insets; its readers take them. */
export const publishComposerInsets = (column: HTMLElement, insets: ComposerInsets): void => {
    composerInsets.publish(column, insets);
};

/** The column's composer stopped floating: its readers fall back to CSS. */
export const withdrawComposerInsets = (column: HTMLElement): void => {
    composerInsets.withdraw(column);
};

/** A panel docked above the column's composer measured this clearance, px. */
export const publishFloatingPanelClearance = (column: HTMLElement, clearance: number): void => {
    floatingPanelClearance.publish(column, clearance);
};

/** No panel is docked above the column's composer any more. */
export const withdrawFloatingPanelClearance = (column: HTMLElement): void => {
    floatingPanelClearance.withdraw(column);
};
