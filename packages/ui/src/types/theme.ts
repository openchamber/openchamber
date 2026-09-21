

interface ThemeMetadata {
  id: string;
  name: string;
  description: string;
  author?: string;
  version: string;
  variant: 'light' | 'dark';
  tags: string[];
}

export type ThemeMode = 'system' | 'light' | 'dark';

interface ThemeColor {
  base: string;
  hover?: string;
  active?: string;
  foreground?: string;
  muted?: string;
}

interface SurfaceColors {
  background: string;
  foreground: string;
  muted: string;
  mutedForeground: string;
  elevated: string;
  elevatedForeground: string;
  overlay: string;
  subtle: string;
}

interface InteractiveColors {
  border: string;
  borderHover: string;
  borderFocus: string;
  selection: string;
  selectionForeground: string;
  focus: string;
  focusRing: string;
  cursor: string;
  hover: string;
  active: string;
}

interface StatusColors {
  error: string;
  errorForeground: string;
  errorBackground: string;
  errorBorder: string;

  warning: string;
  warningForeground: string;
  warningBackground: string;
  warningBorder: string;

  success: string;
  successForeground: string;
  successBackground: string;
  successBorder: string;

  info: string;
  infoForeground: string;
  infoBackground: string;
  infoBorder: string;
}

interface PullRequestColors {
  open: string;
  draft: string;
  blocked: string;
  merged: string;
  closed: string;
}

interface SyntaxBaseColors {
  background: string;
  foreground: string;
  comment: string;
  keyword: string;
  string: string;
  number: string;
  function: string;
  variable: string;
  type: string;
  operator: string;
}

interface SyntaxColors {
  base: SyntaxBaseColors;
  tokens?: Record<string, string>;
  highlights?: Record<string, string>;
}

export interface Theme {
  metadata: ThemeMetadata;

  colors: {

    primary: ThemeColor;
    surface: SurfaceColors;
    interactive: InteractiveColors;
    status: StatusColors;
    pr?: PullRequestColors;

    syntax: SyntaxColors;

    chat?: Record<string, string>;
    markdown?: Record<string, string>;
    tools?: {
      border?: string;
      icon?: string;
      title?: string;
      description?: string;
      edit?: Record<string, string>;
    };
  };

  config?: {
    fonts?: {
      sans?: string;
      mono?: string;
      heading?: string;
    };
    transitions?: {
      fast?: string;
      normal?: string;
      slow?: string;
    };
  };
}
