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
      position: 'relative' as const,
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
    /* ── Floating search: panels container ── */
    '.cm-panels': {
      backgroundColor: 'transparent',
      color: theme.colors.surface.foreground,
      position: 'absolute' as const,
      top: '0',
      right: '0',
      left: 'auto',
      width: 'auto',
      zIndex: 10,
      pointerEvents: 'none',
    },
    '.cm-panels-top': {
      borderBottom: 'none',
      position: 'absolute' as const,
      top: '6px',
      right: '14px',
      left: 'auto',
      width: 'auto',
    },

    /* ── Floating search panel ── */
    '.cm-panel.cm-search': {
      pointerEvents: 'auto',
      padding: '4px',
      backgroundColor: `color-mix(in srgb, ${theme.colors.surface.elevated} 85%, transparent)`,
      backdropFilter: 'blur(12px)',
      WebkitBackdropFilter: 'blur(12px)',
      border: `1px solid ${theme.colors.interactive.border}`,
      borderRadius: '10px',
      boxShadow: `0 2px 8px color-mix(in srgb, ${theme.colors.surface.background} 60%, transparent)`,
      width: 'auto',
      minWidth: '360px',
      maxWidth: '480px',
    },

    /* ── Search inner layout: flexbox rows ── */
    '.cm-search': {
      display: 'flex',
      flexWrap: 'wrap',
      alignItems: 'center',
      gap: '0',
      width: '100%',
      color: theme.colors.surface.foreground,
      fontFamily: 'inherit',
      fontSize: '13px',
      lineHeight: '1',
    },

    /* ── Hide <br>; we force row break via replace input's flex-basis ── */
    '.cm-search br': {
      display: 'none',
    },

    /* ──────────────────────────────────────────────────
       ROW 1: [Find input] [Aa] [ab] [.*] [match count] [↑] [↓] [≡] [×]
       ────────────────────────────────────────────────── */

    /* ── Text input base: border-radius matches action buttons (4px) ── */
    '.cm-search .cm-textfield': {
      appearance: 'none',
      height: '26px',
      margin: 0,
      padding: '0 8px',
      borderRadius: '6px !important',
      border: `1px solid ${theme.colors.interactive.border}`,
      backgroundColor: theme.colors.surface.background,
      color: theme.colors.surface.foreground,
      fontFamily: 'inherit',
      fontSize: '12px',
      lineHeight: '1',
      outline: 'none',
      transition: 'border-color 150ms ease',
    },
    '.cm-search .cm-textfield::placeholder': {
      color: theme.colors.surface.mutedForeground,
      opacity: 1,
    },
    '.cm-search .cm-textfield:focus': {
      borderColor: theme.colors.primary.base,
    },

    /* Find input: row 1, max-width matches replace input for alignment */
    '.cm-search .cm-textfield[name="search"]': {
      order: 1,
      flex: '1 1 120px',
      maxWidth: 'calc(100% - 142px)',
      minWidth: '100px',
    },

    /* Replace input is styled below in the row-2 section */

    /* ────────────────────────────────────────────────────
       ICON-ONLY TOGGLE BUTTONS (checkbox labels → icon toggles)
       Labels contain: [checkbox] "match case" / "regexp" / "by word"
       We hide text, hide the checkbox, and show icon via label::after
       ──────────────────────────────────────────────────── */
    '.cm-search label': {
      order: 2,
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: '26px',
      height: '26px',
      minWidth: '26px',
      flexShrink: '0',
      margin: 0,
      marginLeft: '1px',
      padding: 0,
      borderRadius: '4px',
      border: `1px solid transparent`,
      backgroundColor: 'transparent',
      color: 'transparent', /* hide label text */
      cursor: 'pointer',
      userSelect: 'none' as const,
      fontSize: '1px', /* near-zero to collapse text nodes */
      lineHeight: '0',
      overflow: 'hidden',
      position: 'relative' as const,
      transition: 'background-color 120ms ease, border-color 120ms ease',
    },
    '.cm-search label:hover': {
      backgroundColor: theme.colors.interactive.hover,
    },
    '.cm-search label:has(input[type="checkbox"]:checked)': {
      backgroundColor: theme.colors.interactive.hover,
      borderColor: theme.colors.interactive.border,
    },

    /* Hide the actual checkbox input inside labels */
    '.cm-search [type="checkbox"]': {
      appearance: 'none',
      WebkitAppearance: 'none',
      width: '0',
      height: '0',
      margin: '0',
      padding: '0',
      border: 'none',
      position: 'absolute' as const,
      opacity: '0',
      pointerEvents: 'none' as const,
    },

    /* Icon via ::after on each label - absolutely positioned so text-hiding doesn't affect it */
    '.cm-search label::after': {
      position: 'absolute' as const,
      top: '50%',
      left: '50%',
      transform: 'translate(-50%, -50%)',
      fontSize: '13px',
      fontWeight: '600',
      lineHeight: '1',
      fontFamily: 'inherit',
      color: theme.colors.surface.mutedForeground,
      pointerEvents: 'none' as const,
    },
    '.cm-search label:hover::after': {
      color: theme.colors.surface.foreground,
    },
    '.cm-search label:has(input[type="checkbox"]:checked)::after': {
      color: theme.colors.surface.foreground,
    },

    /* Case sensitive: "Aa" */
    '.cm-search label:has(input[name="case"])::after': {
      content: '"Aa"',
      fontSize: '12px',
      letterSpacing: '-0.5px',
    },
    /* Regex: ".*" */
    '.cm-search label:has(input[name="re"])::after': {
      content: '".*"',
      fontSize: '13px',
      fontFamily: 'monospace',
    },
    /* Whole word: "ab" with underline */
    '.cm-search label:has(input[name="word"])::after': {
      content: '"ab"',
      fontSize: '12px',
      textDecoration: 'underline',
      textUnderlineOffset: '2px',
    },

    /* ────────────────────────────────────────────────────
       MATCH COUNT (search message - "X of Y")
       ──────────────────────────────────────────────────── */
    '.cm-search .cm-search-message': {
      order: 3,
      color: theme.colors.surface.mutedForeground,
      backgroundColor: 'transparent',
      border: 'none',
      borderRadius: '0',
      padding: '0 6px',
      fontSize: '11px',
      whiteSpace: 'nowrap' as const,
      lineHeight: '26px',
    },

    /* ────────────────────────────────────────────────────
       ICON-ONLY ACTION BUTTONS
       Hide button text with font-size:0, show icon via ::after
       ──────────────────────────────────────────────────── */
    '.cm-search .cm-button': {
      appearance: 'none',
      WebkitAppearance: 'none',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: '26px',
      height: '26px',
      minWidth: '26px',
      flexShrink: '0',
      margin: 0,
      marginLeft: '1px',
      padding: 0,
      borderRadius: '4px',
      border: 'none',
      backgroundColor: 'transparent',
      backgroundImage: 'none',
      color: 'transparent', /* hide button text */
      cursor: 'pointer',
      fontSize: '1px', /* near-zero to collapse text */
      fontWeight: '400',
      lineHeight: '0',
      overflow: 'hidden',
      position: 'relative' as const,
      boxShadow: 'none',
      transition: 'background-color 120ms ease',
    },
    '.cm-search .cm-button::after': {
      position: 'absolute' as const,
      top: '50%',
      left: '50%',
      transform: 'translate(-50%, -50%)',
      fontSize: '15px',
      lineHeight: '1',
      color: theme.colors.surface.mutedForeground,
      pointerEvents: 'none' as const,
    },
    '.cm-search .cm-button:hover': {
      backgroundColor: theme.colors.interactive.hover,
    },
    '.cm-search .cm-button:hover::after': {
      color: theme.colors.surface.foreground,
    },
    '.cm-search .cm-button:active': {
      backgroundColor: theme.colors.interactive.active,
    },
    '.cm-search .cm-button:focus-visible': {
      outline: 'none',
      boxShadow: `0 0 0 1px ${theme.colors.interactive.focusRing}`,
    },
    '.cm-search .cm-button:disabled': {
      opacity: 0.4,
      cursor: 'default',
      pointerEvents: 'none' as const,
    },

    /* prev → ↑ arrow (row 2) */
    '.cm-search .cm-button[name="prev"]': {
      order: 21,
      marginTop: '2px',
    },
    '.cm-search .cm-button[name="prev"]::after': {
      content: '"↑"',
    },
    /* next → ↓ arrow (row 2) */
    '.cm-search .cm-button[name="next"]': {
      order: 22,
      marginTop: '2px',
    },
    '.cm-search .cm-button[name="next"]::after': {
      content: '"↓"',
    },
    /* select all → ≡ (row 2) */
    '.cm-search .cm-button[name="select"]': {
      order: 23,
      marginTop: '2px',
    },
    '.cm-search .cm-button[name="select"]::after': {
      content: '"≡"',
      fontSize: '17px',
    },

    /* ── Close button (×) - not a .cm-button, separate selector ── */
    '.cm-panel.cm-search button[name="close"]': {
      order: 5,
      appearance: 'none',
      WebkitAppearance: 'none',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: '26px',
      height: '26px',
      minWidth: '26px',
      flexShrink: '0',
      margin: '0 0 0 auto',
      padding: '0',
      borderRadius: '4px',
      border: 'none',
      backgroundColor: 'transparent',
      backgroundImage: 'none',
      color: theme.colors.surface.mutedForeground,
      cursor: 'pointer',
      fontSize: '16px',
      lineHeight: '1',
      boxShadow: 'none',
      position: 'relative' as const,
      overflow: 'visible',
      transition: 'background-color 120ms ease, color 120ms ease',
    },
    '.cm-panel.cm-search button[name="close"]:hover': {
      backgroundColor: theme.colors.interactive.hover,
      color: theme.colors.surface.foreground,
    },

    /* ──────────────────────────────────────────────────
       ROW 2: [Replace input] [replace icon] [replace-all icon]
       ────────────────────────────────────────────────── */

    /* replace → swap icon (row 2) */
    '.cm-search .cm-button[name="replace"]': {
      order: 24,
      marginTop: '2px',
    },
    '.cm-search .cm-button[name="replace"]::after': {
      content: '"⇄"',
    },
    /* replace all → double arrow icon (row 2) */
    '.cm-search .cm-button[name="replaceAll"], .cm-search .cm-button[name="replace-all"]': {
      order: 25,
      marginTop: '2px',
    },
    '.cm-search .cm-button[name="replaceAll"]::after, .cm-search .cm-button[name="replace-all"]::after': {
      content: '"⇉"',
    },

    /* ── Replace input: forces wrap to row 2, same width as find input ── */
    '.cm-search .cm-textfield[name="replace"]': {
      order: 20,
      flex: '1 1 100%',
      maxWidth: 'calc(100% - 142px)', /* room for ↑↓≡⇄⇉ (5 × 27px + gaps) */
      minWidth: '80px',
      marginTop: '2px',
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
