import type { Extension } from '@codemirror/state';

import { EditorView } from '@codemirror/view';
import { HighlightStyle, defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { classHighlighter, tags as t } from '@lezer/highlight';

import type { Theme } from '@/types/theme';

export function createFlexokiCodeMirrorTheme(theme: Theme): Extension {
  const isDark = theme.metadata.variant === 'dark';

  const monoFont = theme.config?.fonts?.mono || 'monospace';
  const highlights = theme.colors.syntax.highlights || {};
  const tokens = theme.colors.syntax.tokens || {};

  const ui = EditorView.theme({
    '&': {
      backgroundColor: 'var(--background)',
      color: theme.colors.syntax.base.foreground,
      fontSize: 'var(--text-code)',
      lineHeight: '1.5rem',
    },
    '.cm-scroller': {
      fontFamily: monoFont,
      backgroundColor: 'var(--background)',
    },

    /* StreamLanguage/legacy-modes tokens (class-based) */
    '.cm-comment': {
      color: theme.colors.syntax.base.comment,
    },
    '.cm-keyword': {
      color: theme.colors.syntax.base.keyword,
    },
    '.cm-string': {
      color: theme.colors.syntax.base.string,
    },
    '.cm-string-2': {
      color: tokens.stringEscape || theme.colors.syntax.base.string,
    },
    '.cm-number': {
      color: theme.colors.syntax.base.number,
    },
    '.cm-operator': {
      color: theme.colors.syntax.base.operator,
    },
    '.cm-punctuation': {
      color: tokens.punctuation || theme.colors.syntax.base.comment,
    },
    '.cm-atom': {
      color: tokens.boolean || theme.colors.syntax.base.number,
    },
    '.cm-builtin': {
      color: tokens.functionCall || theme.colors.syntax.base.function,
    },
    '.cm-def': {
      color: tokens.variableGlobal || theme.colors.syntax.base.variable,
    },
    // Legacy shell flags (--foo, -bar)
    '.cm-attribute': {
      color: tokens.variableOther || tokens.variableProperty || theme.colors.syntax.base.operator,
    },
    '.cm-meta': {
      color: theme.colors.syntax.base.comment,
    },
    '.cm-property': {
      color: tokens.variableProperty || theme.colors.syntax.base.keyword,
    },
    '.cm-variable': {
      color: theme.colors.syntax.base.variable,
    },
    '.cm-variable-2': {
      color: tokens.variableOther || theme.colors.syntax.base.function,
    },
    '.cm-variable-3': {
      color: tokens.variableGlobal || theme.colors.syntax.base.type,
    },
    '.cm-tag': {
      color: tokens.tag || theme.colors.syntax.base.keyword,
    },
    '.cm-link': {
      color: tokens.url || theme.colors.syntax.base.keyword,
      textDecoration: 'underline',
    },

    '.cm-content': {
      caretColor: theme.colors.interactive.cursor,
    },
    '.cm-cursor, .cm-dropCursor': {
      borderLeftColor: theme.colors.interactive.cursor,
    },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
      backgroundColor: theme.colors.interactive.selection,
    },
    '.cm-gutters': {
      backgroundColor: 'var(--background)',
      color: highlights.lineNumber || theme.colors.syntax.base.comment,
      borderRight: `1px solid ${theme.colors.interactive.border}`,
      position: 'sticky',
      paddingRight: '8px',
      left: 0,
      zIndex: 2,
      boxShadow: `0 0 0 var(--background)`,
    },
    '.cm-gutter': {
      backgroundColor: 'var(--background)',
    },
    '.cm-gutterElement': {
      backgroundColor: 'var(--background)',
    },
    '.cm-lineNumbers': {
      backgroundColor: 'var(--background)',
    },
    '.cm-lineNumbers .cm-gutterElement': {
      paddingLeft: '8px',
      paddingRight: '8px',
      minWidth: '42px',
    },
    '.cm-activeLineGutter': {
      color: highlights.lineNumberActive || theme.colors.syntax.base.foreground,
    },
    '.cm-activeLine': {
      backgroundColor: theme.colors.surface.overlay,
    },
    '.cm-panels': {
      backgroundColor: theme.colors.surface.elevated,
      color: theme.colors.surface.foreground,
    },
    '.cm-panels-top': {
      borderBottom: `1px solid ${theme.colors.interactive.border}`,
      boxShadow: `0 1px 0 ${theme.colors.surface.subtle}`,
    },
    '.cm-panel.cm-search': {
      padding: '0.625rem 0.75rem',
      backgroundColor: theme.colors.surface.elevated,
    },
    '.cm-search': {
      display: 'flex',
      flexWrap: 'wrap',
      alignItems: 'center',
      gap: '0.5rem',
      color: theme.colors.surface.foreground,
      fontSize: '0.8125rem',
    },
    '.cm-search .cm-textfield': {
      minHeight: '2rem',
      padding: '0.375rem 0.625rem',
      borderRadius: '0.5rem',
      border: `1px solid ${theme.colors.interactive.border}`,
      backgroundColor: theme.colors.surface.background,
      color: theme.colors.surface.foreground,
      outline: 'none',
      transition: 'border-color 120ms ease, box-shadow 120ms ease',
    },
    '.cm-search .cm-textfield:hover': {
      borderColor: theme.colors.interactive.borderHover,
    },
    '.cm-search .cm-textfield:focus, .cm-search .cm-textfield:focus-visible': {
      borderColor: theme.colors.interactive.borderFocus,
      boxShadow: `0 0 0 2px ${theme.colors.interactive.focusRing}`,
    },
    '.cm-search .cm-button': {
      minHeight: '2rem',
      padding: '0.375rem 0.625rem',
      borderRadius: '0.5rem',
      border: `1px solid ${theme.colors.interactive.border}`,
      backgroundColor: theme.colors.surface.background,
      color: theme.colors.surface.foreground,
      cursor: 'pointer',
      transition: 'background-color 120ms ease, border-color 120ms ease, color 120ms ease',
    },
    '.cm-search .cm-button:hover': {
      backgroundColor: theme.colors.interactive.hover,
      borderColor: theme.colors.interactive.borderHover,
    },
    '.cm-search .cm-button:active': {
      backgroundColor: theme.colors.interactive.active,
      borderColor: theme.colors.interactive.borderFocus,
    },
    '.cm-search .cm-button:focus, .cm-search .cm-button:focus-visible': {
      outline: 'none',
      boxShadow: `0 0 0 2px ${theme.colors.interactive.focusRing}`,
    },
    '.cm-search .cm-button:disabled': {
      opacity: 0.55,
      cursor: 'not-allowed',
      backgroundColor: theme.colors.surface.muted,
      color: theme.colors.surface.mutedForeground,
    },
    '.cm-searchMatch': {
      backgroundColor: theme.colors.status.infoBackground,
      boxShadow: `inset 0 0 0 1px ${theme.colors.status.infoBorder}`,
      borderRadius: '2px',
    },
    '.cm-searchMatch.cm-searchMatch-selected': {
      backgroundColor: theme.colors.interactive.selection,
      color: theme.colors.interactive.selectionForeground,
      boxShadow: `inset 0 0 0 1px ${theme.colors.interactive.borderFocus}`,
    },
    '&.cm-focused': {
      outline: 'none',
    },
  }, { dark: isDark });

  const syntax = HighlightStyle.define([
    { tag: [t.comment, t.docComment, t.meta, t.documentMeta], class: 'cm-comment' },
    { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.definitionKeyword, t.modifier], class: 'cm-keyword' },
    { tag: [t.operatorKeyword, t.operator, t.derefOperator, t.updateOperator, t.definitionOperator, t.typeOperator, t.controlOperator, t.logicOperator, t.bitwiseOperator, t.arithmeticOperator, t.compareOperator], class: 'cm-operator' },
    { tag: [t.punctuation, t.separator, t.bracket, t.paren, t.brace, t.squareBracket, t.angleBracket], class: 'cm-punctuation' },

    { tag: [t.string, t.regexp, t.attributeValue, t.special(t.string), t.monospace], class: 'cm-string' },
    { tag: t.escape, class: 'cm-string-2' },
    { tag: [t.number, t.bool, t.atom, t.null, t.self], class: 'cm-number' },

    { tag: [t.function(t.variableName), t.function(t.definition(t.variableName)), t.function(t.propertyName), t.standard(t.variableName), t.special(t.variableName)], class: 'cm-builtin' },
    { tag: t.definition(t.variableName), class: 'cm-def' },
    { tag: [t.variableName, t.local(t.variableName), t.constant(t.variableName), t.literal], class: 'cm-variable' },
    { tag: t.propertyName, class: 'cm-property' },
    { tag: t.attributeName, class: 'cm-attribute' },

    { tag: [t.className, t.typeName, t.namespace], class: 'cm-variable-3' },
    { tag: [t.tagName, t.labelName, t.annotation, t.macroName], class: 'cm-tag' },
    { tag: t.link, class: 'cm-link' },

    { tag: [t.heading, t.heading1, t.heading2, t.heading3, t.heading4, t.heading5, t.heading6], class: 'cm-keyword' },
  ]);

  const directSyntax = HighlightStyle.define([
    { tag: [t.comment, t.docComment, t.meta, t.documentMeta], color: theme.colors.syntax.base.comment },
    { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.definitionKeyword, t.modifier], color: theme.colors.syntax.base.keyword },
    {
      tag: [
        t.operatorKeyword,
        t.operator,
        t.derefOperator,
        t.updateOperator,
        t.definitionOperator,
        t.typeOperator,
        t.controlOperator,
        t.logicOperator,
        t.bitwiseOperator,
        t.arithmeticOperator,
        t.compareOperator,
      ],
      color: theme.colors.syntax.base.operator,
    },
    { tag: [t.string, t.regexp, t.attributeValue, t.special(t.string), t.monospace], color: theme.colors.syntax.base.string },
    { tag: t.escape, color: tokens.stringEscape || theme.colors.syntax.base.string },
    { tag: [t.number, t.bool, t.atom, t.null, t.self], color: theme.colors.syntax.base.number },
    { tag: [t.function(t.variableName), t.function(t.definition(t.variableName)), t.function(t.propertyName), t.standard(t.variableName), t.special(t.variableName)], color: theme.colors.syntax.base.function },
    { tag: t.definition(t.variableName), color: tokens.variableGlobal || theme.colors.syntax.base.variable },
    { tag: [t.variableName, t.local(t.variableName), t.constant(t.variableName), t.literal], color: theme.colors.syntax.base.variable },
    { tag: t.propertyName, color: tokens.variableProperty || theme.colors.syntax.base.variable },
    { tag: t.attributeName, color: tokens.variableOther || theme.colors.syntax.base.variable },
    { tag: [t.className, t.typeName, t.namespace], color: theme.colors.syntax.base.type },
    { tag: [t.tagName, t.labelName, t.annotation, t.macroName], color: tokens.tag || theme.colors.syntax.base.keyword },
    { tag: t.link, color: tokens.url || theme.colors.syntax.base.function, textDecoration: 'underline' },
    {
      tag: [t.punctuation, t.separator, t.bracket, t.paren, t.brace, t.squareBracket, t.angleBracket],
      color: tokens.punctuation || theme.colors.syntax.base.comment,
    },
  ]);

  return [
    ui,
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    syntaxHighlighting(classHighlighter),
    syntaxHighlighting(syntax),
    syntaxHighlighting(directSyntax),
  ];
}
