export const MESSAGE_IMAGE_EXPORT_EXCLUDE_ATTRIBUTE = 'data-message-image-export-exclude';

export const cloneMessageImageExportSource = (source: HTMLElement): HTMLElement => {
    // SAFETY: cloneNode preserves the concrete type of an HTMLElement source.
    const clone = source.cloneNode(true) as HTMLElement;
    clone.querySelectorAll(`[${MESSAGE_IMAGE_EXPORT_EXCLUDE_ATTRIBUTE}="true"], [data-export-ignore]`).forEach((element) => {
        element.remove();
    });
    return clone;
};

/** Renders every text part, including folded and unmounted earlier messages. */
export const buildTurnImageExportSource = async (
    segments: readonly string[],
    syntaxStyle: string | null,
): Promise<HTMLElement> => {
    const { renderMarkdownForExport } = await import('../markdown/renderMarkdownForExport');
    const source = document.createElement('div');
    for (const text of segments) {
        const markdown = await renderMarkdownForExport(text, { purpose: 'image', syntaxStyle });
        const segment = document.createElement('div');
        segment.className = 'relative break-words my-1';
        segment.appendChild(markdown);
        source.appendChild(segment);
    }
    return source;
};
