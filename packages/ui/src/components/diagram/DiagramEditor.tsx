import React from 'react';
import { DrawIoEmbed } from 'react-drawio';
import { cn } from '@/lib/utils';

export interface DiagramEditorHandle {
  getXml: () => string;
}

export interface DiagramEditorProps {
  xml: string;
  readOnly?: boolean;
  className?: string;
  onChange?: (xml: string) => void;
}

const BLANK_XML = '<mxfile><diagram id="new" name="Page-1"><mxGraphModel dx="0" dy="0" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="827" pageHeight="1169" math="0" shadow="0"><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>';

function detectDark(): boolean {
  if (typeof document === 'undefined') return false;
  const theme = document.documentElement.getAttribute('data-theme');
  return theme === 'dark' || (!theme && window.matchMedia('(prefers-color-scheme: dark)').matches);
}

export const DiagramEditor = React.forwardRef<DiagramEditorHandle, DiagramEditorProps>(
  function DiagramEditor({ xml, readOnly, className, onChange }, ref) {
    const latestXmlRef = React.useRef(xml);
    const drawioRef = React.useRef<React.ComponentRef<typeof DrawIoEmbed>>(null);
    const hasShownTemplate = React.useRef(false);
    const [isDark, setIsDark] = React.useState(detectDark);
    const stableXmlRef = React.useRef(xml);

    const prevIsDark = React.useRef(isDark);
    if (prevIsDark.current !== isDark) {
      prevIsDark.current = isDark;
      stableXmlRef.current = latestXmlRef.current;
    }

    React.useEffect(() => {
      const check = () => setIsDark(detectDark());
      check();
      const observer = new MutationObserver(check);
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
      return () => observer.disconnect();
    }, []);

    React.useImperativeHandle(ref, () => ({
      getXml: () => latestXmlRef.current,
    }));

    const handleLoad = React.useCallback(() => {
      if (!xml && !hasShownTemplate.current) {
        hasShownTemplate.current = true;
        setTimeout(() => {
          drawioRef.current?.template({});
        }, 500);
      }
    }, [xml]);

    const handleAutoSave = React.useCallback((data: { xml: string }) => {
      latestXmlRef.current = data.xml;
      onChange?.(data.xml);
    }, [onChange]);

    return (
      <div className={cn('h-full w-full', className)}>
        <DrawIoEmbed
          key={isDark ? 'dark' : 'light'}
          ref={drawioRef}
          xml={stableXmlRef.current || BLANK_XML}
          autosave
          urlParameters={{
            ui: readOnly ? 'simple' : isDark ? 'dark' : 'kennedy',
            spin: true,
            libraries: !readOnly,
            chrome: readOnly,
            nav: readOnly,
            layers: readOnly,
            noSaveBtn: true,
            noExitBtn: true,
            saveAndExit: false,
          }}
          onLoad={handleLoad}
          onAutoSave={handleAutoSave}
        />
      </div>
    );
  },
);
