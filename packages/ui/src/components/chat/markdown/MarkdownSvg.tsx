import React from 'react';
import type { CustomRendererProps } from 'streamdown';
import { MarkdownSvgFailureContext } from './MarkdownPresentationContext';

const svgDataUrl = (source: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`;

/**
 * `svg` fences of a document preview. The source loads as an image, which
 * runs no script and fetches nothing. The image sits on white because an SVG
 * is drawn for a light page and does not see the app theme. The wrapper keeps
 * the source for selection copy.
 */
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
