import type { CustomRendererProps } from 'streamdown';
import { useReplyUiBlockComponent } from '../uiBlocks/useUiBlockComponent';
import { useMarkdownPresentation } from './MarkdownPresentationContext';

/**
 * `openui-lang` fences of an assistant reply. The block and the answer it
 * collects load with the first one (`ReplyUiBlock`); until then, or when
 * loading failed, the fence shows as code.
 */
export function MarkdownUiBlock({ code, isIncomplete }: CustomRendererProps) {
  const { uiBlockReply, directory } = useMarkdownPresentation();
  const ReplyUiBlock = useReplyUiBlockComponent();
  if (!ReplyUiBlock) return <pre dir="ltr"><code>{code}</code></pre>;
  return <ReplyUiBlock code={code} complete={!isIncomplete} reply={uiBlockReply} directory={directory ?? ''} />;
}
