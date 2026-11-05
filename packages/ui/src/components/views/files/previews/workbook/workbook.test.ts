import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import init, { Model } from '@ironcalc/wasm';

import { formulaFromOpenDocument, formulaToOpenDocument, shiftFormula } from './formulaText';
import { cellKey } from './model';
import { cellInput, openWorkbookDocument, parseCellInput, sheetGrid, WorkbookSession } from './workbookSession';

await init({ module_or_path: readFileSync(new URL(import.meta.resolve('@ironcalc/wasm/wasm_bg.wasm'))) });
const loadModel = async () => Model;

const rels = (items: Array<{ id: string; target: string; type?: string }>) => `<Relationships>${items.map((item) => `<Relationship Id="${item.id}" Target="${item.target}" Type="${item.type ?? 'x'}"/>`).join('')}</Relationships>`;

const pack = (entries: Record<string, string>): Uint8Array<ArrayBuffer> => new Uint8Array(zipSync(Object.fromEntries(Object.entries(entries).map(([path, text]) => [path, strToU8(text)]))));

const xlsx = (sheet: string, extra: Record<string, string> = {}): Uint8Array<ArrayBuffer> => pack({
  '[Content_Types].xml': '<Types><Override PartName="/xl/calcChain.xml" ContentType="calc"/></Types>',
  'xl/workbook.xml': '<workbook xmlns:r="r"><sheets><sheet name="Data" r:id="rId1"/></sheets><calcPr calcId="1"/></workbook>',
  'xl/_rels/workbook.xml.rels': rels([{ id: 'rId1', target: 'worksheets/sheet1.xml' }, { id: 'rId2', target: 'calcChain.xml', type: 'x/calcChain' }]),
  'xl/calcChain.xml': '<calcChain/>',
  'xl/worksheets/sheet1.xml': `<worksheet><dimension ref="A1"/><sheetData>${sheet}</sheetData></worksheet>`,
  ...extra,
});

const open = async (bytes: Uint8Array<ArrayBuffer>, name = 'book.xlsx') => {
  const document = await openWorkbookDocument(name, bytes);
  if (!document) throw new Error('not a workbook');
  return new WorkbookSession(document, name, bytes, loadModel);
};

const entry = (bytes: Uint8Array, path: string) => strFromU8(unzipSync(bytes)[path]);
const shown = (session: WorkbookSession, row: number, column: number, sheet = 0) => session.document.sheets[sheet].cells.get(cellKey(row, column))?.display;
const edit = async (session: WorkbookSession, row: number, column: number, input: string) => {
  const outcome = await session.edit(0, row, column, input);
  if (outcome.status !== 'changed') throw new Error(outcome.status);
  return outcome;
};

