import { strToU8, type Unzipped } from 'fflate';

import {
  attribute,
  columnIndex,
  columnName,
  decodeXml,
  elements,
  numericCellValue,
  parseRelationships,
  relationshipTarget,
  spreadsheetNumberFormats,
  tagBlocks,
  unzipWorkbook,
  xml,
  type NumberFormat,
} from '@/sync/document-attachments';
import { shiftFormula, shiftSheetReferences, shiftSpan } from './formulaText';
import { cellKey, movedCell, rangeBounds, type BookCell, type BookSheet, type CellChange, type CellKind, type StructureChange, type WorkbookDocument } from './model';
import { escapeXml, packArchive } from './rezip';

type SheetPart = { path: string; shared: Map<string, { origin: BookCell; keys: string[] }> };

/**
 * SpreadsheetML may sit under a prefix (`<x:row>`), as some generators write it.
 * The parts are brought to the default namespace on open, which is the same
 * document, so the reader and the writer deal with one spelling.
 */
const unprefixParts = (archive: Unzipped): void => {
  for (const path of Object.keys(archive)) {
    if (!/^xl\/.*\.xml$/i.test(path)) continue;
    const source = xml(archive, path);
    const root = source.match(/<([\w.-]+):(worksheet|workbook|sst|styleSheet|table)\b[^>]*>/);
    if (!root) continue;
    const prefix = root[1];
    const hasDefault = /\sxmlns\s*=/.test(root[0]);
    const declaration = new RegExp(`\\sxmlns:${prefix}\\s*=\\s*("[^"]*"|'[^']*')`);
    const openRoot = root[0].replace(declaration, (match, value: string) => (hasDefault ? '' : ` xmlns=${value}`));
    const text = source.replace(root[0], openRoot).replace(new RegExp(`<(/?)${prefix}:`, 'g'), '<$1');
    archive[path] = strToU8(text);
  }
};

const sharedStringsOf = (archive: Unzipped): string[] => tagBlocks(xml(archive, 'xl/sharedStrings.xml'), 'si')
  .map((item) => Array.from(item.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gi), (match) => decodeXml(match[1])).join(''));

const KIND_BY_TYPE = new Map<string, CellKind>([['b', 'boolean'], ['e', 'error'], ['s', 'text'], ['str', 'text'], ['inlineStr', 'text']]);

const readCell = (
  source: string,
  sharedStrings: string[],
  formats: Array<NumberFormat | undefined>,
): (Omit<BookCell, 'shared'> & { formulaTag?: string }) | null => {
  const tag = source.match(/^<c\b[^>]*>/i)?.[0] ?? '';
  const coordinates = attribute(tag, 'r')?.match(/^([a-z]+)([1-9]\d*)$/i);
  if (!coordinates) return null;
  const type = attribute(tag, 't');
  const style = attribute(tag, 's');
  const formulaTag = source.match(/<f\b[^>]*(?:\/>|>[\s\S]*?<\/f>)/i)?.[0];
  const value = source.match(/<v\b[^>]*>([\s\S]*?)<\/v>/i)?.[1] ?? '';
  const inline = type === 'inlineStr'
    ? Array.from(source.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gi), (match) => decodeXml(match[1])).join('')
    : undefined;
  if (!formulaTag && inline === undefined && value === '') return null;
  const kind = KIND_BY_TYPE.get(type ?? '') ?? 'number';
  const raw = inline ?? (type === 's' ? sharedStrings[Number(value)] ?? '' : decodeXml(value));
  const format = style === undefined ? formats[0] : formats[Number(style)];
  const normalized = kind === 'boolean' ? (raw === '1' ? 'TRUE' : 'FALSE') : raw;
  return {
    row: Number(coordinates[2]),
    column: columnIndex(coordinates[1]),
    kind,
    raw: normalized,
    display: kind === 'number' ? numericCellValue(raw, format) : normalized,
    format: kind === 'number' ? format : undefined,
    style,
    formulaTag,
  };
};

const applyFormula = (cell: BookCell, tag: string, sheet: BookSheet, part: SheetPart): void => {
  const open = tag.match(/^<f\b[^>]*>/i)?.[0] ?? tag;
  const text = decodeXml(tag.match(/>([\s\S]*)<\/f>/i)?.[1] ?? '');
  const type = attribute(open, 't');
  const reference = attribute(open, 'ref');
  if (type === 'shared') {
    const index = attribute(open, 'si') ?? '';
    const group = part.shared.get(index);
    cell.shared = index;
    if (text && !group) {
      cell.formula = text;
      part.shared.set(index, { origin: cell, keys: [cellKey(cell.row, cell.column)] });
    } else if (group?.origin.formula) {
      cell.formula = shiftFormula(group.origin.formula, cell.row - group.origin.row, cell.column - group.origin.column);
      group.keys.push(cellKey(cell.row, cell.column));
    }
    return;
  }
  cell.formula = text;
  if (type === 'array' && reference) lockRange(sheet, reference);
};

