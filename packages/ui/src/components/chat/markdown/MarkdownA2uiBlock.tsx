import type { CustomRendererProps } from 'streamdown';
import { useA2uiSurfaceComponent, useReplyA2uiBlockComponent } from '../a2ui/useA2uiComponent';
import { useMarkdownPresentation } from './MarkdownPresentationContext';

export function MarkdownA2uiBlock(props: CustomRendererProps) {
  const { purpose } = useMarkdownPresentation();
  return purpose === 'image' ? <ImageA2uiBlock {...props} /> : <ReplyMarkdownA2uiBlock {...props} />;
}

function ImageA2uiBlock({ code, isIncomplete }: CustomRendererProps) {
  const A2uiSurface = useA2uiSurfaceComponent();
  if (!A2uiSurface) return <pre dir="ltr"><code>{code}</code></pre>;
  return <A2uiSurface source={code} complete={!isIncomplete} />;
}

function ReplyMarkdownA2uiBlock({ code, isIncomplete }: CustomRendererProps) {
  const { settledReply, directory } = useMarkdownPresentation();
  const ReplyA2uiBlock = useReplyA2uiBlockComponent();
  if (!ReplyA2uiBlock) return <pre dir="ltr"><code>{code}</code></pre>;
  return <ReplyA2uiBlock code={code} complete={!isIncomplete} reply={settledReply} directory={directory ?? ''} />;
}
