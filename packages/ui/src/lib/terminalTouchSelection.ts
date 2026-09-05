export type TerminalCellPosition = {
  column: number;
  row: number;
};

type TerminalViewportRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type TerminalSelectionPixelOffset = {
  x: number;
  y: number;
};

export const getTerminalCellFromPoint = (
  clientX: number,
  clientY: number,
  bounds: TerminalViewportRect,
  columns: number,
  rows: number,
): TerminalCellPosition | null => {
  if (bounds.width <= 0 || bounds.height <= 0 || columns <= 0 || rows <= 0) return null;

  const column = Math.floor(((clientX - bounds.left) / bounds.width) * columns);
  const row = Math.floor(((clientY - bounds.top) / bounds.height) * rows);

  return {
    column: Math.max(0, Math.min(columns - 1, column)),
    row: Math.max(0, Math.min(rows - 1, row)),
  };
};

export const getSingleCellSelectionOffset = (
  bounds: TerminalViewportRect,
  columns: number,
  rows: number,
): TerminalSelectionPixelOffset | undefined => {
  if (
    !Number.isFinite(bounds.width) ||
    !Number.isFinite(bounds.height) ||
    bounds.width <= 0 ||
    bounds.height <= 0 ||
    !Number.isFinite(columns) ||
    !Number.isFinite(rows) ||
    columns <= 0 ||
    rows <= 0
  ) return undefined;

  const cellWidth = bounds.width / columns;
  const cellHeight = bounds.height / rows;
  const halfWidth = cellWidth / 2;
  const halfHeight = cellHeight / 2;
  const cellDiagonal = Math.hypot(halfWidth, halfHeight);
  const scale = (halfWidth / cellDiagonal + 1) / 2;

  // Move diagonally inside the cell far enough to cross Ghostty's half-cell
  // threshold, without changing the cell used for the selection endpoint.
  return { x: halfWidth * scale, y: halfHeight * scale };
};

export const getTerminalWordRange = (
  cells: string[],
  column: number,
): { startColumn: number; endColumn: number } => {
  const clampedColumn = Math.max(0, Math.min(cells.length - 1, column));
  const isWordCell = (value: string | undefined) => Boolean(value && !/^\s+$/u.test(value));

  if (!isWordCell(cells[clampedColumn])) {
    return { startColumn: clampedColumn, endColumn: clampedColumn };
  }

  let startColumn = clampedColumn;
  let endColumn = clampedColumn;
  while (startColumn > 0 && isWordCell(cells[startColumn - 1])) startColumn -= 1;
  while (endColumn < cells.length - 1 && isWordCell(cells[endColumn + 1])) endColumn += 1;

  return { startColumn, endColumn };
};
