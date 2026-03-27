import type { Theme } from '@/types/theme';
import { SEMANTIC_TYPOGRAPHY, VSCODE_TYPOGRAPHY } from '@/lib/typography';
import { isVSCodeRuntime } from '@/lib/desktop';

const hexToRgb = (value: string | undefined | null): string | null => {
  if (!value || typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim();
  if (!normalized.startsWith('#')) {
    return null;
  }
  let hex = normalized.slice(1);
  if (hex.length === 3 || hex.length === 4) {
    hex = hex
      .split('')
      .map((char) => char + char)
      .join('');
  }
  if (hex.length === 8) {
    hex = hex.slice(0, 6);
  }
  if (hex.length !== 6) {
    return null;
  }
  const int = Number.parseInt(hex, 16);
  if (Number.isNaN(int)) {
    return null;
  }
  const r = (int >> 16) & 255;
  const g = (int >> 8) & 255;
  const b = int & 255;
  return `${r} ${g} ${b}`;
};

export class CSSVariableGenerator {
  private inheritanceMap: Map<string, string> = new Map();

  constructor() {
    this.initializeInheritanceMap();
  }

  generate(theme: Theme): string {
    const cssVars: string[] = [];

    cssVars.push(...this.generateTailwindVariables(theme));

    cssVars.push(...this.generatePrimaryColors(theme.colors.primary));
    cssVars.push(...this.generateSurfaceColors(theme.colors.surface));
    cssVars.push(...this.generateInteractiveColors(theme.colors.interactive));
    cssVars.push(...this.generateStatusColors(theme.colors.status));
    cssVars.push(...this.generatePullRequestColors(theme));

    cssVars.push(...this.generateSyntaxColors(theme.colors.syntax));

    cssVars.push(...this.generateComponentColors(theme.colors, theme));

    cssVars.push(...this.generateTypographyVariables());

    if (theme.config) {
      cssVars.push(...this.generateConfigVariables(theme.config));
    }

    return cssVars.join('\n');
  }

  private generateTailwindVariables(theme: Theme): string[] {
    const vars: string[] = [];

    vars.push(`  --background: ${theme.colors.surface.background} !important;`);
    vars.push(`  --foreground: ${theme.colors.surface.foreground} !important;`);

    vars.push(`  --muted: ${theme.colors.surface.muted} !important;`);
    vars.push(`  --muted-foreground: ${theme.colors.surface.mutedForeground} !important;`);

    vars.push(`  --card: ${theme.colors.surface.elevated} !important;`);
    vars.push(`  --card-foreground: ${theme.colors.surface.elevatedForeground} !important;`);

    vars.push(`  --popover: ${theme.colors.surface.elevated} !important;`);
    vars.push(`  --popover-foreground: ${theme.colors.surface.elevatedForeground} !important;`);

    vars.push(`  --border: ${theme.colors.interactive.border} !important;`);
    vars.push(`  --input: ${theme.colors.interactive.border} !important;`);

    vars.push(`  --primary: ${theme.colors.primary.base} !important;`);
    vars.push(`  --primary-foreground: ${theme.colors.primary.foreground} !important;`);

    vars.push(`  --secondary: ${theme.colors.surface.muted} !important;`);
    vars.push(`  --secondary-foreground: ${theme.colors.surface.mutedForeground} !important;`);

    vars.push(`  --accent: ${theme.colors.surface.subtle} !important;`);
    vars.push(`  --accent-foreground: ${theme.colors.surface.foreground} !important;`);

    vars.push(`  --destructive: ${theme.colors.status.error} !important;`);
    vars.push(`  --destructive-foreground: ${theme.colors.status.errorForeground} !important;`);

    vars.push(`  --ring: ${theme.colors.interactive.focusRing} !important;`);

    if (theme.config?.radius?.md) {
      vars.push(`  --radius: ${theme.config.radius.md} !important;`);
    }

    const sidebarBaseRgb = hexToRgb(theme.colors.surface.muted);
    const sidebarAccentRgb = hexToRgb(theme.colors.surface.subtle);
    const sidebarBorderRgb = hexToRgb(theme.colors.interactive.border);

    vars.push(`  --sidebar-base: ${theme.colors.surface.muted} !important;`);
    if (sidebarBaseRgb) {
      vars.push(`  --sidebar-base-rgb: ${sidebarBaseRgb} !important;`);
    }
    vars.push(`  --sidebar: var(--sidebar-base) !important;`);
    vars.push(`  --sidebar-foreground: ${theme.colors.surface.mutedForeground} !important;`);
    vars.push(`  --sidebar-primary: ${theme.colors.primary.base} !important;`);
    vars.push(`  --sidebar-primary-foreground: ${theme.colors.primary.foreground} !important;`);
    vars.push(`  --sidebar-accent-base: ${theme.colors.surface.subtle} !important;`);
    if (sidebarAccentRgb) {
      vars.push(`  --sidebar-accent-base-rgb: ${sidebarAccentRgb} !important;`);
    }
    vars.push(`  --sidebar-accent: var(--sidebar-accent-base) !important;`);
    vars.push(`  --sidebar-accent-foreground: ${theme.colors.surface.foreground} !important;`);
    vars.push(`  --sidebar-border: ${theme.colors.interactive.border} !important;`);
    if (sidebarBorderRgb) {
      vars.push(`  --sidebar-border-rgb: ${sidebarBorderRgb} !important;`);
    }
    vars.push(`  --sidebar-ring: ${theme.colors.interactive.focusRing} !important;`);

    const isDark = theme.metadata.variant === 'dark';
    const strongAlpha = isDark ? 0.35 : 0.75;
    const softAlpha = isDark ? 0.2 : 0.6;

    if (sidebarBaseRgb) {
      vars.push(
        `  --sidebar-overlay-strong: rgb(${sidebarBaseRgb} / ${strongAlpha}) !important;`,
      );
      vars.push(
        `  --sidebar-overlay-soft: rgb(${sidebarBaseRgb} / ${softAlpha}) !important;`,
      );
    } else {
      const base = theme.colors.surface.muted;
      vars.push(
        `  --sidebar-overlay-strong: ${this.opacity(base, strongAlpha)} !important;`,
      );
      vars.push(
        `  --sidebar-overlay-soft: ${this.opacity(base, softAlpha)} !important;`,
      );
    }

    if (theme.colors.charts?.series && Array.isArray(theme.colors.charts.series)) {
      theme.colors.charts.series.forEach((color: string, i: number) => {
        vars.push(`  --chart-${i + 1}: ${color};`);
      });
    }

    if (theme.colors.loading) {
      vars.push(`  --loading-spinner: ${theme.colors.loading.spinner || theme.colors.primary.base};`);
      vars.push(`  --loading-spinner-track: ${theme.colors.loading.spinnerTrack || theme.colors.surface.muted};`);
    } else {
      vars.push(`  --loading-spinner: ${theme.colors.primary.base};`);
      vars.push(`  --loading-spinner-track: ${theme.colors.surface.muted};`);
    }

    return vars;
  }

  apply(theme: Theme): void {
    const cssVars = this.generate(theme);
    const style = document.createElement('style');
    style.id = 'opencode-theme-variables';

    let styleContent = '';
    if (theme.metadata.variant === 'dark') {

      styleContent = `:root {\n${cssVars}\n}\n\n.dark {\n${cssVars}\n}`;
      document.documentElement.classList.add('dark');
      document.documentElement.classList.remove('light');
    } else {

      styleContent = `:root {\n${cssVars}\n}\n\n:root:not(.dark) {\n${cssVars}\n}`;
      document.documentElement.classList.remove('dark');
      document.documentElement.classList.add('light');
    }

    style.textContent = styleContent;

    const existing = document.getElementById('opencode-theme-variables');
    if (existing) {
      existing.remove();
    }

    document.head.appendChild(style);

    document.documentElement.setAttribute('data-theme', theme.metadata.variant);
  }

  private generatePrimaryColors(primary: Theme['colors']['primary']): string[] {
    const vars: string[] = [];
    vars.push(`  --primary-base: ${primary.base};`);
    vars.push(`  --primary-hover: ${primary.hover || this.darken(primary.base, 10)};`);
    vars.push(`  --primary-active: ${primary.active || this.darken(primary.base, 20)};`);
    vars.push(`  --primary-foreground: ${primary.foreground || '#ffffff'};`);
    vars.push(`  --primary-muted: ${primary.muted || this.opacity(primary.base, 0.5)};`);
    vars.push(`  --primary-emphasis: ${primary.emphasis || this.lighten(primary.base, 10)};`);
    return vars;
  }

  private generateSurfaceColors(surface: Theme['colors']['surface']): string[] {
    const vars: string[] = [];
    vars.push(`  --surface-background: ${surface.background};`);
    vars.push(`  --surface-foreground: ${surface.foreground};`);
    vars.push(`  --surface-muted: ${surface.muted};`);
    vars.push(`  --surface-muted-foreground: ${surface.mutedForeground};`);
    vars.push(`  --surface-elevated: ${surface.elevated};`);
    vars.push(`  --surface-elevated-foreground: ${surface.elevatedForeground};`);
    vars.push(`  --surface-overlay: ${surface.overlay};`);
    vars.push(`  --surface-subtle: ${surface.subtle};`);
    return vars;
  }

  private generateInteractiveColors(interactive: Theme['colors']['interactive']): string[] {
    const vars: string[] = [];
    vars.push(`  --interactive-border: ${interactive.border};`);
    vars.push(`  --interactive-border-hover: ${interactive.borderHover};`);
    vars.push(`  --interactive-border-focus: ${interactive.borderFocus};`);
    vars.push(`  --interactive-selection: ${interactive.selection};`);
    vars.push(`  --interactive-selection-foreground: ${interactive.selectionForeground};`);
    vars.push(`  --interactive-focus: ${interactive.focus};`);
    vars.push(`  --interactive-focus-ring: ${interactive.focusRing};`);
    vars.push(`  --interactive-cursor: ${interactive.cursor};`);
    vars.push(`  --interactive-hover: ${interactive.hover};`);
    vars.push(`  --interactive-active: ${interactive.active};`);
    return vars;
  }

  private generateStatusColors(status: Theme['colors']['status']): string[] {
    const vars: string[] = [];

    vars.push(`  --status-error: ${status.error};`);
    vars.push(`  --status-error-foreground: ${status.errorForeground};`);
    vars.push(`  --status-error-background: ${status.errorBackground};`);
    vars.push(`  --status-error-border: ${status.errorBorder};`);

    vars.push(`  --status-warning: ${status.warning};`);
    vars.push(`  --status-warning-foreground: ${status.warningForeground};`);
    vars.push(`  --status-warning-background: ${status.warningBackground};`);
    vars.push(`  --status-warning-border: ${status.warningBorder};`);

    vars.push(`  --status-success: ${status.success};`);
    vars.push(`  --status-success-foreground: ${status.successForeground};`);
    vars.push(`  --status-success-background: ${status.successBackground};`);
    vars.push(`  --status-success-border: ${status.successBorder};`);

    vars.push(`  --status-info: ${status.info};`);
    vars.push(`  --status-info-foreground: ${status.infoForeground};`);
    vars.push(`  --status-info-background: ${status.infoBackground};`);
    vars.push(`  --status-info-border: ${status.infoBorder};`);

    return vars;
  }

  private generatePullRequestColors(theme: Theme): string[] {
    const vars: string[] = [];
    const pr = theme.colors.pr;
    vars.push(`  --pr-open: ${pr?.open || theme.colors.status.success};`);
    vars.push(`  --pr-draft: ${pr?.draft || theme.colors.surface.mutedForeground};`);
    vars.push(`  --pr-blocked: ${pr?.blocked || theme.colors.status.warning};`);
    vars.push(`  --pr-merged: ${pr?.merged || (theme.metadata.variant === 'dark' ? '#8957e5' : '#8250df')};`);
    vars.push(`  --pr-closed: ${pr?.closed || theme.colors.status.error};`);
    return vars;
  }

  private generateSyntaxColors(syntax: Theme['colors']['syntax']): string[] {
    const vars: string[] = [];

    vars.push(`  --syntax-background: ${syntax.base.background};`);
    vars.push(`  --syntax-foreground: ${syntax.base.foreground};`);
    vars.push(`  --syntax-comment: ${syntax.base.comment};`);
    vars.push(`  --syntax-keyword: ${syntax.base.keyword};`);
    vars.push(`  --syntax-string: ${syntax.base.string};`);
    vars.push(`  --syntax-number: ${syntax.base.number};`);
    vars.push(`  --syntax-function: ${syntax.base.function};`);
    vars.push(`  --syntax-variable: ${syntax.base.variable};`);
    vars.push(`  --syntax-type: ${syntax.base.type};`);
    vars.push(`  --syntax-operator: ${syntax.base.operator};`);

    const tokens = this.generateSyntaxTokens(syntax);
    for (const [key, value] of Object.entries(tokens)) {
      vars.push(`  --syntax-${this.kebabCase(key)}: ${value};`);
    }

    return vars;
  }

  private generateSyntaxTokens(syntax: Theme['colors']['syntax']): Record<string, string> {
    const base = syntax.base;
    const tokens = syntax.tokens || {};

    return {

      commentDoc: tokens.commentDoc || this.lighten(base.comment, 10),

      stringEscape: tokens.stringEscape || this.darken(base.string, 20),
      stringInterpolation: tokens.stringInterpolation || base.variable,
      stringRegex: tokens.stringRegex || this.adjustHue(base.string, 15),

      keywordControl: tokens.keywordControl || base.keyword,
      keywordOperator: tokens.keywordOperator || base.operator,
      keywordImport: tokens.keywordImport || this.lighten(base.keyword, 10),
      keywordReturn: tokens.keywordReturn || this.emphasize(base.keyword),

      functionCall: tokens.functionCall || this.lighten(base.function, 5),
      functionBuiltin: tokens.functionBuiltin || this.darken(base.function, 10),
      method: tokens.method || base.function,
      methodCall: tokens.methodCall || this.lighten(base.function, 5),

      variableBuiltin: tokens.variableBuiltin || this.emphasize(base.variable),
      variableProperty: tokens.variableProperty || this.lighten(base.variable, 10),
      variableReadonly: tokens.variableReadonly || base.number,
      parameter: tokens.parameter || base.variable,

      typePrimitive: tokens.typePrimitive || this.darken(base.type, 10),
      typeInterface: tokens.typeInterface || base.type,
      className: tokens.className || this.emphasize(base.type),
      enum: tokens.enum || base.type,

      boolean: tokens.boolean || base.number,
      null: tokens.null || this.opacity(base.number, 0.7),
      constant: tokens.constant || base.number,

      punctuation: tokens.punctuation || this.opacity(base.foreground, 0.7),
      delimiter: tokens.delimiter || this.opacity(base.foreground, 0.8),
      bracket: tokens.bracket || base.foreground,

      tag: tokens.tag || base.keyword,
      tagAttribute: tokens.tagAttribute || base.variable,
      tagAttributeValue: tokens.tagAttributeValue || base.string,
      tagBracket: tokens.tagBracket || this.opacity(base.foreground, 0.8),

      decorator: tokens.decorator || base.function,
      annotation: tokens.annotation || base.function,

      namespace: tokens.namespace || this.opacity(base.type, 0.8),
      module: tokens.module || this.opacity(base.type, 0.8),

      ...tokens
    };
  }

  private generateComponentColors(colors: Theme['colors'], theme: Theme): string[] {
    const vars: string[] = [];

    if (colors.markdown) {
      vars.push(...this.generateMarkdownColors(colors.markdown, theme));
    } else {

      vars.push(...this.generateDefaultMarkdownColors(theme));
    }

    if (colors.chat) {
      vars.push(...this.generateChatColors(colors.chat, theme));
    } else {
      vars.push(...this.generateDefaultChatColors(theme));
    }

    if (colors.tools) {
      vars.push(...this.generateToolColors(colors.tools, theme));
    } else {
      vars.push(...this.generateDefaultToolColors(theme));
    }

    return vars;
  }

  private generateMarkdownColors(markdown: Record<string, string>, theme: Theme): string[] {
    const vars: string[] = [];
    const primary = theme.colors.primary.base;
    const chatBackground = theme.colors.chat?.background || theme.colors.surface.background;

    vars.push(`  --markdown-heading1: ${markdown.heading1 || primary};`);
    vars.push(`  --markdown-heading2: ${markdown.heading2 || this.opacity(primary, 0.9)};`);
    vars.push(`  --markdown-heading3: ${markdown.heading3 || this.opacity(primary, 0.8)};`);
    vars.push(`  --markdown-heading4: ${markdown.heading4 || theme.colors.surface.foreground};`);
    vars.push(`  --markdown-link: ${markdown.link || primary};`);
    vars.push(`  --markdown-link-hover: ${markdown.linkHover || theme.colors.primary.hover || this.darken(primary, 10)};`);
    vars.push(`  --markdown-inline-code: ${markdown.inlineCode || theme.colors.syntax.base.string};`);
    vars.push(`  --markdown-inline-code-bg: ${markdown.inlineCodeBackground || chatBackground};`);
    vars.push(`  --markdown-blockquote: ${markdown.blockquote || theme.colors.surface.mutedForeground};`);
    vars.push(`  --markdown-blockquote-border: ${markdown.blockquoteBorder || theme.colors.interactive.border};`);
    vars.push(`  --markdown-list-marker: ${markdown.listMarker || this.opacity(primary, 0.6)};`);
    vars.push(`  --markdown-bold: ${markdown.bold || theme.colors.surface.foreground};`);
    vars.push(`  --markdown-italic: ${markdown.italic || this.opacity(theme.colors.surface.foreground, 0.9)};`);
    vars.push(`  --markdown-strikethrough: ${markdown.strikethrough || theme.colors.surface.mutedForeground};`);
    vars.push(`  --markdown-hr: ${markdown.hr || theme.colors.interactive.border};`);

    return vars;
  }

  private generateDefaultMarkdownColors(theme: Theme): string[] {
    const vars: string[] = [];
    const primary = theme.colors.primary.base;
    const chatBackground = theme.colors.chat?.background || theme.colors.surface.background;

    vars.push(`  --markdown-heading1: ${primary};`);
    vars.push(`  --markdown-heading2: ${this.opacity(primary, 0.9)};`);
    vars.push(`  --markdown-heading3: ${this.opacity(primary, 0.8)};`);
    vars.push(`  --markdown-heading4: ${theme.colors.surface.foreground};`);
    vars.push(`  --markdown-link: ${primary};`);
    vars.push(`  --markdown-link-hover: ${theme.colors.primary.hover || this.darken(primary, 10)};`);
    vars.push(`  --markdown-inline-code: ${theme.colors.syntax.base.string};`);
    vars.push(`  --markdown-inline-code-bg: ${chatBackground};`);
    vars.push(`  --markdown-blockquote: ${theme.colors.surface.mutedForeground};`);
    vars.push(`  --markdown-blockquote-border: ${theme.colors.interactive.border};`);
    vars.push(`  --markdown-list-marker: ${this.opacity(primary, 0.6)};`);
    vars.push(`  --markdown-bold: ${theme.colors.surface.foreground};`);
    vars.push(`  --markdown-italic: ${this.opacity(theme.colors.surface.foreground, 0.9)};`);
    vars.push(`  --markdown-strikethrough: ${theme.colors.surface.mutedForeground};`);
    vars.push(`  --markdown-hr: ${theme.colors.interactive.border};`);

    return vars;
  }

  private generateChatColors(chat: Record<string, string>, theme: Theme): string[] {
    const vars: string[] = [];
    const chatBackground = chat.background || theme.colors.surface.background;

    vars.push(`  --chat-background: ${chatBackground};`);
    vars.push(`  --chat-user-message: ${chat.userMessage || theme.colors.surface.foreground};`);
    vars.push(`  --chat-user-message-bg: ${chat.userMessageBackground || theme.colors.surface.elevated};`);
    vars.push(`  --chat-assistant-message: ${chat.assistantMessage || theme.colors.surface.foreground};`);
    vars.push(`  --chat-assistant-message-bg: ${chat.assistantMessageBackground || theme.colors.surface.muted};`);
    vars.push(`  --chat-timestamp: ${chat.timestamp || theme.colors.surface.mutedForeground};`);
    vars.push(`  --chat-divider: ${chat.divider || theme.colors.interactive.border};`);
    vars.push(`  --chat-typing: ${chat.typing || theme.colors.surface.mutedForeground};`);

    return vars;
  }

  private generateDefaultChatColors(theme: Theme): string[] {
    const vars: string[] = [];

    vars.push(`  --chat-background: ${theme.colors.surface.background};`);
    vars.push(`  --chat-user-message: ${theme.colors.surface.foreground};`);
    vars.push(`  --chat-user-message-bg: ${theme.colors.surface.elevated};`);
    vars.push(`  --chat-assistant-message: ${theme.colors.surface.foreground};`);
    vars.push(`  --chat-assistant-message-bg: ${theme.colors.surface.muted};`);
    vars.push(`  --chat-timestamp: ${theme.colors.surface.mutedForeground};`);
    vars.push(`  --chat-divider: ${theme.colors.interactive.border};`);
    vars.push(`  --chat-typing: ${theme.colors.surface.mutedForeground};`);

    return vars;
  }

  private generateToolColors(tools: Theme['colors']['tools'], theme: Theme): string[] {
    const vars: string[] = [];

    vars.push(`  --tools-background: ${tools?.background || this.opacity(theme.colors.surface.muted, 0.2)};`);
    vars.push(`  --tools-border: ${tools?.border || this.opacity(theme.colors.interactive.border, 0.3)};`);
    vars.push(`  --tools-header-hover: ${tools?.headerHover || this.opacity(theme.colors.surface.muted, 0.3)};`);
    vars.push(`  --tools-icon: ${tools?.icon || theme.colors.surface.mutedForeground};`);
    vars.push(`  --tools-title: ${tools?.title || theme.colors.surface.foreground};`);
    vars.push(`  --tools-description: ${tools?.description || this.opacity(theme.colors.surface.mutedForeground, 0.6)};`);

    if (tools?.edit) {
      vars.push(`  --tools-edit-added: ${tools.edit.added || theme.colors.status.success};`);
      vars.push(`  --tools-edit-added-bg: ${tools.edit.addedBackground || theme.colors.status.successBackground};`);
      vars.push(`  --tools-edit-removed: ${tools.edit.removed || theme.colors.status.error};`);
      vars.push(`  --tools-edit-removed-bg: ${tools.edit.removedBackground || theme.colors.status.errorBackground};`);
      vars.push(`  --tools-edit-modified: ${tools.edit.modified || theme.colors.status.info};`);
      vars.push(`  --tools-edit-modified-bg: ${tools.edit.modifiedBackground || theme.colors.status.infoBackground};`);
      vars.push(`  --tools-edit-line-number: ${tools.edit.lineNumber || this.opacity(theme.colors.surface.mutedForeground, 0.6)};`);
    } else {
      vars.push(`  --tools-edit-added: ${theme.colors.status.success};`);
      vars.push(`  --tools-edit-added-bg: ${theme.colors.status.successBackground};`);
      vars.push(`  --tools-edit-removed: ${theme.colors.status.error};`);
      vars.push(`  --tools-edit-removed-bg: ${theme.colors.status.errorBackground};`);
      vars.push(`  --tools-edit-modified: ${theme.colors.status.info};`);
      vars.push(`  --tools-edit-modified-bg: ${theme.colors.status.infoBackground};`);
      vars.push(`  --tools-edit-line-number: ${this.opacity(theme.colors.surface.mutedForeground, 0.6)};`);
    }

    return vars;
  }

  private generateDefaultToolColors(theme: Theme): string[] {
    const vars: string[] = [];

    vars.push(`  --tools-background: ${this.opacity(theme.colors.surface.muted, 0.2)};`);
    vars.push(`  --tools-border: ${this.opacity(theme.colors.interactive.border, 0.3)};`);
    vars.push(`  --tools-header-hover: ${this.opacity(theme.colors.surface.muted, 0.3)};`);
    vars.push(`  --tools-icon: ${theme.colors.surface.mutedForeground};`);
    vars.push(`  --tools-title: ${theme.colors.surface.foreground};`);
    vars.push(`  --tools-description: ${this.opacity(theme.colors.surface.mutedForeground, 0.6)};`);

    vars.push(`  --tools-edit-added: ${theme.colors.status.success};`);
    vars.push(`  --tools-edit-added-bg: ${this.addTransparency(this.removeTransparency(theme.colors.status.successBackground), 0.15)};`);
    vars.push(`  --tools-edit-removed: ${theme.colors.status.error};`);
    vars.push(`  --tools-edit-removed-bg: ${this.addTransparency(this.removeTransparency(theme.colors.status.errorBackground), 0.15)};`);
    vars.push(`  --tools-edit-modified: ${theme.colors.status.info};`);
    vars.push(`  --tools-edit-modified-bg: ${this.addTransparency(this.removeTransparency(theme.colors.status.infoBackground), 0.15)};`);
    vars.push(`  --tools-edit-line-number: ${this.opacity(theme.colors.surface.mutedForeground, 0.6)};`);

    return vars;
  }

  private generateConfigVariables(config: Theme['config']): string[] {
    const vars: string[] = [];

    if (!config) return vars;

    if (config.fonts) {
      if (config.fonts.sans) {
        vars.push(`  --font-sans: ${config.fonts.sans};`);
        vars.push(`  --font-family-sans: ${config.fonts.sans};`);
      }
      if (config.fonts.mono) {
        vars.push(`  --font-mono: ${config.fonts.mono};`);
        vars.push(`  --font-family-mono: ${config.fonts.mono};`);
      }
      if (config.fonts.heading) vars.push(`  --font-heading: ${config.fonts.heading};`);
    }

    if (config.radius) {
      if (config.radius.none) vars.push(`  --radius-none: ${config.radius.none};`);
      if (config.radius.sm) vars.push(`  --radius-sm: ${config.radius.sm};`);
      if (config.radius.md) vars.push(`  --radius-md: ${config.radius.md};`);
      if (config.radius.lg) vars.push(`  --radius-lg: ${config.radius.lg};`);
      if (config.radius.xl) vars.push(`  --radius-xl: ${config.radius.xl};`);
      if (config.radius.full) vars.push(`  --radius-full: ${config.radius.full};`);
    }

    if (config.transitions) {
      if (config.transitions.fast) vars.push(`  --transition-fast: ${config.transitions.fast};`);
      if (config.transitions.normal) vars.push(`  --transition-normal: ${config.transitions.normal};`);
      if (config.transitions.slow) vars.push(`  --transition-slow: ${config.transitions.slow};`);
    }

    return vars;
  }

  private generateTypographyVariables(): string[] {
    const vars: string[] = [];
    const typography = isVSCodeRuntime() ? VSCODE_TYPOGRAPHY : SEMANTIC_TYPOGRAPHY;

    vars.push('  /* Semantic Typography Variables */');
    vars.push('  --ui-regular-font-weight: 400;');

    vars.push('  /* Markdown content - all markdown elements use same size */');
    vars.push(`  --text-markdown: ${typography.markdown};`);
    vars.push('  /* Code content - all code elements use same size */');
    vars.push(`  --text-code: ${typography.code};`);
    vars.push('  /* UI headers - dialog titles, panel headers */');
    vars.push(`  --text-ui-header: ${typography.uiHeader};`);
    vars.push('  /* UI labels - buttons, menus, navigation */');
    vars.push(`  --text-ui-label: ${typography.uiLabel};`);
    vars.push('  /* Metadata - timestamps, status, helper text */');
    vars.push(`  --text-meta: ${typography.meta};`);
    vars.push('  /* Micro text - badges, shortcuts, indicators */');
    vars.push(`  --text-micro: ${typography.micro};`);

     vars.push('  /* Heading line height and letter spacing */');
     vars.push('  --h1-line-height: 1.25rem;');
     vars.push('  --h2-line-height: 1.25rem;');
     vars.push('  --h3-line-height: 1.5rem;');
     vars.push('  --h4-line-height: 1.5rem;');
     vars.push('  --h5-line-height: 1.5rem;');
     vars.push('  --h6-line-height: 1.5rem;');
     vars.push('  --h1-letter-spacing: -0.025em;');
     vars.push('  --h2-letter-spacing: -0.02em;');
     vars.push('  --h3-letter-spacing: -0.015em;');
     vars.push('  --h4-letter-spacing: -0.01em;');
     vars.push('  --h5-letter-spacing: 0;');
     vars.push('  --h6-letter-spacing: 0.01em;');

    vars.push('  /* UI element line height and letter spacing */');
    vars.push('  --ui-button-line-height: 1.375rem;');
    vars.push('  --ui-button-letter-spacing: 0.02em;');
    vars.push('  --ui-button-font-weight: 500;');
    vars.push('  --ui-label-line-height: 1rem;');
    vars.push('  --ui-label-letter-spacing: 0.03em;');
    vars.push('  --ui-label-font-weight: 500;');
    vars.push('  --ui-caption-line-height: 1rem;');
    vars.push('  --ui-caption-letter-spacing: 0.025em;');
    vars.push('  --ui-caption-font-weight: var(--ui-regular-font-weight, 400);');

     vars.push('  /* Markdown line height and letter spacing */');
     vars.push('  --markdown-body-line-height: 1.5rem;');
     vars.push('  --markdown-body-letter-spacing: 0;');
     vars.push('  --markdown-body-font-weight: var(--ui-regular-font-weight, 400);');
     vars.push('  --markdown-h1-line-height: 1.25rem;');
     vars.push('  --markdown-h1-letter-spacing: -0.025em;');
     vars.push('  --markdown-h2-line-height: 1.25rem;');
     vars.push('  --markdown-h2-letter-spacing: -0.02em;');
     vars.push('  --markdown-h3-line-height: 1.5rem;');
     vars.push('  --markdown-h3-letter-spacing: -0.015em;');
     vars.push('  --markdown-h4-line-height: 1.5rem;');
     vars.push('  --markdown-h4-letter-spacing: -0.01em;');
     vars.push('  --markdown-h5-line-height: 1.5rem;');
     vars.push('  --markdown-h5-letter-spacing: 0;');
     vars.push('  --markdown-h6-line-height: 1.5rem;');
     vars.push('  --markdown-h6-letter-spacing: 0.01em;');
    vars.push('  --markdown-list-line-height: 1.375rem;');
    vars.push('  --markdown-code-block-line-height: 1rem;');

    vars.push('  --ui-button-small-line-height: 1.25rem;');
    vars.push('  --ui-button-small-letter-spacing: 0.02em;');
    vars.push('  --ui-button-small-font-weight: 500;');
    vars.push('  --markdown-body-small-line-height: 1.375rem;');
    vars.push('  --markdown-body-small-letter-spacing: 0;');
    vars.push('  --markdown-body-small-font-weight: var(--ui-regular-font-weight, 400);');

    vars.push('  --ui-button-large-line-height: 1.5rem;');
    vars.push('  --ui-button-large-letter-spacing: 0.02em;');
    vars.push('  --ui-button-large-font-weight: 500;');
    vars.push('  --markdown-body-large-line-height: 1.625rem;');
    vars.push('  --markdown-body-large-letter-spacing: 0;');
    vars.push('  --markdown-body-large-font-weight: var(--ui-regular-font-weight, 400);');

    vars.push('  /* Code line height and letter spacing */');
    vars.push('  --code-inline-line-height: 1rem;');
    vars.push('  --code-inline-letter-spacing: 0;');
    vars.push('  --code-inline-font-weight: 400;');
    vars.push('  --code-block-line-height: 1.4rem;');
    vars.push('  --code-block-letter-spacing: 0;');
    vars.push('  --code-block-font-weight: 400;');
    vars.push('  --code-line-numbers-line-height: 1.25rem;');
    vars.push('  --code-line-numbers-letter-spacing: 0;');
    vars.push('  --code-line-numbers-font-weight: 400;');

    vars.push('  /* Additional UI element line height and letter spacing */');
    vars.push('  --ui-badge-line-height: 1rem;');
    vars.push('  --ui-badge-letter-spacing: 0.025em;');
    vars.push('  --ui-badge-font-weight: 500;');
    vars.push('  --ui-tooltip-line-height: 1rem;');
    vars.push('  --ui-tooltip-letter-spacing: 0.025em;');
    vars.push('  --ui-tooltip-font-weight: var(--ui-regular-font-weight, 400);');
    vars.push('  --ui-input-line-height: 1.375rem;');
    vars.push('  --ui-input-letter-spacing: 0.02em;');
    vars.push('  --ui-input-font-weight: var(--ui-regular-font-weight, 400);');
    vars.push('  --ui-helper-text-line-height: 1rem;');
    vars.push('  --ui-helper-text-letter-spacing: 0.025em;');
    vars.push('  --ui-helper-text-font-weight: var(--ui-regular-font-weight, 400);');

    vars.push('  /* Additional markdown line height and letter spacing */');
    vars.push('  --markdown-blockquote-line-height: 1.5rem;');
    vars.push('  --markdown-blockquote-letter-spacing: 0;');
    vars.push('  --markdown-blockquote-font-weight: var(--ui-regular-font-weight, 400);');
    vars.push('  --markdown-list-letter-spacing: 0;');
    vars.push('  --markdown-list-font-weight: var(--ui-regular-font-weight, 400);');
    vars.push('  --markdown-link-line-height: 1.5rem;');
    vars.push('  --markdown-link-letter-spacing: 0;');
    vars.push('  --markdown-link-font-weight: var(--ui-regular-font-weight, 400);');
    vars.push('  --markdown-code-line-height: 1.35;');
    vars.push('  --markdown-code-letter-spacing: 0;');
    vars.push('  --markdown-code-font-weight: 400;');
    vars.push('  --markdown-code-block-letter-spacing: 0;');
    vars.push('  --markdown-code-block-font-weight: 400;');

    return vars;
  }

  private initializeInheritanceMap(): void {

    this.inheritanceMap.set('header.background', 'surface.background');
    this.inheritanceMap.set('header.foreground', 'surface.foreground');
    this.inheritanceMap.set('header.logoTint', 'primary.base');
    this.inheritanceMap.set('header.divider', 'interactive.border');

    this.inheritanceMap.set('sidebar.background', 'surface.muted');
    this.inheritanceMap.set('sidebar.foreground', 'surface.mutedForeground');
    this.inheritanceMap.set('sidebar.hover', 'interactive.hover');
    this.inheritanceMap.set('sidebar.active', 'primary.base');
    this.inheritanceMap.set('sidebar.activeForeground', 'primary.foreground');

  }

  private opacity(color: string, alpha: number): string {
    if (color.startsWith('#')) {
      return `${color}${Math.round(alpha * 255).toString(16).padStart(2, '0')}`;
    }
    if (color.startsWith('rgb')) {
      return color.replace('rgb', 'rgba').replace(')', `, ${alpha})`);
    }
    return color;
  }

  private removeTransparency(color: string): string {
    if (color.startsWith('#')) {

      if (color.length === 9) {
        return color.slice(0, 7);
      }

      if (color.length === 5) {
        return color.slice(0, 4);
      }
      return color;
    }
    if (color.startsWith('rgba')) {

      return color.replace('rgba', 'rgb').replace(/,\s*[\d.]+\)$/, ')');
    }
    return color;
  }

  private addTransparency(color: string, opacity: number): string {
    if (color.startsWith('#')) {

      const hex = color.slice(1);
      if (hex.length === 3) {

        const r = parseInt(hex[0] + hex[0], 16);
        const g = parseInt(hex[1] + hex[1], 16);
        const b = parseInt(hex[2] + hex[2], 16);
        return `rgba(${r}, ${g}, ${b}, ${opacity})`;
      } else if (hex.length === 6) {

        const r = parseInt(hex.slice(0, 2), 16);
        const g = parseInt(hex.slice(2, 4), 16);
        const b = parseInt(hex.slice(4, 6), 16);
        return `rgba(${r}, ${g}, ${b}, ${opacity})`;
      }
    }
    if (color.startsWith('rgb')) {

      return color.replace('rgb', 'rgba').replace(')', `, ${opacity})`);
    }
    return color;
  }

  private darken(color: string, percent: number): string {

    if (color.startsWith('#')) {
      const num = parseInt(color.slice(1), 16);
      const amt = Math.round(2.55 * percent);
      const R = (num >> 16) - amt;
      const G = (num >> 8 & 0x00FF) - amt;
      const B = (num & 0x0000FF) - amt;
      return '#' + (0x1000000 + (R < 255 ? R < 0 ? 0 : R : 255) * 0x10000 +
        (G < 255 ? G < 0 ? 0 : G : 255) * 0x100 +
        (B < 255 ? B < 0 ? 0 : B : 255)).toString(16).slice(1);
    }
    return color;
  }

  private lighten(color: string, percent: number): string {

    if (color.startsWith('#')) {
      const num = parseInt(color.slice(1), 16);
      const amt = Math.round(2.55 * percent);
      const R = (num >> 16) + amt;
      const G = (num >> 8 & 0x00FF) + amt;
      const B = (num & 0x0000FF) + amt;
      return '#' + (0x1000000 + (R < 255 ? R < 0 ? 0 : R : 255) * 0x10000 +
        (G < 255 ? G < 0 ? 0 : G : 255) * 0x100 +
        (B < 255 ? B < 0 ? 0 : B : 255)).toString(16).slice(1);
    }
    return color;
  }

  private adjustHue(color: string, degrees: number): string {

    return this.lighten(color, degrees / 10);
  }

  private emphasize(color: string): string {

    return this.lighten(color, 15);
  }

  private kebabCase(str: string): string {
    return str.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
  }
}
