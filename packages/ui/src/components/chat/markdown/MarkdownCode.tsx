import React from 'react';
import {
  CodeBlockContainer,
  CodeBlockHeader,
  defaultComponents,
  useIsCodeFenceIncomplete,
  type ExtraProps,
  type HighlightResult,
  type HighlightToken,
} from 'streamdown';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { copyTextToClipboard } from '@/lib/clipboard';
import { useUIStore } from '@/stores/useUIStore';
import { useI18n } from '@/lib/i18n';
import { useMarkdownPresentation } from './MarkdownPresentationContext';
import { activateMarkdownFile, useOpenMarkdownFile } from './markdownFileReferences';
import type { MarkdownCodePlugin } from './streamdownCode';
import { MarkdownDiff } from './MarkdownDiff';
import { MarkdownSuggestionContext, isSuggestionLanguage, suggestionPatch } from './markdownSuggestion';

// Complete prefix rows keep their identity in the worker client, so appending
// code only renders changed rows. React owns every node; no HTML patching.
const CodeLine = React.memo(function CodeLine({ tokens }: { tokens: HighlightToken[] }) {
  const empty = tokens.length === 0 || (tokens.length === 1 && tokens[0].content === '');
  return (
    <span className="block before:content-[counter(line)] before:[counter-increment:line]">
      {empty ? '\n' : tokens.map((token, index) => {
        const style: React.CSSProperties = {
          ...token.htmlStyle,
          color: token.color,
          backgroundColor: token.bgColor,
        };
        return <span key={index} style={style} {...token.htmlAttrs}>{token.content}</span>;
      })}
    </span>
  );
});

const MarkdownCodeBody = React.memo(function MarkdownCodeBody({ source, language, incomplete, plugin }: {
  source: string;
  language: string;
  incomplete: boolean;
  plugin: MarkdownCodePlugin;
}) {
  const input = React.useMemo(() => ({
    code: source,
    language,
    isIncomplete: incomplete,
    themes: plugin.getThemes(),
  }), [source, language, incomplete, plugin]);
  const initial = React.useMemo(() => plugin.cached(input), [plugin, input]);
  type Display = { input: typeof input; result: HighlightResult };
  const [resolved, setResolved] = React.useState<(Display & { lineage: symbol }) | null>(null);
  const committed = React.useRef<{
    input: typeof input; plugin: MarkdownCodePlugin; lineage: symbol; display: Display; exact: boolean;
  } | null>(null);
  // An edit or context change starts a new lineage, even if later input returns
  // to an older source. Results from the abandoned lineage must not reappear.
  const lineage = React.useMemo(() => {
    const previous = committed.current;
    return previous?.plugin === plugin && previous.input.language === input.language
      && input.code.startsWith(previous.input.code) ? previous.lineage : Symbol();
  }, [input, plugin]);

  const display = React.useMemo<Display>(() => {
    const current = resolved?.lineage === lineage ? resolved : null;
    if (current?.input === input) return current;
    // Exact hits include policy-driven plain results (copy/export and line budgets).
    if (initial) return { input, result: initial };
    const previous = committed.current;
    const retained = previous?.lineage === lineage ? previous.display : null;
    if (current && (!retained || current.input.code.length >= retained.input.code.length)) return current;
    if (retained) return retained;
    return { input, result: { tokens: input.code.split('\n').map((content) => [{ content }]) } };
  }, [input, initial, lineage, resolved]);
  React.useLayoutEffect(() => {
    committed.current = { input, plugin, lineage, display, exact: initial !== null };
    return () => { committed.current = null; };
  }, [input, plugin, lineage, display, initial]);

  React.useEffect(() => {
    const publish = (result: HighlightResult) => {
      const latest = committed.current;
      if (latest?.lineage !== lineage || !latest.input.code.startsWith(input.code)) return;
      if (latest.exact && latest.input !== input) return;
      if (input.code.length < latest.display.input.code.length) return;
      setResolved((previous) => {
        if (previous?.input === latest.input && input !== latest.input) return previous;
        if (previous?.lineage === lineage && (previous.input.code.length > input.code.length
          || previous.input === input && previous.result === result)) return previous;
        return { input, result, lineage };
      });
    };
    const result = plugin.highlight(input, publish);
    if (result) publish(result);
  }, [plugin, input, lineage]);

  return (
    <div data-streamdown="code-block-body" data-language={language}>
      <pre>
        <code className="[counter-increment:line_0] [counter-reset:line]">
          {display.result.tokens.map((tokens, index) => (
            <CodeLine key={index} tokens={tokens} />
          ))}
        </code>
      </pre>
    </div>
  );
});