describe('reading a workbook', () => {
  test('an empty styled cell does not take the next cell\'s place', async () => {
    const session = await open(xlsx('<row r="1"><c r="A1" s="1"/><c r="B1"><v>5</v></c></row><row r="2"/><row r="3"><c r="C3"><v>7</v></c></row>'));
    const grid = sheetGrid(session.document.sheets[0], 100, false);
    expect(grid.rows).toEqual([['', '5', ''], ['', '', ''], ['', '', '7']]);
    expect(grid.rowNumbers).toEqual([1, 2, 3]);
    expect(grid.totalRows).toBe(3);
  });

  test('shows numbers the way their cell format says, and keeps what it cannot apply', async () => {
    const styles = `<styleSheet>
      <numFmts><numFmt numFmtId="170" formatCode="&quot;due&quot; dd/mm/yyyy"/><numFmt numFmtId="171" formatCode="0.00E+00"/></numFmts>
      <cellXfs><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="10"/><xf numFmtId="170"/><xf numFmtId="4"/><xf numFmtId="20"/><xf numFmtId="171"/><xf numFmtId="46"/></cellXfs>
    </styleSheet>`;
    const session = await open(xlsx(`<row r="1">
      <c r="A1"><v>0.30000000000000004</v></c><c r="B1" s="1"><v>45231</v></c><c r="C1" s="2"><v>0.125</v></c>
      <c r="D1" s="3"><v>45231.5</v></c><c r="E1" s="4"><v>1234.5</v></c><c r="F1" s="5"><v>0.75</v></c>
      <c r="G1" s="6"><v>0.00123</v></c><c r="H1" s="7"><v>1.5</v></c>
    </row>`, { 'xl/styles.xml': styles }));
    expect(sheetGrid(session.document.sheets[0], 100, false).rows[0]).toEqual(['0.3', '2023-11-01', '12.50%', '2023-11-01', '1234.50', '18:00', '0.00123', '36:00:00']);
  });

  test('a crafted format code is not scanned', async () => {
    const session = await open(xlsx('<row r="1"><c r="A1" s="0"><v>5</v></c></row>', {
      'xl/styles.xml': `<styleSheet><numFmts><numFmt numFmtId="170" formatCode="${'['.repeat(2_000_000)}"/></numFmts><cellXfs><xf numFmtId="170"/></cellXfs></styleSheet>`,
    }));
    expect(shown(session, 1, 0)).toBe('5');
  }, 1_000);

  test('expands a shared formula, locks merged and table headings, and finds links', async () => {
    const session = await open(xlsx(`
      <row r="1"><c r="A1" t="inlineStr"><is><t>Head</t></is></c><c r="B1"><v>1</v></c></row>
      <row r="2"><c r="A2"><f t="shared" ref="A2:A3" si="0">B1*$B$1+"B1"</f><v>1</v></c></row>
      <row r="3"><c r="A3"><f t="shared" si="0"/><v>1</v></c></row>`, {
      'xl/worksheets/_rels/sheet1.xml.rels': rels([{ id: 'r1', target: 'https://example.com/x' }, { id: 'r2', target: '../tables/table1.xml', type: 'x/table' }]),
      'xl/worksheets/sheet1.xml': `<worksheet><sheetData>
        <row r="1"><c r="A1" t="inlineStr"><is><t>Head</t></is></c><c r="B1"><v>1</v></c></row>
        <row r="2"><c r="A2"><f t="shared" ref="A2:A3" si="0">B1*$B$1</f><v>1</v></c></row>
        <row r="3"><c r="A3"><f t="shared" si="0"/><v>1</v></c></row>
      </sheetData><mergeCells><mergeCell ref="C1:D1"/></mergeCells><hyperlinks><hyperlink ref="B1" r:id="r1"/></hyperlinks></worksheet>`,
      'xl/tables/table1.xml': '<table ref="A1:B3"/>',
    }));
    const sheet = session.document.sheets[0];
    expect(sheet.cells.get(cellKey(3, 0))?.formula).toBe('B2*$B$1');
    expect(sheet.cells.get(cellKey(1, 1))?.href).toBe('https://example.com/x');
    expect(session.isLocked(0, 1, 3)).toBe(true);
    expect(session.isLocked(0, 1, 2)).toBe(false);
    expect(session.isLocked(0, 1, 0)).toBe(true);
    expect(session.isLocked(0, 2, 0)).toBe(false);
  });

  test('a file that is not a workbook has no sheets', async () => {
    expect(await openWorkbookDocument('book.xlsx', pack({ 'other.xml': '<a/>' }))).toBeNull();
  });

  test('reports rows past the cap', async () => {
    const rows = Array.from({ length: 5 }, (_, index) => `<row r="${index * 3 + 1}"><c r="A${index * 3 + 1}"><v>${index}</v></c></row>`).join('');
    const session = await open(xlsx(rows));
    const grid = sheetGrid(session.document.sheets[0], 2, false);
    expect(grid.rows).toEqual([['0'], ['1']]);
    expect(grid.totalRows).toBe(5);
  });
});

