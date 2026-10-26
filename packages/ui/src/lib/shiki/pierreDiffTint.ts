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
