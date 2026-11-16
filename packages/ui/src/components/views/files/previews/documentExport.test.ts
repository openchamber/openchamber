import { describe, expect, test } from 'bun:test';
import { strFromU8, unzipSync } from 'fflate';

import { markdownToDocx, markdownToPrintableHtml, rowsToXlsx } from './documentExport';
import { extractDocumentAttachments } from '@/sync/document-attachments';
import { openWorkbookDocument, sheetGrid } from './workbook/workbookSession';

describe('exporting', () => {
  const source = '# Title\n\nSome **bold** & `code`.\n\n- one\n- two\n\n| A | B |\n| --- | --- |\n| 1 | <x> |\n';

  test('Word holds the text, and our own reader takes it back', async () => {
    const bytes = await markdownToDocx(source);
    expect(strFromU8(unzipSync(bytes)['word/document.xml'])).toContain('<w:pStyle w:val="Heading1"/>');
    const text = await (await extractDocumentAttachments(new File([bytes], 'a.docx')))?.textFile.text();
    expect(text).toContain('Title');
    expect(text).toContain('Some bold & code.');
    expect(text).toContain('<x>');
  });

  test('the printable page escapes what the file says', () => {
    const html = markdownToPrintableHtml('a <script>x</script>\n\n`<b>`', 'T');
    expect(html).not.toContain('<script>');
    expect(html).toContain('<code>&lt;b&gt;</code>');
  });

  test('a table becomes a workbook, numbers as numbers', async () => {
    const document = await openWorkbookDocument('a.xlsx', await rowsToXlsx('Data', [['name', 'age'], ['Ada', '36'], ['00', '']]));
    const sheet = document?.sheets[0];
    if (!sheet) throw new Error('no sheet');
    expect(sheetGrid(sheet, 10, false).rows).toEqual([['name', 'age'], ['Ada', '36'], ['00', '']]);
    expect(sheet.cells.get('2:1')?.kind).toBe('number');
  });
});