describe('editing an xlsx', () => {
  test('changes the cell, leaves the rest byte for byte, and keeps its style', async () => {
    const bytes = xlsx('<row r="1" spans="1:3"><c r="A1" s="4"><v>1</v></c><c r="B1" t="s"><v>0</v></c></row>', {
      'xl/sharedStrings.xml': '<sst><si><t>keep</t></si></sst>',
      'xl/media/image1.png': 'PNG',
    });
    const session = await open(bytes);
    const outcome = await edit(session, 1, 0, 'hello <b>');
    const sheet = entry(outcome.bytes, 'xl/worksheets/sheet1.xml');
    expect(sheet).toContain('<c r="A1" s="4" t="inlineStr"><is><t xml:space="preserve">hello &lt;b&gt;</t></is></c>');
    expect(sheet).toContain('<c r="B1" t="s"><v>0</v></c>');
    expect(entry(outcome.bytes, 'xl/media/image1.png')).toBe('PNG');
    expect(entry(outcome.bytes, 'xl/sharedStrings.xml')).toContain('keep');
    expect(outcome.previous).toEqual({ kind: 'number', raw: '1', formula: undefined });
  });

  test('adds cells and rows in order and empties a cell without losing its style', async () => {
    const session = await open(xlsx('<row r="2"><c r="B2" s="7"><v>1</v></c><c r="D2"><v>2</v></c></row>'));
    await edit(session, 2, 2, '5');
    await edit(session, 1, 0, 'top');
    const { bytes } = await edit(session, 2, 1, '');
    const sheet = entry(bytes, 'xl/worksheets/sheet1.xml');
    expect(sheet.indexOf('r="A1"')).toBeLessThan(sheet.indexOf('r="B2"'));
    expect(sheet.indexOf('r="C2"')).toBeLessThan(sheet.indexOf('r="D2"'));
    expect(sheet).toContain('<c r="B2" s="7"/>');
    const reread = await open(bytes);
    expect(shown(reread, 2, 2)).toBe('5');
    expect(shown(reread, 2, 1)).toBeUndefined();
  });

  test('recalculates what depends on the edit, writes the results, and asks Excel to confirm them', async () => {
    const session = await open(xlsx(`
      <row r="1"><c r="A1"><v>2</v></c><c r="B1"><f>A1*10</f><v>20</v></c></row>
      <row r="2"><c r="A2"><f>B1+1</f><v>21</v></c></row>`));
    const { bytes } = await edit(session, 1, 0, '3');
    expect(shown(session, 1, 1)).toBe('30');
    expect(shown(session, 2, 0)).toBe('31');
    const sheet = entry(bytes, 'xl/worksheets/sheet1.xml');
    expect(sheet).toContain('<c r="B1"><f>A1*10</f><v>30</v></c>');
    expect(entry(bytes, 'xl/workbook.xml')).toContain('fullCalcOnLoad="1"');
    expect(Object.keys(unzipSync(bytes))).not.toContain('xl/calcChain.xml');
    expect(entry(bytes, '[Content_Types].xml')).not.toContain('calcChain');
    expect(entry(bytes, 'xl/_rels/workbook.xml.rels')).not.toContain('calcChain');
  });

  test('computes formulas the file stores without a result, and formats them', async () => {
    const session = await open(xlsx(`
      <row r="1"><c r="A1"><v>2</v></c><c r="B1"><f>A1*1.5</f><v></v></c><c r="C1" s="1"><f>A1/4</f></c></row>`, {
      'xl/styles.xml': '<styleSheet><cellXfs><xf numFmtId="0"/><xf numFmtId="10"/></cellXfs></styleSheet>',
    }));
    expect(shown(session, 1, 1)).toBe('');
    expect(await session.fillMissingResults()).toBe(true);
    expect(shown(session, 1, 1)).toBe('3');
    expect(shown(session, 1, 2)).toBe('50.00%');
    expect(session.unsupportedFormulas).toBe(0);
    expect(await session.fillMissingResults()).toBe(false);
    await edit(session, 1, 0, '4');
    expect(shown(session, 1, 1)).toBe('6');
  });

  test('takes a formula, normalises it, and shows its result', async () => {
    const session = await open(xlsx('<row r="1"><c r="A1"><v>2</v></c><c r="B1"><v>3</v></c></row>'));
    const { bytes } = await edit(session, 2, 0, '=sum(a1:b1)');
    expect(shown(session, 2, 0)).toBe('5');
    expect(entry(bytes, 'xl/worksheets/sheet1.xml')).toContain('<f>SUM(A1:B1)</f><v>5</v>');
    expect(cellInput(session.document.sheets[0].cells.get(cellKey(2, 0)))).toBe('=SUM(A1:B1)');
  });

  test('refuses a formula it cannot read and changes nothing', async () => {
    const session = await open(xlsx('<row r="1"><c r="A1"><f>1+1</f><v>2</v></c></row>'));
    expect((await session.edit(0, 1, 0, '=SUM(')).status).toBe('invalid-formula');
    expect(shown(session, 1, 0)).toBe('2');
  });

  test('editing inside a shared formula keeps the other cells working', async () => {
    const session = await open(xlsx(`
      <row r="1"><c r="A1"><v>1</v></c></row>
      <row r="2"><c r="A2"><f t="shared" ref="A2:A4" si="0">A1+1</f><v>2</v></c></row>
      <row r="3"><c r="A3"><f t="shared" si="0"/><v>3</v></c></row>
      <row r="4"><c r="A4"><f t="shared" si="0"/><v>4</v></c></row>`));
    const { bytes } = await edit(session, 2, 0, '10');
    const sheet = entry(bytes, 'xl/worksheets/sheet1.xml');
    expect(sheet).toContain('<f>A2+1</f><v>11</v>');
    expect(sheet).toContain('<f>A3+1</f><v>12</v>');
    expect(sheet).not.toContain('t="shared"');
  });

  test('a function the engine lacks keeps the result the file holds and is counted', async () => {
    const session = await open(xlsx('<row r="1"><c r="A1"><v>1</v></c><c r="B1"><f>WEBSERVICE("x")+A1</f><v>9</v></c></row>'));
    const { bytes } = await edit(session, 1, 0, '2');
    expect(shown(session, 1, 1)).toBe('9');
    expect(entry(bytes, 'xl/worksheets/sheet1.xml')).toContain('<v>9</v>');
    expect(session.unsupportedFormulas).toBe(1);
  });

  test('text that looks like a number stays text for the formulas around it', async () => {
    const session = await open(xlsx('<row r="1"><c r="A1" t="inlineStr"><is><t>00123</t></is></c><c r="B1"><f>LEN(A1)</f><v>5</v></c><c r="C1"><v>1</v></c></row>'));
    await edit(session, 1, 2, '2');
    expect(shown(session, 1, 1)).toBe('5');
  });

  test('a date cell takes a date, and a number keeps being a number', async () => {
    const session = await open(xlsx('<row r="1"><c r="A1" s="1"><v>45231</v></c></row>', {
      'xl/styles.xml': '<styleSheet><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>',
    }));
    expect(cellInput(session.document.sheets[0].cells.get(cellKey(1, 0)))).toBe('2023-11-01');
    await edit(session, 1, 0, '2024-02-29');
    expect(shown(session, 1, 0)).toBe('2024-02-29');
    expect(session.document.sheets[0].cells.get(cellKey(1, 0))?.raw).toBe('45351');
  });

  test('edits a sheet written under a namespace prefix and loses nothing', async () => {
    const session = await open(xlsx('', {
      'xl/workbook.xml': '<x:workbook xmlns:x="m" xmlns:r="r"><x:sheets><x:sheet name="Data" r:id="rId1"/></x:sheets></x:workbook>',
      'xl/worksheets/sheet1.xml': '<x:worksheet xmlns="m" xmlns:x="m"><x:sheetData><x:row r="1"><x:c r="A1"><x:v>1</x:v></x:c><x:c r="B1"><x:v>2</x:v></x:c></x:row><x:row r="2"><x:c r="A2"><x:v>3</x:v></x:c></x:row></x:sheetData></x:worksheet>',
    }));
    const { bytes } = await edit(session, 1, 0, '9');
    const reread = await open(bytes);
    expect(sheetGrid(reread.document.sheets[0], 100, false).rows).toEqual([['9', '2'], ['3', '']]);
  });

  test('a write that loses another cell never reaches the caller', async () => {
    const session = await open(xlsx('<row r="1"><c r="A1"><v>1</v></c><c r="B1"><v>2</v></c></row>'));
    const write = session.document.write;
    session.document.write = async (changes) => {
      await write(changes);
      return xlsx('<row r="1"><c r="A1"><v>9</v></c></row>');
    };
    await expect(session.edit(0, 1, 0, '9')).rejects.toThrow('did not read back');
    expect(shown(session, 1, 1)).toBe('2');
  });

  test('undo puts text back as text', async () => {
    const session = await open(xlsx('<row r="1"><c r="A1" t="inlineStr"><is><t>00123</t></is></c></row>'));
    const outcome = await edit(session, 1, 0, 'hello');
    const back = await session.restore(0, 1, 0, outcome.status === 'changed' ? outcome.previous : null);
    expect(back.status).toBe('changed');
    const cell = session.document.sheets[0].cells.get(cellKey(1, 0));
    expect([cell?.kind, cell?.raw]).toEqual(['text', '00123']);
  });

  test('parses what is typed the way a spreadsheet does', () => {
    expect(parseCellInput('12%', undefined, false)).toEqual({ kind: 'number', raw: '0.12' });
    expect(parseCellInput('true', undefined, false)).toEqual({ kind: 'boolean', raw: 'TRUE' });
    expect(parseCellInput('1e3', undefined, false)).toEqual({ kind: 'number', raw: '1000' });
    expect(parseCellInput('a b', undefined, false)).toEqual({ kind: 'text', raw: 'a b' });
    expect(parseCellInput('', undefined, false)).toBeNull();
  });
});

