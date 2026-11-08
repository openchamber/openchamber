import { useOnDemandComponent } from '@/hooks/useOnDemandComponent';
import { PlainDiffFallback } from '../message/parts/PlainDiffFallback';
import { isToolDiffPreviewOversized } from '../message/parts/toolDiffPreview';

const loadPreview = () => import('./MarkdownDiffPreview').then((module) => module.default);
const keepSource = () => {};

export function MarkdownDiff({ source, incomplete }: { source: string; incomplete: boolean }) {
  // Parse only settled, bounded patches. Streaming source remains readable and
  // ordinary Markdown never loads the diff rendering stack.
  const rich = !incomplete && !isToolDiffPreviewOversized(source);
  const Preview = useOnDemandComponent(rich, loadPreview, keepSource);
  return (
    <div data-streamdown="code-block-body" data-language="diff">
      {rich && Preview ? <Preview source={source} /> : <PlainDiffFallback diff={source} />}
    </div>
  );
}
