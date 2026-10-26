import type { Frontmatter, FrontmatterValue } from './frontmatter';

const CODE_CLASS = 'oc-surface-code m-0 whitespace-pre-wrap break-words font-mono text-[0.95em]';

const PropertyValue = ({ value }: { value: FrontmatterValue }) => {
  if (value.kind === 'list') {
    return (
      <span className="flex flex-wrap gap-1">
        {value.items.map((item, index) => (
          <span key={index} dir="auto" className="rounded-full bg-[var(--surface-subtle)] px-2 py-px">{item}</span>
        ))}
      </span>
    );
  }
  if (value.kind === 'code') return <pre dir="ltr" className={CODE_CLASS}>{value.text}</pre>;
  return <span dir="auto" className="whitespace-pre-wrap">{value.text}</span>;
};

/** A document's frontmatter above its rendered body: a property table, or the block as written when it is not a YAML mapping. */
export const FrontmatterProperties = ({ frontmatter }: { frontmatter: Frontmatter }) => {
  if (frontmatter.kind === 'raw') {
    return (
      <pre dir="ltr" className={`${CODE_CLASS} mb-4 rounded-lg border border-[var(--interactive-border)] bg-[var(--syntax-background)] px-3 py-2.5 typography-meta`}>
        {frontmatter.text}
      </pre>
    );
  }
  return (
    <dl className="mb-4 grid grid-cols-[fit-content(40%)_minmax(0,1fr)] items-baseline gap-x-4 gap-y-1.5 rounded-lg border border-[var(--interactive-border)] px-3 py-2.5 typography-meta">
      {frontmatter.properties.map(({ key, value }, index) => (
        <div key={index} className="contents">
          <dt dir="auto" className="oc-ui-start-align break-words text-muted-foreground">{key}</dt>
          <dd className="m-0 min-w-0 break-words text-foreground"><PropertyValue value={value} /></dd>
        </div>
      ))}
    </dl>
  );
};
