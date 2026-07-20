export const SEMANTIC_TYPOGRAPHY = {
  markdown: '0.9375rem',
  code: '0.8125rem',
  uiHeader: '0.9375rem',
  uiLabel: '0.8750rem',
  meta: '0.875rem',
  micro: '0.875rem',
  /** Settings page / detail-pane title — larger than section headers */
  settingsPageTitle: '1.125rem',
} as const;

export const VSCODE_TYPOGRAPHY = {
  // Keep VS Code webview typography slightly tighter; VS Code UI chrome already provides density.
  markdown: '0.9063rem',
  code: '0.8750rem',
  uiHeader: '0.9063rem',
  uiLabel: '0.8438rem',
  meta: '0.8438rem',
  micro: '0.7813rem',
  settingsPageTitle: '1.0625rem',
} as const;

export type SemanticTypographyKey = keyof typeof SEMANTIC_TYPOGRAPHY;

export function getTypographyVariable(key: SemanticTypographyKey): string {
  return `--text-${key.replace(/([A-Z])/g, '-$1').toLowerCase()}`;
}

export const typography = {

  semanticMarkdown: {
    fontSize: 'var(--text-markdown)',
  },

   semanticCode: {
     fontSize: 'var(--text-code)',
   },

  uiHeader: {
    fontSize: 'var(--text-ui-header)',
  },

  uiLabel: {
    fontSize: 'var(--text-ui-label)',
  },

  meta: {
    fontSize: 'var(--text-meta)',
  },

  micro: {
    fontSize: 'var(--text-micro)',
  },

  ui: {
    button: {
      fontSize: 'var(--text-ui-label)',
      lineHeight: 'var(--ui-button-line-height)',
      letterSpacing: 'var(--ui-button-letter-spacing)',
      fontWeight: 'var(--ui-button-font-weight)',
    },
    buttonSmall: {
      fontSize: 'var(--text-meta)',
      lineHeight: 'var(--ui-button-small-line-height)',
      letterSpacing: 'var(--ui-button-small-letter-spacing)',
      fontWeight: 'var(--ui-button-small-font-weight)',
    },
    buttonLarge: {
      fontSize: 'var(--text-ui-label)',
      lineHeight: 'var(--ui-button-large-line-height)',
      letterSpacing: 'var(--ui-button-large-letter-spacing)',
      fontWeight: 'var(--ui-button-large-font-weight)',
    },
    label: {
      fontSize: 'var(--text-meta)',
      lineHeight: 'var(--ui-label-line-height)',
      letterSpacing: 'var(--ui-label-letter-spacing)',
      fontWeight: 'var(--ui-label-font-weight)',
    },
    caption: {
      fontSize: 'var(--text-micro)',
      lineHeight: 'var(--ui-caption-line-height)',
      letterSpacing: 'var(--ui-caption-letter-spacing)',
      fontWeight: 'var(--ui-caption-font-weight)',
    },
    badge: {
      fontSize: 'var(--text-micro)',
      lineHeight: 'var(--ui-badge-line-height)',
      letterSpacing: 'var(--ui-badge-letter-spacing)',
      fontWeight: 'var(--ui-badge-font-weight)',
    },
    tooltip: {
      fontSize: 'var(--text-micro)',
      lineHeight: 'var(--ui-tooltip-line-height)',
      letterSpacing: 'var(--ui-tooltip-letter-spacing)',
      fontWeight: 'var(--ui-tooltip-font-weight)',
    },
    input: {
      fontSize: 'var(--text-ui-label)',
      lineHeight: 'var(--ui-input-line-height)',
      letterSpacing: 'var(--ui-input-letter-spacing)',
      fontWeight: 'var(--ui-input-font-weight)',
    },
    helperText: {
      fontSize: 'var(--text-meta)',
      lineHeight: 'var(--ui-helper-text-line-height)',
      letterSpacing: 'var(--ui-helper-text-letter-spacing)',
      fontWeight: 'var(--ui-helper-text-font-weight)',
    },
  },

  code: {
    inline: {
      fontSize: 'var(--text-code)',
      lineHeight: 'var(--code-inline-line-height)',
      letterSpacing: 'var(--code-inline-letter-spacing)',
      fontWeight: 'var(--code-inline-font-weight)',
    },
    block: {
      fontSize: 'var(--text-code)',
      lineHeight: 'var(--code-block-line-height)',
      letterSpacing: 'var(--code-block-letter-spacing)',
      fontWeight: 'var(--code-block-font-weight)',
    },
    lineNumbers: {
      fontSize: 'var(--text-micro)',
      lineHeight: 'var(--code-line-numbers-line-height)',
      letterSpacing: 'var(--code-line-numbers-letter-spacing)',
      fontWeight: 'var(--code-line-numbers-font-weight)',
    },
  },

   markdown: {
    body: {
      fontSize: 'var(--text-markdown)',
      lineHeight: 'var(--markdown-body-line-height)',
      letterSpacing: 'var(--markdown-body-letter-spacing)',
      fontWeight: 'var(--markdown-body-font-weight)',
    },
    bodySmall: {
      fontSize: 'var(--text-meta)',
      lineHeight: 'var(--markdown-body-small-line-height)',
      letterSpacing: 'var(--markdown-body-small-letter-spacing)',
      fontWeight: 'var(--markdown-body-small-font-weight)',
    },
    bodyLarge: {
      fontSize: 'var(--text-markdown)',
      lineHeight: 'var(--markdown-body-large-line-height)',
      letterSpacing: 'var(--markdown-body-large-letter-spacing)',
      fontWeight: 'var(--markdown-body-large-font-weight)',
    },
    blockquote: {
      fontSize: 'var(--text-markdown)',
      lineHeight: 'var(--markdown-blockquote-line-height)',
      letterSpacing: 'var(--markdown-blockquote-letter-spacing)',
      fontWeight: 'var(--markdown-blockquote-font-weight)',
    },
    list: {
      fontSize: 'var(--text-markdown)',
      lineHeight: 'var(--markdown-list-line-height)',
      letterSpacing: 'var(--markdown-list-letter-spacing)',
      fontWeight: 'var(--markdown-list-font-weight)',
    },
    link: {
      fontSize: 'var(--text-markdown)',
      lineHeight: 'var(--markdown-link-line-height)',
      letterSpacing: 'var(--markdown-link-letter-spacing)',
      fontWeight: 'var(--markdown-link-font-weight)',
    },
    code: {
      fontSize: 'var(--text-code)',
      lineHeight: 'var(--markdown-code-line-height)',
      letterSpacing: 'var(--markdown-code-letter-spacing)',
      fontWeight: 'var(--markdown-code-font-weight)',
    },
    codeBlock: {
      fontSize: 'var(--text-code)',
      lineHeight: 'var(--markdown-code-block-line-height)',
      letterSpacing: 'var(--markdown-code-block-letter-spacing)',
      fontWeight: 'var(--markdown-code-block-font-weight)',
    },
  },

  tool: {

    collapsed: {
      fontSize: 'var(--text-code)',
      lineHeight: 'var(--code-block-line-height)',
      letterSpacing: 'var(--code-block-letter-spacing)',
      fontWeight: 'var(--code-block-font-weight)',
    },

    popup: {
      fontSize: 'var(--text-code)',
      lineHeight: 'var(--code-block-line-height)',
      letterSpacing: 'var(--code-block-letter-spacing)',
      fontWeight: 'var(--code-block-font-weight)',
    },

    inline: {
      fontSize: 'var(--text-code)',
      lineHeight: 'var(--code-inline-line-height)',
      letterSpacing: 'var(--code-inline-letter-spacing)',
      fontWeight: 'var(--code-inline-font-weight)',
    },
  },
};

export const toolDisplayStyles = {

  padding: {
    collapsed: '0.375rem',
    popup: '0.75rem',
    popupContainer: '1rem',
  },

  backgroundOpacity: {
    muted: '30',
    mutedAlt: '50',
  },

  getCollapsedStyles: () => ({
    ...typography.tool.collapsed,
    background: 'transparent',
    backgroundColor: 'transparent',
    margin: 0,
    padding: toolDisplayStyles.padding.collapsed,
    borderRadius: 0,
  }),

  getPopupStyles: () => ({
    ...typography.tool.popup,
    background: 'transparent',
    backgroundColor: 'transparent',
    margin: 0,
    padding: toolDisplayStyles.padding.popup,
    borderRadius: '0.75rem',
  }),

  getPopupContainerStyles: () => ({
    ...typography.tool.popup,
    background: 'transparent',
    backgroundColor: 'transparent',
    margin: 0,
    padding: toolDisplayStyles.padding.popupContainer,
    borderRadius: '0.5rem',
    overflowX: 'auto' as const,
  }),

  getInlineStyles: () => ({
    ...typography.tool.inline,
  }),
};
