export const createProjectIdFromPath = (projectPath: string): string => {
  const normalized = projectPath.replace(/\\/g, '/').replace(/\/+$/g, '').trim();
  if (!normalized) {
    return '';
  }

  const data = new TextEncoder().encode(normalized);
  let binary = '';
  for (const byte of data) {
    binary += String.fromCharCode(byte);
  }

  const encoded = typeof btoa === 'function'
    ? btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
    : normalized.replace(/[^A-Za-z0-9._-]+/g, '_');

  return `path_${encoded}`;
};

/**
 * The checkout path a `path_` id was made from, or '' when the id does not
 * name one. The server and the VS Code host derive the same id; all three
 * must agree on the encoding.
 */
export const projectPathFromId = (projectId: string): string => {
  if (!projectId.startsWith('path_')) {
    return '';
  }

  const encoded = projectId.slice('path_'.length);
  if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    return '';
  }

  try {
    const binary = atob(encoded.replace(/-/g, '+').replace(/_/g, '/'));
    return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
  } catch {
    return '';
  }
};
