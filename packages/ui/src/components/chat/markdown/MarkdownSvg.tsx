import React from 'react';
import type { CustomRendererProps } from 'streamdown';
import { MarkdownSvgFailureContext } from './MarkdownPresentationContext';

const svgDataUrl = (source: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`;

export function MarkdownSvg({ code }: CustomRendererProps) {
  const fail = React.useContext(MarkdownSvgFailureContext);
  return (
    <div data-streamdown="svg-block" data-oc-svg-source={code}>
      <img
        src={svgDataUrl(code)}
        alt="svg"
        className="max-w-full rounded-md bg-white"
        onError={() => fail?.()}
      />
    </div>
  );
}
