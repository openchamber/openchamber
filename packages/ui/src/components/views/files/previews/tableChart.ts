import { numericValue } from './tableCells';

const MAX_POINTS = 200;

/**
 * A chart of selected cells, as a UI block program. A first column that is not
 * all numbers names the points; every other column with numbers is a series,
 * named by the heading above it. Null when there is nothing to draw.
 */
export const chartProgram = (rows: string[][], headings: string[]): string | null => {
  const shown = rows.slice(0, MAX_POINTS);
  const width = shown[0]?.length ?? 0;
  const numeric = (column: number) => shown.some((row) => numericValue(row[column] ?? '') !== null);
  const labelled = width > 1 && !shown.every((row) => numericValue(row[0] ?? '') !== null);
  const first = labelled ? 1 : 0;
  const columns = Array.from({ length: width - first }, (_, index) => index + first).filter(numeric);
  if (shown.length === 0 || columns.length === 0) return null;
  const labels = shown.map((row, index) => (labelled ? row[0] ?? '' : String(index + 1)));
  const series = columns.map((column, index) => {
    const values = shown.map((row) => numericValue(row[column] ?? ''));
    return `s${index} = Series(${JSON.stringify(headings[column] || `Series ${index + 1}`)}, ${JSON.stringify(values)})`;
  });
  const isTime = labelled && labels.every((label) => /^\d{4}-\d{2}/.test(label));
  const chart = `${isTime ? 'LineChart' : 'BarChart'}(${JSON.stringify(labels)}, [${series.map((_, index) => `s${index}`).join(', ')}])`;
  return ['root = Stack([chart])', `chart = ${chart}`, ...series].join('\n');
};
