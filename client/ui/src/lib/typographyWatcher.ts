import { SEMANTIC_TYPOGRAPHY } from '@/lib/typography';

let started = false;

const TYPOGRAPHY_STYLE_ID = 'openchamber-typography-base';

const applySemanticTypography = (): void => {
  if (typeof document === 'undefined') {
    return;
  }

  const cssVars = Object.entries(SEMANTIC_TYPOGRAPHY)
    .map(([key, value]) => `  --text-${key.replace(/([A-Z])/g, '-$1').toLowerCase()}: ${value};`)
    .join('\n');

  const styleContent = `:root {\n${cssVars}\n}\n`;

  const existing = document.getElementById(TYPOGRAPHY_STYLE_ID);
  if (existing) {
    existing.textContent = styleContent;
    return;
  }

  const style = document.createElement('style');
  style.id = TYPOGRAPHY_STYLE_ID;
  style.textContent = styleContent;
  document.head.appendChild(style);
};

export const startTypographyWatcher = (): void => {
  if (started || typeof window === 'undefined') {
    return;
  }
  started = true;

  applySemanticTypography();
};
