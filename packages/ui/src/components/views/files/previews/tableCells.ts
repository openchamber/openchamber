const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export const numericValue = (text: string): number | null => {
  const match = text.trim().match(/^([+-]?(?:\d[\d,]*\.?\d*|\.\d+)(?:e[+-]?\d+)?)(%?)$/i);
  return match ? Number(match[1].replace(/,/g, '')) : null;
};

export type SortDirection = 'ascending' | 'descending';

export const sortedRowOrder = (rows: string[][], column: number, direction: SortDirection, pinnedRows: number): number[] => {
  const sign = direction === 'ascending' ? 1 : -1;
  const keyed = rows.map((row, index) => {
    const text = row[column] ?? '';
    return { index, text, number: numericValue(text), empty: text.trim() === '' };
  });
  const pinned = keyed.slice(0, pinnedRows);
  const rest = keyed.slice(pinnedRows).sort((left, right) => {
    if (left.empty !== right.empty) return left.empty ? 1 : -1;
    if (left.number !== null && right.number !== null) return (left.number - right.number) * sign;
    if (left.number !== null) return -sign;
    if (right.number !== null) return sign;
    return collator.compare(left.text, right.text) * sign;
  });
  return [...pinned, ...rest].map((entry) => entry.index);
};

type ColumnSlot = { column: number; span?: undefined } | { column: number; span: number };

export const columnSlots = (columnCount: number, drawn: number[]): ColumnSlot[] => {
  const slots: ColumnSlot[] = [];
  let next = 0;
  const gapUntil = (end: number) => {
    // external: https://html.spec.whatwg.org/multipage/tables.html#attr-tdth-colspan HTML caps colspan at 1,000, so long virtual gaps use several cells.
    while (next < end) {
      const span = Math.min(1_000, end - next);
      slots.push({ column: next, span });
      next += span;
    }
  };
  for (const column of drawn) {
    gapUntil(column);
    slots.push({ column });
    next = column + 1;
  }
  gapUntil(columnCount);
  return slots;
};

const LINK = /\b(?:https?:\/\/|mailto:|www\.)[^\s<>"']+/gi;

type CellPart = { text: string; href?: string };

const safeLink = (target: string): string | null => {
  const candidate = /^www\./i.test(target) ? `https://${target}` : target;
  return /^(?:https?:\/\/|mailto:)/i.test(candidate) ? candidate : null;
};

export const cellParts = (text: string, href?: string): CellPart[] => {
  const whole = href ? safeLink(href) : null;
  if (whole) return [{ text, href: whole }];
  const parts: CellPart[] = [];
  let position = 0;
  for (const match of text.matchAll(LINK)) {
    const address = match[0].replace(/[.,;:!?)\]]+$/, '');
    const start = match.index;
    if (start > position) parts.push({ text: text.slice(position, start) });
    parts.push({ text: address, href: safeLink(address) ?? undefined });
    position = start + address.length;
  }
  if (position < text.length) parts.push({ text: text.slice(position) });
  return parts;
};

const shortNumber = (value: number): string => String(Number(value.toPrecision(12)));

export const selectionSummary = (values: string[]): { count: number; sum: string; average: string } | null => {
  const filled = values.filter((value) => value.trim() !== '');
  const numbers = filled.flatMap((value) => {
    const number = numericValue(value);
    return number === null ? [] : [number];
  });
  if (filled.length === 0) return null;
  const sum = numbers.reduce((total, number) => total + number, 0);
  return {
    count: filled.length,
    sum: numbers.length > 0 ? shortNumber(sum) : '',
    average: numbers.length > 0 ? shortNumber(sum / numbers.length) : '',
  };
};

export const fromTsv = (text: string): string[][] => {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char !== '"') field += char;
      else if (text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else quoted = false;
    } else if (char === '"' && field === '') quoted = true;
    else if (char === '\t') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += char;
  }
  if (field !== '' || row.length > 0) rows.push([...row, field]);
  return rows;
};

const tsvField = (value: string): string => (/[\t\r\n"]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);

export const toTsv = (rows: string[][]): string => rows.map((row) => row.map(tsvField).join('\t')).join('\n');
