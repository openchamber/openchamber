/**
 * CSV/TSV parsing for the table preview.
 *
 * RFC 4180 rules: a field wrapped in double quotes may hold the delimiter,
 * newlines and doubled quotes. The parser is streaming over one string so a
 * large export never builds an intermediate array of lines, and it stops
 * filling rows past the cap while still counting them, so the preview can say
 * "100,000 of 480,210 rows" without holding all of them.
 */

type DelimitedTable = {
  header: string[];
  rows: string[][];
  /** Every data row in the file, including the ones not kept. */
  totalRows: number;
  columnCount: number;
  truncated: boolean;
};

export const DEFAULT_TABLE_ROW_CAP = 100_000;

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

const fieldText = (value: string, delimiter: string): string => (
  value.includes(delimiter) || /["\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
);

/**
 * The file's text with one field replaced and every other byte kept, quoting
 * and line endings included. `record` counts the way the parser does, the
 * heading being 0; a record or a column past the end is added.
 */
export const setDelimitedField = (content: string, delimiter: ',' | '\t', record: number, column: number, value: string): string => {
  const start = content.charCodeAt(0) === 0xfeff ? 1 : 0;
  let recordIndex = 0;
  let fieldIndex = 0;
  let fieldStart = start;
  let quoted = false;
  let recordHasContent = false;
  const replace = (end: number) => `${content.slice(0, fieldStart)}${fieldText(value, delimiter)}${content.slice(end)}`;
  const pad = (end: number) => `${content.slice(0, end)}${delimiter.repeat(column - fieldIndex)}${fieldText(value, delimiter)}${content.slice(end)}`;
  for (let index = start; index < content.length; index += 1) {
    const char = content[index];
    if (quoted) {
      if (char === '"') {
        if (content[index + 1] === '"') index += 1;
        else quoted = false;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
      recordHasContent = true;
      continue;
    }
    if (char === delimiter) {
      if (recordIndex === record && fieldIndex === column) return replace(index);
      fieldIndex += 1;
      fieldStart = index + 1;
      recordHasContent = true;
      continue;
    }
    if (char === '\n' || char === '\r') {
      const blank = fieldIndex === 0 && !recordHasContent && index === fieldStart;
      if (!blank) {
        if (recordIndex === record) return fieldIndex === column ? replace(index) : pad(index);
        recordIndex += 1;
      }
      if (char === '\r' && content[index + 1] === '\n') index += 1;
      fieldIndex = 0;
      fieldStart = index + 1;
      recordHasContent = false;
      continue;
    }
    recordHasContent = true;
  }
  if (recordIndex === record && (recordHasContent || fieldIndex > 0)) {
    return fieldIndex === column ? replace(content.length) : pad(content.length);
  }
  if (recordHasContent || fieldIndex > 0) recordIndex += 1;
  const ending = content.includes('\r\n') ? '\r\n' : '\n';
  const separator = content.length === start || /[\r\n]$/.test(content) ? '' : ending;
  const blankLines = ending.repeat(Math.max(0, record - recordIndex)).replace(new RegExp(ending, 'g'), `${delimiter}${ending}`);
  return `${content}${separator}${blankLines}${delimiter.repeat(column)}${fieldText(value, delimiter)}${ending}`;
};
