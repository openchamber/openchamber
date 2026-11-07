import React from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Icon } from '@/components/icon/Icon';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/components/ui';
import { SimpleMarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { isIMECompositionEvent } from '@/lib/ime';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { dismissBtw, openBtwComposer, runBtwQuestion } from '@/lib/btw';
import { useBtwStore, type BtwRequest } from '@/stores/useBtwStore';
import { useScopedBlockingForms, useScopedBlockingPermissions } from '@/sync/sync-context';

type BtwDialogProps = {
  parentSessionId: string;
  ownerKey: string;
  directory: string | null;
};

const failureText = (
  failure: NonNullable<BtwRequest['failure']>,
  t: ReturnType<typeof useI18n>['t'],
): string | undefined => {
  if (failure.reason === 'empty') return t('chat.btw.error.empty');
  if (failure.reason === 'timeout') return t('chat.btw.error.timeout');
  if (failure.reason === 'unsupported') return t('chat.btw.error.unsupported');
  if (failure.reason === 'session-missing') return t('chat.btw.error.sessionMissing');
  return failure.message || t('chat.btw.error.generic');
};

const BtwDialogContent: React.FC<BtwDialogProps & { request: BtwRequest }> = ({
  parentSessionId,
  ownerKey,
  directory,
  request,
}) => {
  const { t } = useI18n();
  const setDraft = useBtwStore((state) => state.setDraft);
  const inputRef = React.useRef<HTMLTextAreaElement | null>(null);
  const [copied, setCopied] = React.useState(false);

  const permissions = useScopedBlockingPermissions(parentSessionId, directory ?? undefined);
  const forms = useScopedBlockingForms(parentSessionId, directory ?? undefined);
  const mainWaiting = permissions.length > 0 || forms.length > 0;

  React.useEffect(() => {
    setCopied(false);
  }, [request.answer]);

  React.useEffect(() => {
    if (request.status !== 'compose') return;
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [request.status]);

  const close = () => dismissBtw(parentSessionId);

  const submit = () => {
    if (request.status !== 'compose') return;
    const question = request.draft.trim();
    if (!question) return;
    void runBtwQuestion({
      parentSessionId,
      ownerKey,
      directory,
      question,
      runtimeKey: getRuntimeKey(),
    });
  };

  const retry = () => {
    if (!request.question) return;
    void runBtwQuestion({
      parentSessionId,
      ownerKey,
      directory,
      question: request.question,
      runtimeKey: getRuntimeKey(),
    });
  };

  const copyAnswer = () => {
    if (!request.answer) return;
    if (!navigator.clipboard?.writeText) {
      toast.error(t('terminalView.toast.copyFailed'));
      return;
    }
    void navigator.clipboard.writeText(request.answer).then(
      () => setCopied(true),
      () => toast.error(t('terminalView.toast.copyFailed')),
    );
  };

  const failure = request.failure ? failureText(request.failure, t) : undefined;

  return (
    <Dialog open onOpenChange={(open) => { if (!open) close(); }}>
      <DialogContent data-btw-dialog="true" className="max-w-[min(560px,calc(100vw-2rem))] gap-4">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Icon name="chat-ai-3" className="size-4 text-muted-foreground" />
            /btw
          </DialogTitle>
          <DialogDescription>{t('chat.btw.description')}</DialogDescription>
        </DialogHeader>

        {mainWaiting ? (
          <div className="rounded-md bg-[color:color-mix(in_srgb,var(--status-warning)_12%,var(--surface-background))] px-3 py-2 typography-meta text-foreground">
            {t('chat.btw.mainWaiting')}
          </div>
        ) : null}

        {request.status === 'compose' ? (
          <div className="flex flex-col gap-3">
            <textarea
              ref={inputRef}
              value={request.draft}
              onChange={(event) => setDraft(parentSessionId, event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' || event.shiftKey || isIMECompositionEvent(event)) return;
                event.preventDefault();
                submit();
              }}
              rows={3}
              placeholder={t('chat.btw.draftHint')}
              aria-label={t('chat.btw.draftHint')}
              className="min-h-[88px] w-full resize-y rounded-lg bg-[var(--surface-background)] px-3 py-2 typography-ui-label text-foreground outline-none focus-visible:ring-1 focus-visible:ring-[var(--interactive-border)]"
            />
            <p className="typography-micro text-muted-foreground">{t('chat.btw.textOnly')}</p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="rounded-lg bg-[var(--surface-background)] px-3 py-2 typography-ui-label text-foreground whitespace-pre-wrap break-words">
              {request.question}
            </div>

            {request.status === 'running' ? (
              <div className="flex items-center gap-2 py-1 typography-meta text-muted-foreground" role="status" aria-live="polite">
                <Spinner className="size-4" />
                <span>{t('chat.btw.working')}</span>
              </div>
            ) : null}

            {request.status === 'answered' ? (
              <div className="flex max-h-[min(55vh,520px)] flex-col gap-2 overflow-y-auto">
                <div className="break-words">
                  <SimpleMarkdownRenderer
                    content={request.answer ?? ''}
                    directory={directory}
                    variant="assistant"
                    className="typography-ui-label"
                    fallbackContent={<div className="whitespace-pre-wrap">{request.answer}</div>}
                  />
                </div>
                <div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={copyAnswer}
                    aria-label={copied ? t('chat.btw.copied') : t('chat.btw.copy')}
                  >
                    <Icon name={copied ? 'check' : 'file-copy'} className="size-3.5" />
                    {copied ? t('chat.btw.copied') : t('chat.btw.copy')}
                  </Button>
                </div>
              </div>
            ) : null}

            {request.status === 'failed' ? (
              <div className="flex flex-col gap-1 py-1" role="alert">
                <span className="typography-meta text-[var(--status-error)] break-words">
                  {failure || t('chat.btw.error.generic')}
                </span>
              </div>
            ) : null}
          </div>
        )}

        <DialogFooter className={cn('gap-2')}>
          {request.status === 'compose' ? (
            <>
              <Button type="button" variant="ghost" size="sm" onClick={close}>
                {t('dialog.common.actions.cancel')}
              </Button>
              <Button type="button" size="sm" onClick={submit} disabled={!request.draft.trim()}>
                {t('chat.btw.ask')}
              </Button>
            </>
          ) : null}

          {request.status === 'running' ? (
            <Button type="button" variant="ghost" size="sm" onClick={close}>
              {t('dialog.common.actions.cancel')}
            </Button>
          ) : null}

          {request.status === 'answered' ? (
            <>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => openBtwComposer(parentSessionId, ownerKey, directory)}
              >
                {t('chat.btw.askAnother')}
              </Button>
              <Button type="button" size="sm" onClick={close}>
                {t('dialog.common.actions.close')}
              </Button>
            </>
          ) : null}

          {request.status === 'failed' ? (
            <>
              <Button type="button" variant="ghost" size="sm" onClick={close}>
                {t('dialog.common.actions.close')}
              </Button>
              <Button type="button" size="sm" onClick={retry}>
                {t('chat.btw.retry')}
              </Button>
            </>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

const BtwDialogView: React.FC<BtwDialogProps> = ({ parentSessionId, ownerKey, directory }) => {
  const request = useBtwStore((state) => state.byParent[parentSessionId]);
  if (!request || request.ownerKey !== ownerKey) return null;
  return <BtwDialogContent parentSessionId={parentSessionId} ownerKey={ownerKey} directory={directory} request={request} />;
};

export const BtwDialog = React.memo(BtwDialogView);
