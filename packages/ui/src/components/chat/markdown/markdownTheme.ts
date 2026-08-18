import { registerCustomTheme, type ThemeRegistrationResolved } from '@pierre/diffs';
import { MARKDOWN_SHIKI_THEME, MARKDOWN_SHIKI_THEME_DEFINITION } from './markdownShikiThemeDefinition';

// The static Shiki theme name. Its definition (token colors referencing
// `--md-syntax-*` CSS variables) lives in the dependency-free
// `markdownShikiThemeDefinition` module so it can also be imported inside the
// Shiki Web Worker. See that module for the rationale.


let registered = false;

/**
 * Register the static, CSS-variable-driven Shiki theme with `@pierre/diffs`.
 * Safe to call multiple times; only the first call registers.
 *
 * NOTE: markdown code highlighting now runs through the dedicated Shiki worker
 * (`markdown-worker`), which uses the raw theme definition directly. This
 * registration remains only for any `@pierre/diffs`-based consumer of the
 * `openchamber-md` theme name.
 */
export const ensureMarkdownShikiTheme = (): void => {
  if (registered) return;
  registered = true;

  registerCustomTheme(MARKDOWN_SHIKI_THEME, () =>
    Promise.resolve(MARKDOWN_SHIKI_THEME_DEFINITION as unknown as ThemeRegistrationResolved),
  );
};
