import {
  buildVSCodeThemeFromPalette,
  readVSCodeThemePalette,
  type VSCodeThemeKind,
  type VSCodeThemePalette,
  type VSCodeThemePayload,
} from '@openchamber/ui/lib/theme/vscode/adapter';

const MAX_BOOTSTRAP_FRAMES = 180;

const applyInitialTheme = (theme: { metadata?: { variant?: string }; colors?: { surface?: { background?: string; foreground?: string } } }) => {
  if (typeof document === 'undefined' || !theme) return;
  const variant = theme.metadata?.variant === 'dark' ? 'dark' : 'light';
  const root = document.documentElement;
  root.classList.remove('light', 'dark');
  root.classList.add(variant);

  const background = theme.colors?.surface?.background;
  if (background) {
    document.body.style.backgroundColor = background;
    let meta = document.querySelector('meta[name="theme-color"]') as HTMLMetaElement | null;
    if (!meta) {
      meta = document.createElement('meta');
      meta.setAttribute('name', 'theme-color');
      document.head.appendChild(meta);
    }
    meta.setAttribute('content', background);
  }
};

const publishVSCodeTheme = (palette: VSCodeThemePalette) => {
  const theme = buildVSCodeThemeFromPalette(palette);
  window.__OPENCHAMBER_VSCODE_THEME__ = theme;
  applyInitialTheme(theme);
  window.dispatchEvent(new CustomEvent<VSCodeThemePayload>('openchamber:vscode-theme', {
    detail: { theme, palette },
  }));
};

const hasEditorColors = (palette: VSCodeThemePalette | null): palette is VSCodeThemePalette => {
  if (palette === null) return false;
  const { colors } = palette;
  const canvas = colors['chat.list.background'] ?? colors['editor.background'];
  const text = colors['interactive-session.foreground'] ?? colors.foreground ?? colors['editor.foreground'];
  return Boolean(canvas && text);
};

const readAndPublish = (preferredKind?: VSCodeThemeKind): VSCodeThemePalette | null => {
  const palette = readVSCodeThemePalette(preferredKind);
  if (palette) {
    publishVSCodeTheme(palette);
  }
  return palette;
};

export const emitVSCodeTheme = (preferredKind?: VSCodeThemeKind): void => {
  readAndPublish(preferredKind);
};

export const startVSCodeThemeBootstrap = (
  kind: () => VSCodeThemeKind | undefined,
  options: { schedule?: (callback: () => void) => number } = {},
): void => {
  const schedule = options.schedule ?? ((callback: () => void) => requestAnimationFrame(callback));

  if (hasEditorColors(readAndPublish(kind()))) {
    return;
  }

  let frame = 0;
  const retry = () => {
    frame += 1;
    const palette = readVSCodeThemePalette(kind());
    if (hasEditorColors(palette)) {
      publishVSCodeTheme(palette);
      return;
    }
    if (frame < MAX_BOOTSTRAP_FRAMES) {
      schedule(retry);
    }
  };
  schedule(retry);
};
