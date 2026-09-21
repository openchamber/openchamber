const isReservedRuntimeRequestHeaderName = (name) => {
  return String(name || '').trim().toLowerCase() === 'authorization';
};

export const sanitizeRuntimeRequestHeaders = (headers) => {
  if (!headers || typeof headers !== 'object') return {};
  const next = {};
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = typeof rawName === 'string' ? rawName.trim() : '';
    const value = typeof rawValue === 'string' ? rawValue.trim() : '';
    if (!name || !value || /[\r\n:]/.test(name) || /[\r\n]/.test(value)) continue;
    if (isReservedRuntimeRequestHeaderName(name)) continue;
    next[name] = value;
  }
  return next;
};
