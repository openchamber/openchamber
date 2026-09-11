export const MESSAGE_IMAGE_EXPORT_EXCLUDE_ATTRIBUTE = 'data-message-image-export-exclude';

export const cloneMessageImageExportSource = (source: HTMLElement): HTMLElement => {
    // SAFETY: cloneNode preserves the concrete type of an HTMLElement source.
    const clone = source.cloneNode(true) as HTMLElement;
    clone.querySelectorAll(`[${MESSAGE_IMAGE_EXPORT_EXCLUDE_ATTRIBUTE}="true"]`).forEach((element) => {
        element.remove();
    });
    return clone;
};