export function MarkdownCode({ children, className, node, ...props }: React.ComponentProps<'code'> & ExtraProps) {
  const presentation = useMarkdownPresentation();
  const { t } = useI18n();
  const wrap = useUIStore((state) => state.codeBlockLineWrap);
  const incomplete = useIsCodeFenceIncomplete();
  const openFile = useOpenMarkdownFile();
  const [copied, setCopied] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const suggestionBase = React.useContext(MarkdownSuggestionContext);
  const language = /language-([^\s]+)/.exec(className ?? '')?.[1] ?? '';
  const suggestion = suggestionBase !== null && isSuggestionLanguage(language);
  const proposal = language.toLowerCase() === 'diff' || suggestion;
  const code = node?.children.map((child) => child.type === 'text' ? child.value : '').join('') ?? '';
  const copySource = code.replace(/\n$/, '');
  const { purpose, onExportCode } = presentation;
  React.useLayoutEffect(() => {
    if (purpose && language !== 'mermaid') onExportCode?.(code, language);
  }, [purpose, onExportCode, code, language]);

  if (language === 'mermaid') {
    return (
      <defaultComponents.code {...props} node={node} className={className}>
        {children}
      </defaultComponents.code>
    );
  }

  const handleFileClick = (event: React.MouseEvent | React.KeyboardEvent) => {
    if (!presentation.fileNavigation || !(event.target instanceof Element)) return;
    const target = event.target.closest<HTMLElement>('[data-openchamber-file-link="true"]');
    const raw = target?.getAttribute('data-openchamber-file-ref');
    if (!raw) return;
    activateMarkdownFile(event, (external) => {
      void openFile(raw, target?.getAttribute('data-openchamber-file-path') ?? undefined, external);
    });
  };
  const copy = async () => {
    const result = await copyTextToClipboard(copySource);
    if (!result.ok) return;
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div
      data-code-wrap={wrap ? 'true' : 'false'}
      data-oc-code-source={copySource}
      onClick={handleFileClick}
      onKeyDown={handleFileClick}
    >
      <CodeBlockContainer language={language} isIncomplete={incomplete} dir="ltr">
        <CodeBlockHeader language={suggestion ? t('chat.markdown.suggestion.title') : proposal ? t('markdownRenderer.code.proposal') : language.toLowerCase() || 'text'} />
        {!purpose && (
          <div className="pointer-events-none absolute top-0 end-0 flex items-center">
            <div
              data-streamdown="code-block-actions"
              className="pointer-events-auto flex shrink-0 items-center gap-2 rounded-md border border-sidebar bg-sidebar/80 px-1.5 py-1 supports-[backdrop-filter]:bg-sidebar/70 supports-[backdrop-filter]:backdrop-blur"
            >
              {!proposal && <Button
                variant="ghost"
                size="xs"
                data-export-ignore
                title={t(wrap ? 'markdownRenderer.code.actions.disableWrapTitle' : 'markdownRenderer.code.actions.enableWrapTitle')}
                aria-pressed={wrap}
                onClick={() => useUIStore.getState().setCodeBlockLineWrap(!wrap)}
              >
                <Icon name="text-wrap" className="size-3.5" />
              </Button>}
              <Button
                variant="ghost"
                size="xs"
                data-export-ignore
                title={t(copied ? 'markdownRenderer.code.actions.copiedTitle' : 'markdownRenderer.code.actions.copyTitle')}
                onClick={copy}
              >
                <Icon name={copied ? 'check' : 'file-copy'} className="size-3.5" />
              </Button>
            </div>
          </div>
        )}
        {proposal && !purpose ? (
          <MarkdownDiff source={suggestion ? suggestionPatch(copySource, suggestionBase.excerpt) : copySource} incomplete={incomplete} />
        ) : <MarkdownCodeBody
          source={copySource}
          language={language}
          incomplete={incomplete}
          plugin={presentation.code}
        />}
      </CodeBlockContainer>
    </div>
  );
}
