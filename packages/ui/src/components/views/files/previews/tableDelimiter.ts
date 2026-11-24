export type TableDelimiter = ',' | ';' | '\t';

const SNIFF_RECORD_LIMIT = 12;
const SNIFF_DELIMITERS: TableDelimiter[] = [',', ';', '\t'];

type Sniff = {
  widths: number[];
  separators: number;
  validQuotes: boolean;
};

// external: https://www.rfc-editor.org/rfc/rfc4180#section-2 A quote opens a field only at its start, and a closing quote ends the field.
const sniffRecords = (content: string, delimiter: TableDelimiter): Sniff => {
  const widths: number[] = [];
  const start = content.charCodeAt(0) === 0xfeff ? 1 : 0;
  let separators = 0;
  let validQuotes = true;
  let fields = 1;
  let hasContent = false;
  let quoted = false;
  let fieldStart = true;
  let afterQuote = false;
  for (let index = start; index < content.length; index += 1) {
    const char = content[index];
    if (quoted) {
      if (char === '"') {
        if (content[index + 1] === '"') index += 1;
        else {
          quoted = false;
          afterQuote = true;
        }
      }
      continue;
    }
    if (afterQuote) {
      afterQuote = false;
      if (char !== delimiter && char !== '\n' && char !== '\r') validQuotes = false;
    }
    if (char === '"') {
      if (!fieldStart) validQuotes = false;
      quoted = true;
      hasContent = true;
      fieldStart = false;
      continue;
    }
    if (char === delimiter) {
      fields += 1;
      separators += 1;
      hasContent = true;
      fieldStart = true;
      continue;
    }
    if (char === '\n' || char === '\r') {
      if (char === '\r' && content[index + 1] === '\n') index += 1;
      if (hasContent || fields > 1) widths.push(fields);
      if (widths.length >= SNIFF_RECORD_LIMIT) return { widths, separators, validQuotes };
      fields = 1;
      hasContent = false;
      fieldStart = true;
      continue;
    }
    hasContent = true;
    fieldStart = false;
  }
  if (quoted) validQuotes = false;
  if (hasContent || fields > 1) widths.push(fields);
  return { widths, separators, validQuotes };
};

export const resolveDelimiter = (filePath: string, content: string): TableDelimiter => {
  if (filePath.toLowerCase().endsWith('.tsv')) return '\t';
  let best: TableDelimiter = ',';
  let bestRank: [number, number, number] | null = null;
  for (const candidate of SNIFF_DELIMITERS) {
    const { widths, separators, validQuotes } = sniffRecords(content, candidate);
    if (widths.length === 0 || separators === 0) continue;
    const rank: [number, number, number] = [
      validQuotes ? 1 : 0,
      widths.filter((width) => width > 1 && width === widths[0]).length,
      Math.max(...widths),
    ];
    const wins = !bestRank
      || rank[0] > bestRank[0]
      || (rank[0] === bestRank[0] && (rank[1] > bestRank[1] || (rank[1] === bestRank[1] && rank[2] > bestRank[2])));
    if (wins) {
      best = candidate;
      bestRank = rank;
    }
  }
  return best;
};
