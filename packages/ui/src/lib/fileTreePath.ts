export const normalizeFileTreePath = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) return '';

  const withForwardSlashes = trimmed.replace(/\\/g, '/');
  const hadUncPrefix = withForwardSlashes.startsWith('//');
  let normalized = withForwardSlashes.replace(/\/+/g, '/');
  if (hadUncPrefix && !normalized.startsWith('//')) {
    normalized = `/${normalized}`;
  }
  if (normalized === '/' || /^[A-Za-z]:\/$/.test(normalized)) {
    return normalized;
  }
  return normalized.replace(/\/+$/, '');
};

export const getFileTreePathIdentity = (value: string): string => {
  const normalized = normalizeFileTreePath(value);
  if (/^[A-Za-z]:\//.test(normalized) || normalized.startsWith('//')) {
    return normalized.toLowerCase();
  }
  return normalized;
};

export const isFileTreePathWithinRoot = (value: string, root: string): boolean => {
  const pathKey = getFileTreePathIdentity(value);
  const rootKey = getFileTreePathIdentity(root);
  if (!pathKey || !rootKey) return false;
  if (pathKey === rootKey) return true;
  if (rootKey === '/' || /^[a-z]:\/$/.test(rootKey)) {
    return pathKey.startsWith(rootKey);
  }
  return pathKey.startsWith(`${rootKey}/`);
};

export const getFileTreeRelativePath = (value: string, root: string): string | null => {
  const normalizedPath = normalizeFileTreePath(value);
  const normalizedRoot = normalizeFileTreePath(root);
  if (!isFileTreePathWithinRoot(normalizedPath, normalizedRoot)) return null;
  if (getFileTreePathIdentity(normalizedPath) === getFileTreePathIdentity(normalizedRoot)) {
    return '';
  }
  return normalizedPath.slice(normalizedRoot.length).replace(/^\/+/, '');
};
