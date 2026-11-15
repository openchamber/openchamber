import type { CustomRendererProps } from 'streamdown';
import { useReplyUiBlockComponent, useUiBlockComponent } from '../uiBlocks/useUiBlockComponent';
import { useMarkdownPresentation } from './MarkdownPresentationContext';

/**
 * `openui-lang` fences of an assistant reply. The block and the answer it
 * collects load with the first one (`ReplyUiBlock`); until then, or when
 * loading failed, the fence shows as code.
 */
export function MarkdownUiBlock(props: CustomRendererProps) {
  const { purpose } = useMarkdownPresentation();
  return purpose === 'image' ? <ImageUiBlock {...props} /> : <ReplyMarkdownUiBlock {...props} />;
}

function ImageUiBlock({ code, isIncomplete }: CustomRendererProps) {
  const UiBlock = useUiBlockComponent();
  if (!UiBlock) return <pre dir="ltr"><code>{code}</code></pre>;
  return <UiBlock source={code} complete={!isIncomplete} />;
}

function ReplyMarkdownUiBlock({ code, isIncomplete }: CustomRendererProps) {
  const { settledReply, directory } = useMarkdownPresentation();
  const ReplyUiBlock = useReplyUiBlockComponent();
  if (!ReplyUiBlock) return <pre dir="ltr"><code>{code}</code></pre>;
  return <ReplyUiBlock code={code} complete={!isIncomplete} reply={settledReply} directory={directory ?? ''} />;
}
