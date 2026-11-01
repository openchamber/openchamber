import React from 'react';
import { Block, type BlockProps } from 'streamdown';
import { isInvisibleText } from '@/lib/invisibleText';
import { BLOCK_INDEX, BLOCK_KEY, blockKey, MarkdownWindowContext } from './markdownWindow';

const LINE_HEIGHT = 24;

const estimateHeight = (content: string, charsPerLine: number) => {
  let lines = 0;
  for (const line of content.split('\n')) lines += Math.max(1, Math.ceil(line.length / charsPerLine));
  return lines * LINE_HEIGHT;
};

export const WindowedMarkdownBlock = React.memo(function WindowedMarkdownBlock(props: BlockProps) {
  const store = React.useContext(MarkdownWindowContext);
  const rendered = React.useSyncExternalStore(
    store?.subscribe ?? noSubscribe,
    () => store?.isRendered(props.index) ?? true,
  );
  if (isInvisibleText(props.content)) return null;
  const key = blockKey(props.index, props.content);
  if (rendered) {
    return (
      <div data-oc-markdown-block="" {...{ [BLOCK_INDEX]: props.index, [BLOCK_KEY]: key }}>
        <Block {...props} />
      </div>
    );
  }
  const size = store?.size(key);
  return (
    <div
      data-oc-markdown-block=""
      data-oc-block-placeholder=""
      {...{ [BLOCK_INDEX]: props.index, [BLOCK_KEY]: key }}
      style={{
        height: size?.height ?? estimateHeight(props.content, store?.charsPerLine ?? 80),
        marginBlockStart: size?.start ?? 0,
        marginBlockEnd: size?.end ?? 0,
      }}
    />
  );
});

const noSubscribe = () => () => {};
