// Pierre mixes the theme's add/remove color into changed rows at 20% (dark)
// and 12% (light), with gutters and changed words on top. Vivid theme greens
// and reds turned whole hunks into colored blocks whose code was hard to read,
// so changed rows get half that tint. Injected into each diff's shadow root,
// where Pierre's own color variables resolve.
export const PIERRE_DIFF_TINT_CSS = `
  /* How much of the theme's added or removed colour a changed row mixes into
     the background (100% minus the value). Set per kind and theme so the two
     read with equal strength: green reads greyer than red at the same amount
     in light themes, and the default dark red came out stronger than its
     green. The gutter takes one step more than its row. */
  [data-line][data-line-type],
  [data-no-newline][data-line-type] {
    --mix-light: 94%;
    --mix-dark: 90%;
  }

  [data-line][data-line-type="change-addition"],
  [data-no-newline][data-line-type="change-addition"] {
    --mix-light: 91%;
    --mix-dark: 90%;
  }

  [data-line][data-line-type="change-deletion"],
  [data-no-newline][data-line-type="change-deletion"] {
    --mix-light: 94%;
    --mix-dark: 91.5%;
  }

  [data-gutter-buffer][data-line-type="change-addition"],
  [data-column-number][data-line-type="change-addition"] {
    --mix-light: 88%;
    --mix-dark: 87%;
  }

  [data-gutter-buffer][data-line-type="change-deletion"],
  [data-column-number][data-line-type="change-deletion"] {
    --mix-light: 92%;
    --mix-dark: 89%;
  }

  [data-diff-span] {
    --diffs-bg-addition-emphasis: light-dark(
      rgb(from var(--diffs-addition-base) r g b / 0.1),
      rgb(from var(--diffs-addition-base) r g b / 0.14)
    );
    --diffs-bg-deletion-emphasis: light-dark(
      rgb(from var(--diffs-deletion-base) r g b / 0.1),
      rgb(from var(--diffs-deletion-base) r g b / 0.14)
    );
  }
`;

// The row between hunks ("N unmodified lines"): muted text on the diff's own
// background (24px, the height the virtualized Changes view lays rows out
// with), the same in the Changes view and in
// a tool's diff in the chat. A tinted band with hairlines read heavier than
// the rows it introduces. Injected into each diff's shadow root.
export const PIERRE_SEPARATOR_CSS = `
  [data-diff-header],
  [data-diff] {
    [data-separator] {
      height: 24px !important;
      background: var(--diffs-bg) !important;
    }
  }

  /* No fill and no lines, in every column of both sides: the label alone,
     in the line-number colour, says the hunks are apart. */
  [data-separator="line-info-basic"] {
    height: 24px !important;
    background: var(--diffs-bg) !important;
    position: relative;
    box-shadow: none !important;
  }

  [data-diff-type="single"] [data-gutter],
  [data-diff-type="split"] [data-deletions] [data-gutter] {
    [data-separator-wrapper] {
      position: absolute;
      left: 100%;
      display: flex;
      align-items: center;
      gap: unset;
      width: max-content;
      background: transparent;
      color: var(--diffs-fg-number);
      font-family: var(--diffs-header-font-family, var(--font-sans));
      font-size: 0.75rem;
      line-height: 1;
      /* The label starts where the code text does: past the gutter by the
         code line's 1ch of padding, a monospace ch at the code size. */
      margin-left: calc(var(--diffs-font-size, 12px) * 0.6);
    }

    /* The expand glyph (Pierre's button, or the on-demand glyph the Changes
       view draws) hangs in the gutter, so it does not push the label off the
       code column. "Expand all" is a word, not a glyph: it stays in the row
       after the label. */
    [data-separator-wrapper]:not([data-separator-multi-button]) > [data-expand-button]:not([data-expand-all-button]),
    [data-separator-wrapper]::before {
      position: absolute;
      right: 100%;
      margin-right: 0.375rem;
    }

    [data-separator-wrapper][data-separator-multi-button] {
      margin-left: calc(-3ch - 2px);
    }

    [data-expand-button],
    [data-separator-content] {
      display: block;
      align-self: unset;
      min-width: unset;
      min-height: unset;
      padding: 0;
      flex-shrink: 0;
      grid-column: unset;
      border: none;
      width: auto;
      height: auto;
      background-color: transparent;
      color: inherit;
      font: inherit;
    }

    [data-expand-button]:not([data-expand-all-button]) {
      &[data-expand-down]::before {
        content: '\\2191';
      }

      &[data-expand-up]::before {
        content: '\\2193';
      }

      &[data-expand-both]::before {
        content: '\\2195';
      }

      svg {
        display: none;
      }
    }

    [data-separator-content] {
      background: transparent;
      margin-left: calc(2px + 1ch);
    }

    [data-expand-all-button] {
      position: relative;
      margin-left: 14px;
      text-transform: lowercase;
    }

    [data-expand-all-button]::before {
      content: '';
      display: block;
      position: absolute;
      top: 50%;
      left: -8px;
      margin-top: -1px;
      width: 3px;
      height: 3px;
      border-radius: 2px;
      background-color: var(--diffs-fg-number);
      pointer-events: none;
    }

    [data-separator-content]:hover,
    [data-expand-button]:hover,
    [data-expand-all-button]:hover {
      color: var(--diffs-fg);
    }

    [data-expand-all-button]:hover {
      text-decoration: underline;
    }
  }
`;
