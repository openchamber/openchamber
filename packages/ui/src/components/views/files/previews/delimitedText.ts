/**
 * CSV/TSV parsing for the table preview.
 *
 * RFC 4180 rules: a field wrapped in double quotes may hold the delimiter,
 * newlines and doubled quotes. The parser is streaming over one string so a
 * large export never builds an intermediate array of lines, and it stops
 * filling rows past the cap while still counting them, so the preview can say
 * "2,000 of 48,210 rows" without holding all of them.
 */

type DelimitedTable = {
  header: string[];
  rows: string[][];
  /** Every data row in the file, including the ones not kept. */
  totalRows: number;
  columnCount: number;
  truncated: boolean;
};

const DEFAULT_TABLE_ROW_CAP = 2_000;

export const delimiterForPath = (filePath: string): ',' | '\t' => (
  filePath.toLowerCase().endsWith('.tsv') ? '\t' : ','
);

export const parseDelimitedText = (
  content: string,
  delimiter: ',' | '\t',
  rowCap: number = DEFAULT_TABLE_ROW_CAP,
): DelimitedTable => {
  const records: string[][] = [];
  let totalRecords = 0;
  let field = '';
  let record: string[] = [];
  let quoted = false;
  let recordHasContent = false;

  const pushRecord = () => {
    record.push(field);
    field = '';
    // A trailing newline is not an empty record; a single empty field is only
    // a record when something else on that line said so.
    const isBlank = record.length === 1 && record[0] === '' && !recordHasContent;
    if (!isBlank) {
      if (totalRecords === 0 || records.length <= rowCap) {
        records.push(record);
      }
      totalRecords += 1;
    }
    record = [];
    recordHasContent = false;
  };

  const source = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
      recordHasContent = true;
      continue;
    }
    if (char === delimiter) {
      record.push(field);
      field = '';
      recordHasContent = true;
      continue;
    }
    if (char === '\n' || char === '\r') {
      if (char === '\r' && source[index + 1] === '\n') index += 1;
      pushRecord();
      continue;
    }
    field += char;
  }
  if (field.length > 0 || record.length > 0 || quoted) pushRecord();

  const header = records[0] ?? [];
  const rows = records.slice(1);
  const columnCount = records.reduce((max, entry) => Math.max(max, entry.length), 0);
  const totalRows = Math.max(0, totalRecords - 1);
  return {
    header,
    rows,
    totalRows,
    columnCount,
    truncated: rows.length < totalRows,
  };
};
