/**
 * A saved file as a Markdown image destination. A Windows path becomes a
 * `file:` URL, since Markdown reads `C:` as a scheme; angle brackets keep a
 * path with spaces one destination. Markdown percent-encodes what it must,
 * and the image grant route compares the decoded path.
 */
export const generatedImageDestination = (path: string): string => {
    const windows = /^[A-Za-z]:[\\/]/.test(path);
    const destination = windows ? `file:///${path.replace(/\\/g, '/')}` : path;
    return `![](<${destination}>)`;
};
