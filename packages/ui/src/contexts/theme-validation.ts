import type { Theme } from '@/types/theme';

const getNested = (value: unknown, path: string[]): unknown =>
  path.reduce<unknown>((acc, key) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[key] : undefined), value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

export const isValidTheme = (value: unknown): value is Theme => {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const requiredPaths = [
    ['metadata', 'id'],
    ['metadata', 'name'],
    ['metadata', 'variant'],
    ['colors', 'primary', 'base'],
    ['colors', 'primary', 'foreground'],
    ['colors', 'surface', 'background'],
    ['colors', 'surface', 'foreground'],
    ['colors', 'surface', 'muted'],
    ['colors', 'surface', 'mutedForeground'],
    ['colors', 'surface', 'elevated'],
    ['colors', 'surface', 'elevatedForeground'],
    ['colors', 'surface', 'subtle'],
    ['colors', 'interactive', 'border'],
    ['colors', 'interactive', 'selection'],
    ['colors', 'interactive', 'selectionForeground'],
    ['colors', 'interactive', 'focusRing'],
    ['colors', 'interactive', 'hover'],
    ['colors', 'status', 'error'],
    ['colors', 'status', 'errorForeground'],
    ['colors', 'status', 'errorBackground'],
    ['colors', 'status', 'errorBorder'],
    ['colors', 'status', 'warning'],
    ['colors', 'status', 'warningForeground'],
    ['colors', 'status', 'warningBackground'],
    ['colors', 'status', 'warningBorder'],
    ['colors', 'status', 'success'],
    ['colors', 'status', 'successForeground'],
    ['colors', 'status', 'successBackground'],
    ['colors', 'status', 'successBorder'],
    ['colors', 'status', 'info'],
    ['colors', 'status', 'infoForeground'],
    ['colors', 'status', 'infoBackground'],
    ['colors', 'status', 'infoBorder'],
    ['colors', 'syntax', 'base', 'background'],
    ['colors', 'syntax', 'base', 'foreground'],
    ['colors', 'syntax', 'base', 'keyword'],
    ['colors', 'syntax', 'base', 'string'],
    ['colors', 'syntax', 'base', 'number'],
    ['colors', 'syntax', 'base', 'function'],
    ['colors', 'syntax', 'base', 'variable'],
    ['colors', 'syntax', 'base', 'type'],
    ['colors', 'syntax', 'base', 'comment'],
    ['colors', 'syntax', 'base', 'operator'],
    ['colors', 'syntax', 'highlights', 'diffAdded'],
    ['colors', 'syntax', 'highlights', 'diffRemoved'],
    ['colors', 'syntax', 'highlights', 'lineNumber'],
  ];

  for (const path of requiredPaths) {
    if (!isNonEmptyString(getNested(value, path))) {
      return false;
    }
  }

  const variant = getNested(value, ['metadata', 'variant']);
  return variant === 'light' || variant === 'dark';
};
