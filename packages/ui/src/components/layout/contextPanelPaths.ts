export const getRelativePathLabel = (filePath: string | null, directory: string): string => {
  if (!filePath) return '';
  const file = filePath.replace(/\\/g, '/');
  const root = directory.replace(/\\/g, '/').replace(/\/+$/, '');
  const prefix = root ? `${root}/` : directory.startsWith('/') ? '/' : '';
  const insensitive = /^[a-z]:\//i.test(file) || file.startsWith('//');
  const matches = insensitive
    ? file.toLowerCase().startsWith(prefix.toLowerCase())
    : file.startsWith(prefix);
  return prefix && matches ? file.slice(prefix.length) : file;
};
