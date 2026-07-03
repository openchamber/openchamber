

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
  emphasis?: string;
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
  tokens?: Partial<Record<string, string>>;
  languages?: Record<string, Record<string, string>>;
  highlights?: Record<string, string>;
}

interface ButtonVariant {
  bg?: string;
  fg?: string;
  border?: string;
  hover?: string;
  active?: string;
  disabled?: string;
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

    header?: Record<string, string>;
    sidebar?: Record<string, string>;
    chat?: Record<string, string>;
    markdown?: Record<string, string>;
    tools?: {
      background?: string;
      border?: string;
      headerHover?: string;
      icon?: string;
      title?: string;
      description?: string;
      edit?: Record<string, string>;
      bash?: Record<string, string>;
      lsp?: Record<string, string>;
    };
    forms?: Record<string, string>;
    buttons?: {
      primary?: ButtonVariant;
      secondary?: ButtonVariant;
      ghost?: ButtonVariant;
      destructive?: ButtonVariant;
    };
    modal?: Record<string, string>;
    popover?: Record<string, string>;
    commandPalette?: Record<string, string>;
    fileAttachment?: Record<string, string>;
    sessions?: Record<string, string>;
    modelSelector?: Record<string, string>;
    permissions?: Record<string, string>;
    loading?: Record<string, string>;
    scrollbar?: Record<string, string>;
    badges?: Record<string, ButtonVariant>;
    toast?: Record<string, string | Record<string, string>>;
    emptyState?: Record<string, string>;
    table?: Record<string, string>;
    charts?: Record<string, string | string[]>;
    a11y?: Record<string, string | boolean>;
    shadows?: Record<string, string>;
    animation?: Record<string, string>;
  };

  config?: {
    fonts?: {
      sans?: string;
      mono?: string;
      heading?: string;
    };
    spacing?: {
      xs?: string;
      sm?: string;
      md?: string;
      lg?: string;
      xl?: string;
    };
    transitions?: {
      fast?: string;
      normal?: string;
      slow?: string;
    };
  };
}
