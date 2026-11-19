export const PERMISSION_MODES: ['ask', 'safety', 'auto'] = ['ask', 'safety', 'auto'];

export type PermissionMode = (typeof PERMISSION_MODES)[number];

export const isPermissionMode = (value: unknown): value is PermissionMode => PERMISSION_MODES.some((mode) => mode === value);

export const toPermissionMode = (value: PermissionMode | boolean | null | undefined, legacyEnabledMode: PermissionMode = 'auto') => {
  if (isPermissionMode(value)) return value;
  if (value === true) return legacyEnabledMode;
  if (value === false) return 'ask';
  return null;
};

export const isAutoAnsweringMode = (mode: PermissionMode | null | undefined) => mode === 'safety' || mode === 'auto';
