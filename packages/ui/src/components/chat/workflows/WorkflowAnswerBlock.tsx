import React from 'react';

import { SimpleMarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { JsonNode, WorkflowAnswer } from '@/lib/workflows/model';

const isRecord = (node: JsonNode): node is Extract<JsonNode, { kind: 'record' }> => node.kind === 'record';

const Scalar: React.FC<{ node: Extract<JsonNode, { kind: 'scalar' }> }> = ({ node }) => (
  <span
    dir="auto"
    className={cn('whitespace-pre-wrap break-words', node.tone === 'string' ? 'text-foreground' : 'font-mono text-muted-foreground')}
  >
    {node.text}
  </span>
);

/** Fields of a record: short values beside their name, long or nested ones under it. */
const RecordFields: React.FC<{ node: Extract<JsonNode, { kind: 'record' }> }> = ({ node }) => (
  <dl className="flex flex-col gap-1.5">
    {node.entries.map(([key, value]) => {
      const inline = value.kind === 'scalar' && value.text.length <= 60 && !value.text.includes('\n');
      return (
        <div key={key} className={cn('min-w-0', inline ? 'flex items-baseline gap-2' : 'flex flex-col gap-0.5')}>
          <dt className="shrink-0 typography-micro text-muted-foreground" dir="ltr">{key}</dt>
          <dd className="min-w-0 typography-meta"><JsonTree node={value} /></dd>
        </div>
      );
    })}
  </dl>
);

const JsonTree: React.FC<{ node: JsonNode }> = ({ node }) => {
  if (node.kind === 'scalar') return <Scalar node={node} />;
  if (node.kind === 'record') return <RecordFields node={node} />;
  if (node.items.length === 0) return <span className="font-mono text-muted-foreground">[]</span>;
  // A list of records, such as findings, reads as one card per record.
  if (node.items.every(isRecord)) {
    return (
      <div className="flex flex-col gap-1.5">
        {node.items.map((item, index) => (
          // A step above whatever holds the answer (the agent row's tile, the panel), never a card in a card.
          <div key={index} className="oc-tile-inset rounded-lg px-3 py-2">
            <JsonTree node={item} />
          </div>
        ))}
      </div>
    );
  }
  return (
    <ul className="flex list-disc flex-col gap-0.5 ps-4">
      {node.items.map((item, index) => (
        <li key={index} className="typography-meta"><JsonTree node={item} /></li>
      ))}
    </ul>
  );
};

/**
 * An answer as the agent or script gave it: text as markdown; a JSON value
 * laid out as fields and cards, with the JSON itself one click away.
 */
export const WorkflowAnswerBlock: React.FC<{ answer: WorkflowAnswer }> = ({ answer }) => {
  const { t } = useI18n();
  const [raw, setRaw] = React.useState(false);
  if (answer.kind === 'text') {
    return <SimpleMarkdownRenderer content={answer.text} singleTilde={false} className="typography-markdown-body" enableFileReferences={false} />;
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => setRaw((current) => !current)}
          aria-pressed={raw}
          className="typography-micro text-muted-foreground hover:text-foreground"
        >
          {raw ? t('workflows.panel.answer.formatted') : t('workflows.panel.answer.raw')}
        </button>
      </div>
      {raw ? (
        <pre dir="ltr" className="overflow-x-auto whitespace-pre-wrap break-words font-mono typography-meta text-foreground">
          {JSON.stringify(answer.value, null, 2)}
        </pre>
      ) : (
        <JsonTree node={answer.tree} />
      )}
    </div>
  );
};
