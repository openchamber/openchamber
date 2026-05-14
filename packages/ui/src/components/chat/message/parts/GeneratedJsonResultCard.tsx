import React from 'react';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { copyTextToClipboard } from '@/lib/clipboard';
import { useI18n } from '@/lib/i18n';
import type { GeneratedResult } from './generatedJsonResult';

export const GeneratedJsonResultCard: React.FC<{ result: GeneratedResult }> = ({ result }) => {
  const { t } = useI18n();
  const [copied, setCopied] = React.useState(false);

  const copyText = React.useMemo(() => {
    if (result.kind === 'commit') {
      return [result.subject, ...result.highlights.map((highlight) => `- ${highlight}`)].join('\n');
    }
    return [result.title, result.body].filter(Boolean).join('\n\n');
  }, [result]);

  const handleCopy = React.useCallback(async () => {
    const copyResult = await copyTextToClipboard(copyText || result.raw);
    if (!copyResult.ok) return;
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  }, [copyText, result.raw]);

  return (
    <div data-component="generated-json-result" className="my-4 group overflow-hidden rounded-2xl border border-border/80 bg-[var(--surface-elevated)]">
      <div className="flex items-center justify-between border-b border-border/70 px-3 py-1.5">
        <span className="font-mono text-[13px] text-muted-foreground">
          {result.kind === 'commit'
            ? t('chat.generatedResult.commit.title')
            : t('chat.generatedResult.pullRequest.title')}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={() => { void handleCopy(); }}
          title={copied ? t('chat.generatedResult.actions.copied') : t('chat.generatedResult.actions.copy')}
          aria-label={copied ? t('chat.generatedResult.actions.copied') : t('chat.generatedResult.actions.copy')}
          className="text-muted-foreground hover:text-foreground md:opacity-0 md:group-hover:opacity-100"
        >
          {copied ? <Icon name="check" className="size-3.5" /> : <Icon name="file-copy" className="size-3.5" />}
        </Button>
      </div>
      <div className="space-y-3 px-3 py-3">
        {result.kind === 'commit' ? (
          <>
            <div className="typography-ui-label text-foreground">{result.subject}</div>
            {result.highlights.length > 0 ? (
              <ul className="space-y-1 text-sm text-muted-foreground">
                {result.highlights.map((highlight, index) => (
                  <li key={`${index}-${highlight}`} className="flex gap-2">
                    <span className="text-muted-foreground/70">-</span>
                    <span>{highlight}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        ) : (
          <>
            {result.title ? (
              <div>
                <div className="typography-micro uppercase tracking-[0.12em] text-muted-foreground">{t('chat.generatedResult.pullRequest.titleLabel')}</div>
                <div className="mt-1 typography-ui-label text-foreground">{result.title}</div>
              </div>
            ) : null}
            {result.body ? (
              <div>
                <div className="typography-micro uppercase tracking-[0.12em] text-muted-foreground">{t('chat.generatedResult.pullRequest.bodyLabel')}</div>
                <pre className="mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed text-muted-foreground font-sans">{result.body}</pre>
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
};