describe('ODS', () => {
  const ods = (table: string) => pack({
    mimetype: 'application/vnd.oasis.opendocument.spreadsheet',
    'content.xml': `<office:document-content><table:table table:name="Budget">${table}</table:table></office:document-content>`,
    'styles.xml': '<keep/>',
  });

  test('expands repeats with values and skips the padding', async () => {
    const session = await open(ods(`
      <table:table-row table:number-rows-repeated="2"><table:table-cell table:number-columns-repeated="1024"/></table:table-row>
      <table:table-row>
        <table:table-cell table:number-columns-repeated="2"/>
        <table:table-cell office:value-type="string"><text:p>A&amp;B</text:p></table:table-cell>
        <table:covered-table-cell/>
        <table:table-cell table:number-columns-repeated="2" office:value-type="float" office:value="7"><text:p>7</text:p></table:table-cell>
        <table:table-cell table:number-columns-repeated="1000000"/>
      </table:table-row>
      <table:table-row table:number-rows-repeated="1048000"><table:table-cell table:number-columns-repeated="1024"/></table:table-row>`), 'book.ods');
    const grid = sheetGrid(session.document.sheets[0], 100, false);
    expect(grid.rows[2]).toEqual(['', '', 'A&B', '', '7', '7']);
    expect(session.isLocked(0, 3, 3)).toBe(true);
  });

  test('a blank run with an absurd repeat stays bounded, and repeated rows past the bound still count', async () => {
    const session = await open(ods(`
      <table:table-row><table:table-cell table:number-columns-repeated="4294967296"/><table:table-cell office:value-type="string"><text:p>far</text:p></table:table-cell></table:table-row>
      <table:table-row table:number-rows-repeated="3000"><table:table-cell office:value-type="string"><text:p>x</text:p></table:table-cell></table:table-row>`), 'book.ods');
    expect(session.document.sheets[0].cells.size).toBe(1_000);
  });

  test('edits inside a repeated run, keeps the styles and the mimetype, and recalculates', async () => {
    const session = await open(ods(`
      <table:table-row table:style-name="ro1">
        <table:table-cell table:style-name="ce1" table:number-columns-repeated="3" office:value-type="float" office:value="2"><text:p>2</text:p></table:table-cell>
        <table:table-cell table:formula="of:=SUM([.A1:.C1])" office:value-type="float" office:value="6"><text:p>6</text:p></table:table-cell>
      </table:table-row>
      <table:table-row table:number-rows-repeated="1000"><table:table-cell/></table:table-row>`), 'book.ods');
    const { bytes } = await edit(session, 1, 1, '5');
    expect(shown(session, 1, 3)).toBe('9');
    const content = entry(bytes, 'content.xml');
    expect(content).toContain('table:style-name="ce1" office:value-type="float" office:value="5"');
    expect(content).toContain('table:formula="of:=SUM([.A1:.C1])"');
    expect(content).toContain('<text:p>9</text:p>');
    expect(entry(bytes, 'styles.xml')).toBe('<keep/>');
    expect(Object.keys(unzipSync(bytes))[0]).toBe('mimetype');
    const reread = await open(bytes, 'book.ods');
    expect(sheetGrid(reread.document.sheets[0], 100, false).rows[0]).toEqual(['2', '5', '2', '9']);
    await edit(session, 3, 2, 'new');
    expect(shown(session, 3, 2)).toBe('new');
  });

  test('splits a repeat written with single quotes and keeps its neighbours', async () => {
    const session = await open(ods("<table:table-row table:number-rows-repeated='3'><table:table-cell table:number-columns-repeated='2' office:value-type='float' office:value='1'><text:p>1</text:p></table:table-cell></table:table-row>"), 'book.ods');
    const { bytes } = await edit(session, 1, 0, '5');
    const reread = await open(bytes, 'book.ods');
    expect(sheetGrid(reread.document.sheets[0], 100, false).rows).toEqual([['5', '1'], ['1', '1'], ['1', '1']]);
  });

  test('takes a formula and stores it the ODF way', async () => {
    const session = await open(ods('<table:table-row><table:table-cell office:value-type="float" office:value="4"><text:p>4</text:p></table:table-cell></table:table-row>'), 'book.ods');
    const { bytes } = await edit(session, 2, 0, '=A1*2');
    expect(entry(bytes, 'content.xml')).toContain('table:formula="of:=[.A1]*2"');
    expect(shown(session, 2, 0)).toBe('8');
  });
});

describe('formula text', () => {
  test('moves relative references and nothing else', () => {
    expect(shiftFormula('A1+$B$2+C$3+"A1"+\'Q1\'!D4+SUM(E:E)+LOG10(F5)', 2, 1)).toBe('B3+$B$2+D$3+"A1"+\'Q1\'!E6+SUM(F:F)+LOG10(G7)');
  });

  test('turns ODF formulas into Excel ones and back', () => {
    expect(formulaFromOpenDocument('of:=SUM([.A1:.B2];[$Sheet2.C3])&";"')).toBe('SUM(A1:B2,Sheet2!C3)&";"');
    expect(formulaToOpenDocument('SUM(A1:B2,Sheet2!C3)&","')).toBe('of:=SUM([.A1:.B2];[$Sheet2.C3])&","');
  });
});
