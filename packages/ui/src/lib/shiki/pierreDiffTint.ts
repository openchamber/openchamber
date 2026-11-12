// Pierre mixes the theme's add/remove color into changed rows at 20% (dark)
// and 12% (light), with gutters and changed words on top. Vivid theme greens
// and reds turned whole hunks into colored blocks whose code was hard to read,
// so changed rows get half that tint. Injected into each diff's shadow root,
// where Pierre's own color variables resolve.
export const PIERRE_DIFF_TINT_CSS = `
  [data-line][data-line-type],
  [data-no-newline][data-line-type] {
    --mix-light: 94%;
    --mix-dark: 90%;
  }

  [data-gutter-buffer][data-line-type],
  [data-column-number][data-line-type] {
    --mix-light: 95%;
    --mix-dark: 92%;
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

// The row between hunks ("N unmodified lines"): a faint tint with hairlines
// above and below and its label in the line-number colour beside the gutter,
// the same in the Changes view and in a tool's diff in the chat, where
// Pierre's default solid band was the loudest thing in the card. Injected
// into each diff's shadow root.
export const PIERRE_SEPARATOR_CSS = `
  [data-diff-header],
  [data-diff] {
    [data-separator] {
      height: 24px !important;
    }
  }

  /* A faint tint and hairlines above and below, across every column of both
     sides, so two hunks read as two even where the label shows on one side
     only. Inset shadows, not borders: the row keeps the height Pierre lays
     out with. */
  [data-separator="line-info-basic"] {
    height: 24px !important;
    background: color-mix(in srgb, var(--diffs-fg) 2%, var(--diffs-bg)) !important;
    position: relative;
    box-shadow:
      inset 0 1px 0 var(--interactive-border),
      inset 0 -1px 0 var(--interactive-border);
  }

  [data-separator="line-info-basic"][data-separator-first] {
    box-shadow: inset 0 -1px 0 var(--interactive-border);
  }

  [data-separator="line-info-basic"][data-separator-last] {
    box-shadow: inset 0 1px 0 var(--interactive-border);
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
      margin-left: calc(-2ch - 2px);
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
