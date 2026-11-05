import { strToU8, type Unzipped } from 'fflate';

import { attribute, decodeXml, elements, expandOdfSpaces, odsSheetName, repeatCount, tagBlocks, unzipWorkbook, xml } from '@/sync/document-attachments';
import { formulaFromOpenDocument, formulaToOpenDocument } from './formulaText';
import { cellKey, type BookCell, type BookSheet, type CellChange, type CellKind, type WorkbookDocument } from './model';
import { escapeXml, packArchive } from './rezip';

const CONTENT = 'content.xml';
const CELL = 'table:(?:covered-)?table-cell';
const ROW = 'table:table-row';
const MAX_REPEAT = 1_000;
const MAX_COLUMNS = 1_024;

const dateSerial = (iso: string): number => (Date.parse(`${iso.slice(0, 19)}Z`) - Date.UTC(1899, 11, 30)) / 86_400_000;

const cellText = (cell: string): string => elements(cell, 'text:p')
  .map((paragraph) => decodeXml(paragraph
    .replace(/<text:s\b[^>]*\/?\s*>/gi, expandOdfSpaces)
    .replace(/<text:line-break\b[^>]*\/?\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')))
  .join('\n');

const openTagOf = (element: string): string => element.match(/^<[^>]*?\/?>/)?.[0] ?? '';

const readCell = (element: string, row: number, column: number): BookCell | null => {
  const tag = openTagOf(element);
  const type = attribute(tag, 'office:value-type');
  const display = cellText(element);
  const formula = attribute(tag, 'table:formula');
  if (!type && !display && !formula) return null;
  let kind: CellKind = 'text';
  let raw = attribute(tag, 'office:string-value') ?? display;
  if (type === 'float' || type === 'percentage' || type === 'currency') {
    kind = 'number';
    raw = attribute(tag, 'office:value') ?? '';
  } else if (type === 'date') {
    kind = 'number';
    raw = String(dateSerial(attribute(tag, 'office:date-value') ?? ''));
  } else if (type === 'boolean') {
    kind = 'boolean';
    raw = attribute(tag, 'office:boolean-value') === 'true' ? 'TRUE' : 'FALSE';
  } else if (/^(?:#[A-Z/0!?]+|Err:\d+)$/.test(display) && formula) {
    kind = 'error';
  }
  const href = element.match(/<text:a\b[^>]*>/i)?.[0];
  return {
    row,
    column,
    kind,
    raw,
    display,
    formula: formula ? formulaFromOpenDocument(formula) : undefined,
    href: href ? attribute(href, 'xlink:href') : undefined,
    style: type === 'date' ? 'date' : undefined,
  };
};

const readSheet = (table: string): BookSheet => {
  const sheet: BookSheet = { name: odsSheetName(table), cells: new Map(), locked: new Set(), protected: /table:protected\s*=\s*"true"/.test(openTagOf(table)) };
  let row = 1;
  for (const rowXml of elements(table, ROW)) {
    const rowRepeat = repeatCount(rowXml, 'table:number-rows-repeated');
    let column = 0;
    for (const element of elements(rowXml, CELL)) {
      if (column >= MAX_COLUMNS) break;
      const columnRepeat = repeatCount(element, 'table:number-columns-repeated');
      const spanned = element.startsWith('<table:covered');
      const seed = readCell(element, row, column);
      for (let offset = 0; offset < Math.min(columnRepeat, MAX_COLUMNS - column); offset += 1) {
        if (spanned) sheet.locked.add(cellKey(row, column + offset));
        if (!seed) continue;
        for (let down = 0; down < Math.min(rowRepeat, MAX_REPEAT); down += 1) {
          sheet.cells.set(cellKey(row + down, column + offset), { ...seed, row: row + down, column: column + offset });
        }
      }
      column += columnRepeat;
    }
    row += rowRepeat;
  }
  return sheet;
};

const withRepeat = (element: string, name: string, count: number): string => {
  const tag = openTagOf(element);
  const bare = tag.replace(new RegExp(`\\s${name}=(?:"[^"]*"|'[^']*')`), '');
  const next = count > 1 ? bare.replace(/(\/?)>$/, ` ${name}="${count}"$1>`) : bare;
  return `${next}${element.slice(tag.length)}`;
};

const COLUMNS_REPEATED = 'table:number-columns-repeated';
const ROWS_REPEATED = 'table:number-rows-repeated';

const cellElement = (cell: BookCell | null, previous: string | undefined): string => {
  const style = attribute(openTagOf(previous ?? ''), 'table:style-name');
  const styleAttribute = style ? ` table:style-name="${escapeXml(style)}"` : '';
  if (!cell) return `<table:table-cell${styleAttribute}/>`;
  const formula = cell.formula ? ` table:formula="${escapeXml(formulaToOpenDocument(cell.formula))}"` : '';
  const text = `<text:p>${escapeXml(cell.display)}</text:p>`;
  const previousType = attribute(openTagOf(previous ?? ''), 'office:value-type');
  let value = ' office:value-type="string"';
  if (cell.kind === 'number') {
    const type = previousType === 'percentage' || previousType === 'currency' ? previousType : 'float';
    value = cell.style === 'date'
      ? ` office:value-type="date" office:date-value="${new Date(Date.UTC(1899, 11, 30) + Number(cell.raw) * 86_400_000).toISOString().slice(0, 19)}"`
      : ` office:value-type="${type}" office:value="${escapeXml(cell.raw)}"`;
  } else if (cell.kind === 'boolean') {
    value = ` office:value-type="boolean" office:boolean-value="${cell.raw === 'TRUE' ? 'true' : 'false'}"`;
  }
  return `<table:table-cell${styleAttribute}${formula}${value}>${text}</table:table-cell>`;
};

type RowChanges = Map<number, BookCell | null>;

const patchRow = (rowXml: string, changes: RowChanges): string => {
  const tag = openTagOf(rowXml);
  const output: string[] = [];
  const remaining = new Map(changes);
  let column = 0;
  for (const element of elements(rowXml, CELL)) {
    const repeat = repeatCount(element, COLUMNS_REPEATED);
    const hits = Array.from(remaining.keys()).filter((key) => key >= column && key < column + repeat).sort((a, b) => a - b);
    if (hits.length === 0) {
      output.push(element);
      column += repeat;
      continue;
    }
    let cursor = column;
    for (const hit of hits) {
      if (hit > cursor) output.push(withRepeat(element, COLUMNS_REPEATED, hit - cursor));
      output.push(cellElement(remaining.get(hit) ?? null, element));
      remaining.delete(hit);
      cursor = hit + 1;
    }
    if (cursor < column + repeat) output.push(withRepeat(element, COLUMNS_REPEATED, column + repeat - cursor));
    column += repeat;
  }
  for (const key of Array.from(remaining.keys()).sort((a, b) => a - b)) {
    if (key > column) output.push(`<table:table-cell ${COLUMNS_REPEATED}="${key - column}"/>`);
    output.push(cellElement(remaining.get(key) ?? null, undefined));
    column = key + 1;
  }
  return `${tag.replace(/\/>$/, '>')}${output.join('')}</table:table-row>`;
};

const patchTable = (table: string, changes: Map<number, RowChanges>): string => {
  const pending = new Map(changes);
  let row = 1;
  let result = table.replace(new RegExp(`<${ROW}(?=[\\s/>])[^>]*?\\/>|<${ROW}(?=[\\s/>])[^>]*>[\\s\\S]*?<\\/${ROW}>`, 'gi'), (rowXml) => {
    const repeat = repeatCount(rowXml, ROWS_REPEATED);
    const hits = Array.from(pending.keys()).filter((key) => key >= row && key < row + repeat).sort((a, b) => a - b);
    if (hits.length === 0) {
      row += repeat;
      return rowXml;
    }
    const output: string[] = [];
    let cursor = row;
    for (const hit of hits) {
      if (hit > cursor) output.push(withRepeat(rowXml, ROWS_REPEATED, hit - cursor));
      output.push(patchRow(withRepeat(rowXml, ROWS_REPEATED, 1), pending.get(hit) ?? new Map()));
      pending.delete(hit);
      cursor = hit + 1;
    }
    if (cursor < row + repeat) output.push(withRepeat(rowXml, ROWS_REPEATED, row + repeat - cursor));
    row += repeat;
    return output.join('');
  });
  const appended: string[] = [];
  for (const key of Array.from(pending.keys()).sort((a, b) => a - b)) {
    if (key > row) appended.push(`<${ROW} ${ROWS_REPEATED}="${key - row}"><table:table-cell/></${ROW}>`);
    appended.push(patchRow(`<${ROW}></${ROW}>`, pending.get(key) ?? new Map()));
    row = key + 1;
  }
  if (appended.length > 0) result = result.replace(/<\/table:table>\s*$/, `${appended.join('')}</table:table>`);
  return result;
};

const patchContent = (content: string, changes: CellChange[]): string => {
  const bySheet = new Map<number, Map<number, RowChanges>>();
  for (const change of changes) {
    const rows = bySheet.get(change.sheet) ?? new Map<number, RowChanges>();
    const columns = rows.get(change.row) ?? new Map<number, BookCell | null>();
    columns.set(change.column, change.next);
    rows.set(change.row, columns);
    bySheet.set(change.sheet, rows);
  }
  let index = -1;
  return content.replace(/<table:table\b[^>]*>[\s\S]*?<\/table:table>/gi, (table) => {
    index += 1;
    const rows = bySheet.get(index);
    return rows ? patchTable(table, rows) : table;
  });
};

export const openOdsDocument = async (bytes: Uint8Array): Promise<WorkbookDocument | null> => {
  let archive: Unzipped = await unzipWorkbook(bytes);
  const content = xml(archive, CONTENT);
  if (!content) return null;
  return {
    sheets: tagBlocks(content, 'table:table').map(readSheet),
    definedNames: [],
    date1904: false,
    write: async (changes) => {
      archive = { ...archive, [CONTENT]: strToU8(patchContent(xml(archive, CONTENT), changes)) };
      return packArchive(archive, ['mimetype']);
    },
  };
};
