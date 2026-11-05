const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** A shown value as a number: `12.50%`, `1,234.5`. Dates read in ISO order sort fine as text. */
const numericValue = (text: string): number | null => {
  const match = text.trim().match(/^([+-]?(?:\d[\d,]*\.?\d*|\.\d+)(?:e[+-]?\d+)?)(%?)$/i);
  return match ? Number(match[1].replace(/,/g, '')) : null;
};

export type SortDirection = 'ascending' | 'descending';

/** Row indices in sorted order. Empty cells go last in both directions and equal rows keep their order. */
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

const LINK = /\b(?:https?:\/\/|mailto:|www\.)[^\s<>"']+/gi;

type CellPart = { text: string; href?: string };

const safeLink = (target: string): string | null => {
  const candidate = /^www\./i.test(target) ? `https://${target}` : target;
  return /^(?:https?:\/\/|mailto:)/i.test(candidate) ? candidate : null;
};

/** A cell's text with its addresses marked; a link the file sets covers the whole cell. */
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
