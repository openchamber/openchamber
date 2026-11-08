import { PlainDiffFallback } from '../message/parts/PlainDiffFallback';
import ToolPartDiffPreview from '../message/parts/ToolPartDiffPreview';
import { getDiffPatchEntries } from '../message/parts/toolDiffUtils';

export default function MarkdownDiffPreview({ source }: { source: string }) {
  // Models also propose +/- snippets without file or hunk headers. Supply
  // parser-only coordinates; copying always uses the unmodified fence source.
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const snippet = lines.some((line) => /^[+-]/.test(line))
    && lines.every((line) => /^[ +-]/.test(line))
    && !lines.some((line) => /^(---|\+\+\+) /.test(line));
  const patch = snippet
    ? `@@ -1,${lines.filter((line) => !line.startsWith('+')).length} +1,${lines.filter((line) => !line.startsWith('-')).length} @@\n${source}`
    : source;
  const entries = getDiffPatchEntries(undefined, patch, (path) => path);
  if (entries.length === 0 || entries.some((entry) => entry.renderMode !== 'diff')) {
    return <PlainDiffFallback diff={source} />;
  }
  return entries.map((entry) => (
    <div key={entry.id}>
      {entry.title !== 'Diff' && <div className="px-3 py-1 typography-meta text-muted-foreground break-all">{entry.title}</div>}
      <ToolPartDiffPreview diff={entry.patch} diffViewMode="unified" />
    </div>
  ));
}