const lockRange = (sheet: BookSheet, reference: string, from: 'all' | 'firstRow' = 'all'): void => {
  const bounds = rangeBounds(reference);
  if (!bounds) return;
  const lastRow = from === 'firstRow' ? bounds.firstRow : bounds.lastRow;
  for (let row = bounds.firstRow; row <= lastRow; row += 1) {
    for (let column = bounds.firstColumn; column <= bounds.lastColumn; column += 1) sheet.locked.add(cellKey(row, column));
  }
};

const resolveFrom = (path: string, target: string): string => {
  const single = new Map([['id', { target, type: '' }]]);
  return relationshipTarget(path, single, 'id') ?? '';
};

const readSheet = (archive: Unzipped, name: string, path: string, sharedStrings: string[], formats: Array<NumberFormat | undefined>) => {
  const source = xml(archive, path);
  const relationships = parseRelationships(archive, path);
  const sheet: BookSheet = { name, cells: new Map(), locked: new Set(), protected: /<sheetProtection\b[^>]*\bsheet\s*=\s*["'](?:1|true)["']/i.test(source) };
  const part: SheetPart = { path, shared: new Map() };
  for (const row of elements(source, 'row')) {
    for (const element of elements(row, 'c')) {
      const parsed = readCell(element, sharedStrings, formats);
      if (!parsed) continue;
      const { formulaTag, ...cell } = parsed;
      if (formulaTag) applyFormula(cell, formulaTag, sheet, part);
      sheet.cells.set(cellKey(cell.row, cell.column), cell);
    }
  }
  for (const merged of elements(source, 'mergeCell')) {
    const reference = attribute(merged, 'ref') ?? '';
    lockRange(sheet, reference);
    const bounds = rangeBounds(reference);
    if (bounds) sheet.locked.delete(cellKey(bounds.firstRow, bounds.firstColumn));
  }
  for (const link of elements(source, 'hyperlink')) {
    const target = relationships.get(attribute(link, 'r:id') ?? '')?.target;
    const bounds = rangeBounds(attribute(link, 'ref') ?? '');
    const cell = bounds ? sheet.cells.get(cellKey(bounds.firstRow, bounds.firstColumn)) : undefined;
    if (cell && target) cell.href = target;
  }
  for (const relationship of relationships.values()) {
    if (!relationship.type.endsWith('/table')) continue;
    const open = xml(archive, resolveFrom(path, relationship.target)).match(/<table\b[^>]*>/i)?.[0] ?? '';
    if (attribute(open, 'headerRowCount') !== '0') lockRange(sheet, attribute(open, 'ref') ?? '', 'firstRow');
  }
  return { sheet, part };
};

const cellXml = (reference: string, cell: BookCell | null, style: string | undefined, formulaTag: string | undefined): string => {
  const styleAttribute = style === undefined ? '' : ` s="${escapeXml(style)}"`;
  if (!cell) return `<c r="${reference}"${styleAttribute}/>`;
  const formula = formulaTag ?? (cell.formula ? `<f>${escapeXml(cell.formula)}</f>` : '');
  const value = escapeXml(cell.raw);
  switch (cell.kind) {
    case 'number':
      return `<c r="${reference}"${styleAttribute}>${formula}<v>${value}</v></c>`;
    case 'boolean':
      return `<c r="${reference}"${styleAttribute} t="b">${formula}<v>${cell.raw === 'TRUE' ? 1 : 0}</v></c>`;
    case 'error':
      return `<c r="${reference}"${styleAttribute} t="e">${formula}<v>${value}</v></c>`;
    default:
      return formula
        ? `<c r="${reference}"${styleAttribute} t="str">${formula}<v>${value}</v></c>`
        : `<c r="${reference}"${styleAttribute} t="inlineStr"><is><t xml:space="preserve">${value}</t></is></c>`;
  }
};

type PendingCell = { cell: BookCell | null; keepFormula: boolean };

const patchRow = (rowXml: string | null, rowNumber: number, pending: Map<number, PendingCell>): string => {
  const open = rowXml?.match(/^<row\b[^>]*?(\/?)>/i);
  const openTag = open ? open[0].replace(/\/>$/, '>').replace(/\s+spans\s*=\s*("[^"]*"|'[^']*')/i, '') : `<row r="${rowNumber}">`;
  const existing = new Map<number, string>();
  for (const element of rowXml ? elements(rowXml, 'c') : []) {
    const reference = attribute(element.match(/^<c\b[^>]*>/i)?.[0] ?? '', 'r')?.match(/^([a-z]+)/i)?.[1];
    if (reference) existing.set(columnIndex(reference), element);
  }
  for (const [column, change] of pending) {
    const previous = existing.get(column);
    const tag = previous?.match(/^<c\b[^>]*>/i)?.[0] ?? '';
    const formulaTag = change.keepFormula ? previous?.match(/<f\b[^>]*(?:\/>|>[\s\S]*?<\/f>)/i)?.[0] : undefined;
    existing.set(column, cellXml(`${columnName(column)}${rowNumber}`, change.cell, attribute(tag, 's') ?? change.cell?.style, formulaTag));
  }
  const cells = Array.from(existing.entries()).sort(([left], [right]) => left - right).map(([, element]) => element);
  return `${openTag}${cells.join('')}</row>`;
};

const patchSheet = (source: string, changes: Map<number, Map<number, PendingCell>>): string => {
  const data = source.match(/<sheetData\b[^>]*?(?:\/>|>[\s\S]*<\/sheetData>)/i);
  if (!data) throw new Error('The sheet has no data section');
  const rows = new Map<number, string>();
  for (const row of elements(data[0], 'row')) {
    const number = Number(attribute(row.match(/^<row\b[^>]*>/i)?.[0] ?? '', 'r'));
    rows.set(number, row);
  }
  for (const [number, pending] of changes) rows.set(number, patchRow(rows.get(number) ?? null, number, pending));
  const inner = Array.from(rows.entries()).sort(([left], [right]) => left - right).map(([, row]) => row).join('');
  const openTag = data[0].match(/^<sheetData\b[^>]*?\/?>/i)?.[0].replace(/\/>$/, '>') ?? '<sheetData>';
  const start = data.index ?? 0;
  // The dimension element is optional, and a new cell can sit outside the stored one.
  return `${source.slice(0, start)}${openTag}${inner}</sheetData>${source.slice(start + data[0].length)}`.replace(/<dimension\b[^>]*\/>/i, '');
};

const shiftRange = (reference: string, change: StructureChange): string | null => {
  const bounds = rangeBounds(reference);
  if (!bounds) return reference;
  const { axis, at, delta } = change;
  const span = axis === 'row' ? shiftSpan(bounds.firstRow, bounds.lastRow, at, delta) : shiftSpan(bounds.firstColumn, bounds.lastColumn, at, delta);
  if (!span) return null;
  const [nextFirst, nextLast] = span;
  const name = (row: number, column: number) => `${columnName(column)}${row}`;
  const start = axis === 'row' ? name(nextFirst, bounds.firstColumn) : name(bounds.firstRow, nextFirst);
  const end = axis === 'row' ? name(nextLast, bounds.lastColumn) : name(bounds.lastRow, nextLast);
  return start === end ? start : `${start}:${end}`;
};

const shiftSheet = (source: string, change: StructureChange): string => {
  const data = source.match(/<sheetData\b[^>]*?(?:\/>|>[\s\S]*<\/sheetData>)/i);
  if (!data) return source;
  const rows: Array<[number, string]> = [];
  for (const rowXml of elements(data[0], 'row')) {
    const open = rowXml.match(/^<row\b[^>]*>/i)?.[0] ?? '';
    const number = Number(attribute(open, 'r'));
    const nextNumber = change.axis === 'row' ? movedCell(change, number, 0)?.row : number;
    if (nextNumber === undefined) continue;
    const cells = elements(rowXml, 'c').flatMap((cell): Array<[number, string]> => {
      const reference = attribute(cell.match(/^<c\b[^>]*>/i)?.[0] ?? '', 'r')?.match(/^([a-z]+)/i)?.[1] ?? 'A';
      const next = movedCell(change, number, columnIndex(reference));
      if (!next) return [];
      return [[next.column, cell.replace(/(^<c\b[^>]*?\sr\s*=\s*["'])[^"']*/i, `$1${columnName(next.column)}${next.row}`)]];
    }).sort(([left], [right]) => left - right).map(([, cell]) => cell);
    const movedOpen = open.replace(/\/>$/, '>').replace(/\s+spans\s*=\s*("[^"]*"|'[^']*')/i, '').replace(/(\sr\s*=\s*["'])\d+/i, `$1${nextNumber}`);
    rows.push([nextNumber, `${movedOpen}${cells.join('')}</row>`]);
  }
  const inner = rows.sort(([left], [right]) => left - right).map(([, row]) => row).join('');
  const openTag = data[0].match(/^<sheetData\b[^>]*?\/?>/i)?.[0].replace(/\/>$/, '>') ?? '<sheetData>';
  const start = data.index ?? 0;
  const moved = `${source.slice(0, start)}${openTag}${inner}</sheetData>${source.slice(start + data[0].length)}`;
  const withRanges = moved
    .replace(/<(mergeCell|hyperlink)\b[^>]*\/>/gi, (element) => {
      const reference = attribute(element, 'ref') ?? '';
      const next = shiftRange(reference, change);
      return next === null ? '' : element.replace(/(\sref\s*=\s*["'])[^"']*/i, `$1${next}`);
    })
    .replace(/<autoFilter\b[^>]*>/i, (element) => {
      const next = shiftRange(attribute(element, 'ref') ?? '', change);
      return next === null ? element : element.replace(/(\sref\s*=\s*["'])[^"']*/i, `$1${next}`);
    })
    .replace(/<dimension\b[^>]*\/>/i, '');
  if (change.axis !== 'column') return withRanges;
  return withRanges.replace(/<col\b[^>]*\/>/gi, (element) => {
    const min = Number(attribute(element, 'min')) - 1;
    const max = Number(attribute(element, 'max')) - 1;
    if (change.delta === -1 && min === change.at && max === change.at) return '';
    const nextMin = min > change.at || (change.delta === 1 && min === change.at) ? min + change.delta : min;
    const nextMax = max >= change.at ? max + change.delta : max;
    return element.replace(/(\smin\s*=\s*["'])\d+/i, `$1${nextMin + 1}`).replace(/(\smax\s*=\s*["'])\d+/i, `$1${nextMax + 1}`);
  });
};

const setText = (archive: Unzipped, path: string, text: string): void => {
  archive[path] = strToU8(text);
};

/** Stored results go stale after an edit; the chain Excel keeps of formula cells would name cells that no longer have one. */
const prepareForRecalculation = (archive: Unzipped): void => {
  const workbook = xml(archive, 'xl/workbook.xml');
  const calculation = workbook.match(/<calcPr\b[^>]*\/>/i)?.[0];
  if (calculation) {
    if (!/fullCalcOnLoad/i.test(calculation)) setText(archive, 'xl/workbook.xml', workbook.replace(calculation, calculation.replace(/\/>$/, ' fullCalcOnLoad="1"/>')));
  } else {
    setText(archive, 'xl/workbook.xml', workbook.replace(/<\/workbook>/i, '<calcPr fullCalcOnLoad="1"/></workbook>'));
  }
  if (!archive['xl/calcChain.xml']) return;
  delete archive['xl/calcChain.xml'];
  setText(archive, 'xl/_rels/workbook.xml.rels', xml(archive, 'xl/_rels/workbook.xml.rels').replace(/<Relationship\b[^>]*calcChain[^>]*\/>/i, ''));
  setText(archive, '[Content_Types].xml', xml(archive, '[Content_Types].xml').replace(/<Override\b[^>]*calcChain[^>]*\/>/i, ''));
};

const applyChanges = (archive: Unzipped, parts: SheetPart[], sheets: BookSheet[], changes: CellChange[]): void => {
  const bySheet = new Map<number, Map<number, Map<number, PendingCell>>>();
  const put = (sheet: number, row: number, column: number, pending: PendingCell) => {
    const rows = bySheet.get(sheet) ?? new Map<number, Map<number, PendingCell>>();
    const columns = rows.get(row) ?? new Map<number, PendingCell>();
    columns.set(column, pending);
    rows.set(row, columns);
    bySheet.set(sheet, rows);
  };
  // An edit inside a shared formula would take the text away from the cells
  // that borrow it, so the group is written out cell by cell first.
  const written = new Set<string>();
  for (const change of changes) {
    const before = sheets[change.sheet].cells.get(cellKey(change.row, change.column));
    const index = change.edited ? before?.shared : undefined;
    if (index === undefined) continue;
    const group = parts[change.sheet].shared.get(index);
    if (!group) continue;
    for (const key of group.keys) {
      const member = sheets[change.sheet].cells.get(key);
      if (!member) continue;
      member.shared = undefined;
      written.add(`${change.sheet}:${key}`);
      put(change.sheet, member.row, member.column, { cell: member, keepFormula: false });
    }
    parts[change.sheet].shared.delete(index);
  }
  for (const change of changes) {
    const keepFormula = !change.edited && !written.has(`${change.sheet}:${cellKey(change.row, change.column)}`);
    put(change.sheet, change.row, change.column, { cell: change.next, keepFormula });
  }
  for (const [sheet, rows] of bySheet) {
    setText(archive, parts[sheet].path, patchSheet(xml(archive, parts[sheet].path), rows));
  }
  prepareForRecalculation(archive);
};

export const openXlsxDocument = async (bytes: Uint8Array): Promise<WorkbookDocument | null> => {
  const archive = await unzipWorkbook(bytes);
  unprefixParts(archive);
  const workbookPath = 'xl/workbook.xml';
  const workbook = xml(archive, workbookPath);
  if (!workbook) return null;
  const relationships = parseRelationships(archive, workbookPath);
  const sharedStrings = sharedStringsOf(archive);
  const formats = spreadsheetNumberFormats(archive, workbook);
  const parts: SheetPart[] = [];
  const sheets: BookSheet[] = [];
  for (const entry of workbook.matchAll(/<sheet\b[^>]*\/?\s*>/gi)) {
    const path = relationshipTarget(workbookPath, relationships, attribute(entry[0], 'r:id'));
    if (!path) continue;
    const { sheet, part } = readSheet(archive, attribute(entry[0], 'name') ?? 'Sheet', path, sharedStrings, formats);
    sheets.push(sheet);
    parts.push(part);
  }
  const definedNames = elements(workbook, 'definedName').flatMap((entry) => {
    const open = entry.match(/^<definedName\b[^>]*>/i)?.[0] ?? '';
    const name = attribute(open, 'name');
    const formula = decodeXml(entry.match(/>([\s\S]*)<\/definedName>/i)?.[1] ?? '');
    const scope = attribute(open, 'localSheetId');
    return name && formula ? [{ name, formula, scope: scope === undefined ? null : Number(scope) }] : [];
  });
  return {
    sheets,
    definedNames,
    date1904: /<workbookPr\b[^>]*\bdate1904\s*=\s*["'](?:1|true)["']/i.test(workbook),
    write: async (changes) => {
      applyChanges(archive, parts, sheets, changes);
      return packArchive(archive);
    },
    canRestructure: (sheet) => !/<(?:tableParts|conditionalFormatting|dataValidations|drawing|legacyDrawing|extLst|filterColumn)\b/i.test(xml(archive, parts[sheet].path))
      // An array formula on any sheet can read this one, and its block cannot be rewritten cell by cell.
      && !parts.some((part) => /<f\b[^>]*\bt\s*=\s*["']array["']/i.test(xml(archive, part.path))),
    restructure: async (change, changes) => {
      // Shared formulas name their cells by distance, which a move breaks, so
      // each is written out first.
      const sharedCells = sheets.flatMap((sheet, index) => Array.from(sheet.cells.values())
        .filter((cell) => cell.shared !== undefined)
        .map((cell): CellChange => ({ sheet: index, row: cell.row, column: cell.column, next: { ...cell, shared: undefined }, edited: false })));
      const rows = new Map<number, Map<number, Map<number, PendingCell>>>();
      for (const { sheet, row, column, next } of sharedCells) {
        const sheetRows = rows.get(sheet) ?? new Map<number, Map<number, PendingCell>>();
        const columns = sheetRows.get(row) ?? new Map<number, PendingCell>();
        columns.set(column, { cell: next, keepFormula: false });
        sheetRows.set(row, columns);
        rows.set(sheet, sheetRows);
      }
      for (const [sheet, sheetRows] of rows) setText(archive, parts[sheet].path, patchSheet(xml(archive, parts[sheet].path), sheetRows));
      setText(archive, parts[change.sheet].path, shiftSheet(xml(archive, parts[change.sheet].path), change));
      const target = { sheet: sheets[change.sheet].name, axis: change.axis, at: change.at, delta: change.delta };
      setText(archive, 'xl/workbook.xml', xml(archive, 'xl/workbook.xml').replace(/(<definedName\b[^>]*>)([\s\S]*?)(<\/definedName>)/gi, (_, open: string, text: string, close: string) => (
        `${open}${escapeXml(shiftSheetReferences(decodeXml(text), target, attribute(open, 'localSheetId') === String(change.sheet)))}${close}`
      )));
      for (const part of parts) part.shared.clear();
      applyChanges(archive, parts, sheets, changes);
      return packArchive(archive);
    },
  };
};

