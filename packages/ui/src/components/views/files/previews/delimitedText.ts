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
  // An empty record would read as a blank line and fall out of the table.
  const fieldOf = (lone: boolean) => (value === '' && lone ? '""' : fieldText(value, delimiter));
  const replace = (end: number) => {
    const lone = fieldIndex === 0 && (end === content.length || content[end] === '\n' || content[end] === '\r');
    return `${content.slice(0, fieldStart)}${fieldOf(lone)}${content.slice(end)}`;
  };
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

type FieldSpan = { start: number; end: number };

/** Where each record and field sits in the text, blank lines skipped the way the parser skips them. */
const recordSpans = (content: string, delimiter: string): Array<{ start: number; end: number; fields: FieldSpan[] }> => {
  const records: Array<{ start: number; end: number; fields: FieldSpan[] }> = [];
  const first = content.charCodeAt(0) === 0xfeff ? 1 : 0;
  let start = first;
  let fieldStart = first;
  let fields: FieldSpan[] = [];
  let quoted = false;
  let hasContent = false;
  const close = (end: number, next: number) => {
    fields.push({ start: fieldStart, end });
    if (hasContent || fields.length > 1 || end > fieldStart) records.push({ start, end: next, fields });
    fields = [];
    start = next;
    fieldStart = next;
    hasContent = false;
  };
  for (let index = first; index < content.length; index += 1) {
    const char = content[index];
    if (quoted) {
      if (char === '"') {
        if (content[index + 1] === '"') index += 1;
        else quoted = false;
      }
    } else if (char === '"') {
      quoted = true;
      hasContent = true;
    } else if (char === delimiter) {
      fields.push({ start: fieldStart, end: index });
      fieldStart = index + 1;
      hasContent = true;
    } else if (char === '\n' || char === '\r') {
      const next = char === '\r' && content[index + 1] === '\n' ? index + 2 : index + 1;
      close(index, next);
      index = next - 1;
    } else {
      hasContent = true;
    }
  }
  if (fieldStart < content.length || fields.length > 0) close(content.length, content.length);
  return records;
};

/** A row of empty fields before `record`, or `record` gone; every other byte stays. */
export const shiftDelimitedRow = (content: string, delimiter: ',' | '\t', record: number, delta: 1 | -1): string => {
  const records = recordSpans(content, delimiter);
  const target = records[record];
  if (!target) return content;
  if (delta === -1) return `${content.slice(0, target.start)}${content.slice(target.end)}`;
  const ending = content.includes('\r\n') ? '\r\n' : '\n';
  const width = Math.max(1, ...records.map((entry) => entry.fields.length));
  return `${content.slice(0, target.start)}${width === 1 ? '""' : delimiter.repeat(width - 1)}${ending}${content.slice(target.start)}`;
};

/** A column of empty fields before `column`, or `column` gone. */
export const shiftDelimitedColumn = (content: string, delimiter: ',' | '\t', column: number, delta: 1 | -1): string => {
  const records = recordSpans(content, delimiter);
  let result = content;
  // From the end, so earlier offsets stay true.
  for (const { fields } of [...records].reverse()) {
    const field = fields[column];
    if (delta === 1) {
      const at = field ? field.start : fields[fields.length - 1].end;
      const text = field ? delimiter : delimiter.repeat(column - fields.length + 1);
      result = `${result.slice(0, at)}${text}${result.slice(at)}`;
    } else if (field) {
      const isLast = column === fields.length - 1;
      const from = isLast && column > 0 ? fields[column - 1].end : field.start;
      const to = isLast ? field.end : fields[column + 1].start;
      result = `${result.slice(0, from)}${result.slice(to)}`;
    }
  }
  return result;
};
