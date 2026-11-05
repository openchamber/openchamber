import React from 'react';
import { z } from 'zod';

import { SimpleMarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { ContentState } from '@/components/ui/content-state';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { useI18n } from '@/lib/i18n';
import { ArtifactMetaBar } from './ArtifactMetaBar';
import { formatArtifactSize } from './artifactMeta';
import { officeFrameDocument } from './officeFrame';

const text = z.union([z.string(), z.array(z.string())]).transform((value) => (Array.isArray(value) ? value.join('') : value));
const output = z.object({
  output_type: z.string(),
  text: text.optional(),
  // A value that is not text, such as a widget's JSON, has nothing to draw here.
  data: z.record(z.string(), text.catch('')).optional(),
  ename: z.string().optional(),
  evalue: z.string().optional(),
  traceback: z.array(z.string()).optional(),
});
const notebook = z.object({
  cells: z.array(z.object({
    cell_type: z.string(),
    source: text,
    outputs: z.array(output).optional(),
    execution_count: z.number().nullable().optional(),
  })),
  metadata: z.object({ language_info: z.object({ name: z.string().optional() }).optional() }).optional(),
});

type Output = z.infer<typeof output>;

const stripAnsi = (value: string): string => value.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, 'g'), '');

const OutputBlock: React.FC<{ value: Output }> = ({ value }) => {
  if (value.output_type === 'error') {
    return <pre className="overflow-x-auto whitespace-pre-wrap font-mono typography-meta text-[color:var(--status-error)]">{stripAnsi((value.traceback ?? [`${value.ename}: ${value.evalue}`]).join('\n'))}</pre>;
  }
  if (value.text !== undefined) return <pre className="overflow-x-auto whitespace-pre-wrap font-mono typography-meta text-foreground">{stripAnsi(value.text)}</pre>;
  const data = value.data ?? {};
  const image = data['image/png'] || data['image/jpeg'];
  if (image) return <img alt="" className="max-w-full bg-white" src={`data:${data['image/png'] ? 'image/png' : 'image/jpeg'};base64,${image.replace(/\s/g, '')}`} />;
  const html = data['text/html'];
  // Output is the notebook's own HTML, so it stays in the frame office documents use.
  if (html) return <iframe title="output" sandbox="allow-scripts" srcDoc={officeFrameDocument(html)} className="h-64 w-full rounded bg-white" />;
  return <pre className="overflow-x-auto whitespace-pre-wrap font-mono typography-meta text-foreground">{stripAnsi(data['text/plain'] ?? '')}</pre>;
};

/** A Jupyter notebook as its cells and saved outputs. Nothing runs: this shows what the file holds. */
export const NotebookArtifact: React.FC<{ content: string; sizeBytes: number | null }> = ({ content, sizeBytes }) => {
  const { t } = useI18n();
  const parsed = React.useMemo(() => {
    try {
      return notebook.parse(JSON.parse(content));
    } catch {
      return null;
    }
  }, [content]);
  if (!parsed) return <ContentState title={t('filesView.artifact.notebook.unreadable')} />;
  const language = parsed.metadata?.language_info?.name ?? 'python';
  return (
    <div className="flex h-full min-h-0 flex-col">
      <ArtifactMetaBar items={[t('filesView.artifact.notebook.cells', { count: parsed.cells.length }), formatArtifactSize(sizeBytes)]} />
      <ScrollableOverlay outerClassName="min-h-0 flex-1">
        <div className="flex min-w-0 flex-col gap-3 p-3">
          {parsed.cells.map((cell, index) => (
            <section key={index} className="flex min-w-0 flex-col gap-2">
              {cell.cell_type === 'markdown' ? (
                <SimpleMarkdownRenderer content={cell.source} className="typography-markdown-body" enableFileReferences={false} />
              ) : (
                <SimpleMarkdownRenderer content={`\`\`\`${cell.cell_type === 'code' ? language : 'text'}\n${cell.source}\n\`\`\``} enableFileReferences={false} />
              )}
              {(cell.outputs ?? []).map((value, outputIndex) => <OutputBlock key={outputIndex} value={value} />)}
            </section>
          ))}
        </div>
      </ScrollableOverlay>
    </div>
  );
};
