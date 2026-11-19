import { PIERRE_DIFF_TINT_CSS, PIERRE_SEPARATOR_CSS } from '@/lib/shiki/pierreDiffTint';

export const HUNK_ACTION_OVERLAY_CSS = `
  [data-gutter-buffer="annotation"] { min-height: 0; }
  [data-code] { min-height: 2.5rem; align-content: start; }
`;

export const HIDE_COLUMN_SCROLLBAR_CSS = `
  [data-code] { scrollbar-width: none; }
  [data-code]::-webkit-scrollbar { display: none; }
`;

const PIERRE_RUNTIME_BASE_CSS = `
  :host {
    font-family: var(--font-mono);
    font-size: var(--text-code);
  }

  pre, [data-code] {
    font-family: var(--font-mono);
    font-size: var(--text-code);
  }

  /* Mobile touch selection support */
  [data-line-number] {
    touch-action: manipulation;
    -webkit-tap-highlight-color: transparent;
    cursor: pointer;
  }

  /* Ensure interactive line numbers work on touch */
  pre[data-interactive-line-numbers] [data-line-number] {
    touch-action: manipulation;
  }
`;

export const WEBKIT_SCROLL_FIX_CSS = `
  ${PIERRE_RUNTIME_BASE_CSS}
  ${PIERRE_DIFF_TINT_CSS}

  /* While a multi-line content drag is being mapped to a line selection the
     row highlight is the feedback; the native blue text selection on top of
     it reads as double-selection, so it is painted transparent for the drag's
     duration only (single-line selections keep the normal look for copying). */
  :host([data-oc-comment-drag]) {
    user-select: none;
    -webkit-user-select: none;
  }

  /* Gutter "+" comment utility: theme primary, and smaller than Pierre's
     1lh default, which reads oversized next to our 13px line numbers. */
  [data-utility-button] {
    width: 16px;
    height: 16px;
    align-self: center;
    margin-right: calc(-16px + 1ch);
    border-radius: 5px;
    background-color: var(--primary-base);
    color: var(--primary-foreground);
  }

  :host {
    --diffs-bg-separator-override: var(--surface-elevated);
  }

  /* Selected rows: Pierre mixes the selection colour in at 18-25%, and the
     theme's selection is a soft neutral, so the selection barely showed on
     dark themes. Half the selection colour stays readable while added and
     deleted rows keep their tint. */
  [data-line][data-selected-line],
  [data-line-annotation][data-selected-line],
  [data-no-newline][data-selected-line] {
    --mix-selection-light: 62%;
    --mix-selection-dark: 50%;
  }

  [data-gutter-buffer][data-selected-line],
  [data-column-number][data-selected-line] {
    --mix-selection-light: 55%;
    --mix-selection-dark: 40%;
  }

  ${PIERRE_SEPARATOR_CSS}

  /* Partial diffs get no expand buttons from Pierre (the lines are not
     loaded). When the owner can load them on demand, the gutter separator
     itself becomes the button and shows the same glyphs as the real one. */
  :host([data-oc-expand-on-demand]) [data-diff-type="single"] [data-gutter] [data-separator-wrapper],
  :host([data-oc-expand-on-demand]) [data-diff-type="split"] [data-deletions] [data-gutter] [data-separator-wrapper] {
    cursor: pointer;

    &::before {
      content: '\\2195';
      display: block;
      flex-shrink: 0;
    }

    &:hover {
      color: var(--diffs-fg);
    }
  }

  :host([data-oc-expand-on-demand]) [data-diff-type="single"] [data-gutter] [data-separator-first] [data-separator-wrapper]::before,
  :host([data-oc-expand-on-demand]) [data-diff-type="split"] [data-deletions] [data-gutter] [data-separator-first] [data-separator-wrapper]::before {
    content: '\\2191';
  }

  /* Full file requested: the glyph becomes a spinner and the separators stop
     taking clicks until the highlighted full diff replaces this one. */
  :host([data-oc-expand-loading]) [data-diff-type="single"] [data-gutter] [data-separator-wrapper],
  :host([data-oc-expand-loading]) [data-diff-type="split"] [data-deletions] [data-gutter] [data-separator-wrapper] {
    cursor: default;
    pointer-events: none;
    opacity: 0.6;

    &::before {
      content: '';
      width: 9px;
      height: 9px;
      margin-right: 3px;
      border-radius: 50%;
      border: 1.5px solid currentColor;
      border-right-color: transparent;
      animation: oc-expand-spin 0.8s linear infinite;
    }
  }

  @keyframes oc-expand-spin {
    to { transform: rotate(360deg); }
  }
  `;
