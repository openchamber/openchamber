import React from 'react';
import { PierreDiffViewer } from '@/components/views/PierreDiffViewer';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { fileDiffFromPatch, isBinaryPatch } from '@/lib/diff/patchFileDiff';
import { getGitRangeDiff, getGitRangeFiles } from '@/lib/gitApi';
import type { GitRangeFileEntry } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';
import type { FixLoopApproval } from '@/lib/prFixLoop';
import { getLanguageFromExtension } from '@/lib/toolHelpers';

type Files = { readonly state: 'loading' } | { readonly state: 'failed' } | { readonly state: 'ready'; readonly files: readonly GitRangeFileEntry[] };
type Patch = { readonly state: 'loading' } | { readonly state: 'failed' } | { readonly state: 'nontext' }
  | { readonly state: 'ready'; readonly diff: ReturnType<typeof fileDiffFromPatch> };

/** Reads only the two immutable objects named by this host receipt. */
export function PrFixLoopReceiptDiff({ directory, receipt }: { readonly directory: string; readonly receipt: FixLoopApproval }) {
  const { t } = useI18n();
  const [files, setFiles] = React.useState<Files>({ state: 'loading' });
  const [path, setPath] = React.useState('');
  const [patch, setPatch] = React.useState<Patch>({ state: 'loading' });
  const [revision, setRevision] = React.useState(0);
  React.useEffect(() => {
    let current = true;
    setFiles({ state: 'loading' });
    getGitRangeFiles(directory, { base: receipt.destination.expectedHead, head: receipt.commit, includeWorkingTree: false }).then(
      (answer) => { if (current) { setFiles({ state: 'ready', files: answer }); setPath((value) => answer.some((file) => file.path === value) ? value : answer[0]?.path ?? ''); } },
      () => { if (current) setFiles({ state: 'failed' }); },
    );
    return () => { current = false; };
  }, [directory, receipt.commit, receipt.destination.expectedHead, revision]);
  React.useEffect(() => {
    if (!path) return;
    let current = true;
    setPatch({ state: 'loading' });
    getGitRangeDiff(directory, { base: receipt.destination.expectedHead, head: receipt.commit, path, includeWorkingTree: false })
      .then((answer) => {
        if (current) setPatch(!answer.diff.trim() || isBinaryPatch(answer.diff) ? { state: 'nontext' } : { state: 'ready', diff: fileDiffFromPatch(path, answer.diff) });
      }).catch((error) => { if (!(error instanceof Error)) throw error; if (current) setPatch({ state: 'failed' }); });
    return () => { current = false; };
  }, [directory, path, receipt.commit, receipt.destination.expectedHead, revision]);
  if (files.state === 'loading') return <p role="status" className="typography-meta text-muted-foreground">{t('prFixLoop.loading')}</p>;
  if (files.state === 'failed') return <div role="alert" className="space-y-2">
    <p className="typography-meta text-status-error">{t('prFixLoop.approval.diffFailed')}</p>
    <Button size="sm" variant="outline" onClick={() => setRevision((value) => value + 1)}>{t('prFixLoop.action.retry')}</Button>
  </div>;
  return <div className="min-w-0 space-y-3">
    {files.files.length ? <Select value={path} onValueChange={(value) => { if (value) { setPatch({ state: 'loading' }); setPath(value); } }}>
      <SelectTrigger aria-label={t('prFixLoop.approval.files')}><SelectValue>{path}</SelectValue></SelectTrigger>
      <SelectContent>{files.files.map((file) => <SelectItem key={file.path} value={file.path}><span dir="ltr" className="truncate font-mono">{file.path}</span></SelectItem>)}</SelectContent>
    </Select> : <p className="typography-meta text-muted-foreground">{t('prFixLoop.approval.noPatch')}</p>}
    {path && patch.state === 'loading' ? <p role="status" className="typography-meta text-muted-foreground">{t('prFixLoop.loading')}</p> : null}
    {path && patch.state === 'failed' ? <div role="alert" className="space-y-2"><p className="typography-meta text-status-error">{t('prFixLoop.approval.diffFailed')}</p>
      <Button size="sm" variant="outline" onClick={() => setRevision((value) => value + 1)}>{t('prFixLoop.action.retry')}</Button>
    </div> : null}
    {path && patch.state === 'nontext' ? <p className="typography-meta text-muted-foreground">{t('prFixLoop.approval.noPatch')}</p> : null}
    {path && patch.state === 'ready' ? <div dir="ltr" className="min-w-0">
      <PierreDiffViewer original="" modified="" fileDiff={patch.diff} language={getLanguageFromExtension(path) ?? 'text'} fileName={path}
        renderSideBySide={false} wrapLines enableComments={false} layout="inline" />
    </div> : null}
  </div>;
}
