export const generatedImageDestination = (path: string): string => {
    const windows = /^[A-Za-z]:[\\/]/.test(path);
    const destination = windows ? `file:///${path.replace(/\\/g, '/')}` : path;
    return `![](<${destination}>)`;
};
