import React from 'react';
import type { BlockProps, CustomRendererProps } from 'streamdown';
import { useOnDemandComponent } from '@/hooks/useOnDemandComponent';
import { OpenUIBlockContext, OpenUIFenceContext } from './openuiMarkdownContext';
import { getLoadedOpenUIModule, loadOpenUIRenderer } from '../openuiRendererLoader';

export function OpenUIBlockSource({ content, index, children }: Pick<BlockProps, 'content' | 'index'> & {
  children: React.ReactNode;
}) {
  const value = React.useMemo(() => ({ content, index }), [content, index]);
  return <OpenUIBlockContext.Provider value={value}>{children}</OpenUIBlockContext.Provider>;
}

export function MarkdownOpenUI(_props: CustomRendererProps) {
  const mount = React.useContext(OpenUIFenceContext);
  const [failed, setFailed] = React.useState(false);
  const loadedRenderer = getLoadedOpenUIModule()?.OpenUIRenderer;
  const requested = useOnDemandComponent(Boolean(mount) && !failed && !loadedRenderer, loadOpenUIRenderer, () => setFailed(true));
  const Renderer = loadedRenderer ?? requested;
  if (!mount) return null;
  return (
    <div data-oc-openui-source={mount.fence.code} data-oc-code-source={mount.fence.code}>
      {Renderer && !failed ? <Renderer mount={mount} /> : (
        <pre dir="ltr"><code className="language-openui-lang">{mount.fence.code}</code></pre>
      )}
    </div>
  );
}
