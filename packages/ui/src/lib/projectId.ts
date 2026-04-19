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
