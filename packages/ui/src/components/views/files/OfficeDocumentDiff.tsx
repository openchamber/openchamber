import React from 'react';

import { ContentLoadingState, ContentState } from '@/components/ui/content-state';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { getFileExtension } from '@/lib/toolHelpers';
import { extractDocumentAttachments } from '@/sync/document-attachments';
import { DOCUMENT_DATA_URL } from './documentVersions';
import { diffWorkbooks, type SheetDifference } from './previews/workbook/workbookDiff';
import { openWorkbookDocument } from './previews/workbook/workbookSession';

const MAX_SHOWN_CELLS = 2_000;

const bytesOf = (dataUrl: string): Uint8Array<ArrayBuffer> | null => {
  if (!dataUrl) return null;
  return Uint8Array.from(atob(dataUrl.replace(DOCUMENT_DATA_URL, '')), (character) => character.charCodeAt(0));
};

const documentText = async (name: string, bytes: Uint8Array<ArrayBuffer> | null): Promise<string> => {
  if (!bytes) return '';
  const extracted = await extractDocumentAttachments(new File([bytes], name));
  return (await extracted?.textFile.text()) ?? '';
};

type Comparison =
  | { kind: 'loading' }
  | { kind: 'failed' }
  | { kind: 'sheets'; sheets: SheetDifference[] }
  | { kind: 'text'; original: string; modified: string };

const compare = async (filePath: string, original: string, modified: string): Promise<Comparison> => {
  const before = bytesOf(original);
  const after = bytesOf(modified);
  const name = filePath.split(/[/\\]/).pop() ?? filePath;
  const extension = getFileExtension(filePath);
  if (extension === 'xlsx' || extension === 'ods') {
    const [left, right] = await Promise.all([
      before ? openWorkbookDocument(name, before) : null,
      after ? openWorkbookDocument(name, after) : null,
    ]);
    return { kind: 'sheets', sheets: diffWorkbooks(left, right) };
  }
  const [left, right] = await Promise.all([documentText(name, before), documentText(name, after)]);
  return { kind: 'text', original: left, modified: right };
};

const SheetChanges: React.FC<{ sheet: SheetDifference; showName: boolean }> = ({ sheet, showName }) => {
  const { t } = useI18n();
  const shown = sheet.cells.slice(0, MAX_SHOWN_CELLS);
  return (
    <section className="flex min-w-0 flex-col gap-1">
      {showName ? <h3 className="typography-ui-label text-foreground">{sheet.name}</h3> : null}
      {sheet.status !== 'changed' ? (
        <p className="typography-meta text-muted-foreground">
          {t(sheet.status === 'added' ? 'diffView.document.sheetAdded' : 'diffView.document.sheetRemoved')}
        </p>
      ) : null}
      <div className="overflow-x-auto">
        <table className="w-full border-separate border-spacing-0 font-mono typography-meta">
          <thead>
            <tr>
              <th scope="col" className="w-16 border-b border-edge-muted px-2 py-1 text-start font-medium text-muted-foreground">{t('diffView.document.cell')}</th>
              <th scope="col" className="border-b border-edge-muted px-2 py-1 text-start font-medium text-muted-foreground">{t('diffView.document.before')}</th>
              <th scope="col" className="border-b border-edge-muted px-2 py-1 text-start font-medium text-muted-foreground">{t('diffView.document.after')}</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((cell) => (
              <tr key={cell.reference}>
                <td className="border-b border-edge-muted px-2 py-1 text-muted-foreground">{cell.reference}</td>
                <td className="break-words border-b border-edge-muted bg-[color-mix(in_srgb,var(--status-error)_10%,transparent)] px-2 py-1 text-foreground">{cell.before}</td>
                <td className="break-words border-b border-edge-muted bg-[color-mix(in_srgb,var(--status-success)_10%,transparent)] px-2 py-1 text-foreground">{cell.after}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {sheet.cells.length > shown.length ? (
        <p className="typography-meta text-muted-foreground">{t('diffView.document.truncated', { shown: shown.length, total: sheet.cells.length })}</p>
      ) : null}
    </section>
  );
};

/**
 * Two versions of an office document. A workbook lists its changed cells;
 * text documents compare their text in the regular diff, so line comments work
 * there too. Layout changes do not show: only the content is read.
 */
export const OfficeDocumentDiff: React.FC<{
  filePath: string;
  original: string;
  modified: string;
  renderText: (text: { original: string; modified: string }) => React.ReactNode;
}> = ({ filePath, original, modified, renderText }) => {
  const { t } = useI18n();
  const [result, setResult] = React.useState<Comparison>({ kind: 'loading' });

  React.useEffect(() => {
    let current = true;
    setResult({ kind: 'loading' });
    compare(filePath, original, modified)
      .then((next) => {
        if (current) setResult(next);
      })
      .catch(() => {
        if (current) setResult({ kind: 'failed' });
      });
    return () => {
      current = false;
    };
  }, [filePath, original, modified]);

  if (result.kind === 'loading') return <ContentLoadingState label={t('diffView.state.loadingDiff')} />;
  if (result.kind === 'failed') {
    return <ContentState icon={<Icon name="error-warning" className="size-8 text-[color:var(--status-error)]" />} title={t('diffView.document.failed')} />;
  }
  if (result.kind === 'text') {
    if (result.original === result.modified) return <ContentState title={t('diffView.document.noContentChange')} />;
    return renderText(result);
  }
  if (result.sheets.length === 0) return <ContentState title={t('diffView.document.noContentChange')} />;
  return (
    <div className="flex w-full flex-col gap-4 p-3">
      {result.sheets.map((sheet) => <SheetChanges key={sheet.name} sheet={sheet} showName={result.sheets.length > 1 || sheet.status !== 'changed'} />)}
    </div>
  );
};
