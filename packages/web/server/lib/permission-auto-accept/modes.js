export const PERMISSION_MODES = ['ask', 'safety', 'auto'];

export const isPermissionMode = (value) => PERMISSION_MODES.includes(value);

export const toPermissionMode = (value, legacyEnabledMode = 'auto') => {
  if (isPermissionMode(value)) return value;
  if (value === true) return legacyEnabledMode;
  if (value === false) return 'ask';
  return null;
};

export const isAutoAnsweringMode = (mode) => mode === 'safety' || mode === 'auto';
