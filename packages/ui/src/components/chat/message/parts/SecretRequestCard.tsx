import React from 'react';

import { dispatchPageWaiting } from '@/components/chat/lib/scroll/timelineScrollIntent';
import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/lib/i18n';
import type { ToolPart } from '@/lib/opencode/model';
import type { RequestedSecret, SecretRequestState } from '@/lib/opencode/tools';
import { answerSecretRequest } from '@/lib/secretRequestAnswer';
import { useSessionDirectory } from '@/sync/sync-context';

/**
 * The card an agent asks for a secret on (`openchamber_secret`). The value
 * goes straight to the server, which writes it to a private file; the call,
 * the transcript and the agent's context only ever see the file's path. Once
 * answered, the card folds to one line.
 */
export function SecretRequestCard({ part, request }: { part: ToolPart; request: RequestedSecret }) {
    const { t } = useI18n();
    const directory = useSessionDirectory(part.sessionID);
    const [value, setValue] = React.useState('');
    const [busy, setBusy] = React.useState(false);
    // What this client sent, shown until the call completes with the status
    // OpenCode stores.
    const [sent, setSent] = React.useState<SecretRequestState | null>(null);
    const state = request.state === 'waiting' && sent ? sent : request.state;

    const send = React.useCallback(async (answer: { value: string } | { declined: true }, outcome: SecretRequestState) => {
        setBusy(true);
        try {
            await answerSecretRequest({ sessionId: part.sessionID, callId: part.callID, ...answer }, directory);
            setValue('');
            setSent(outcome);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            toast.error(t('chat.secretRequest.saveFailed'), { description: message });
        } finally {
            setBusy(false);
        }
    }, [directory, part.callID, part.sessionID, t]);

    // The chat brings a card that waits into view, like a page that waits.
    const waiting = state === 'waiting';
    const blockRef = React.useRef<HTMLDivElement>(null);
    React.useEffect(() => {
        if (waiting) dispatchPageWaiting(blockRef.current);
    }, [waiting]);

    if (!waiting) {
        const line = state === 'saved'
            ? t('chat.secretRequest.saved', { label: request.label })
            : state === 'declined'
                ? t('chat.secretRequest.declined', { label: request.label })
                : t('chat.secretRequest.notGiven', { label: request.label });
        return (
            <div className="my-2 flex items-center gap-1.5 typography-meta text-muted-foreground" data-secret-request-status={state}>
                <Icon name={state === 'saved' ? 'shield-check' : 'shield'} className="size-3.5 shrink-0" />
                <span className="min-w-0 truncate" title={line}>{line}</span>
            </div>
        );
    }

    return (
        <div ref={blockRef} className="oc-tile my-2 rounded-xl p-4" data-secret-request-status="waiting" data-waiting-page={part.id}>
            <div className="typography-ui-label font-semibold text-foreground">{request.label}</div>
            <p className="mt-1 whitespace-pre-wrap break-words typography-markdown text-muted-foreground">{request.reason}</p>
            <form
                className="mt-3 flex items-center gap-2"
                onSubmit={(event) => {
                    event.preventDefault();
                    if (value.trim() && !busy) void send({ value }, 'saved');
                }}
            >
                <Input
                    type="password"
                    value={value}
                    onChange={(event) => setValue(event.target.value)}
                    placeholder={request.placeholder ?? t('chat.secretRequest.placeholder')}
                    aria-label={t('chat.secretRequest.inputLabel')}
                    // Keep password managers from offering to store or fill it.
                    autoComplete="off"
                    data-1p-ignore
                    data-lpignore="true"
                    data-bwignore
                    disabled={busy}
                    className="flex-1"
                />
                <Button type="submit" disabled={busy || !value.trim()}>{t('chat.secretRequest.save')}</Button>
            </form>
            <div className="mt-2 flex items-center gap-1.5 typography-meta text-muted-foreground">
                <Icon name="shield-check" className="size-3.5 shrink-0" />
                <span className="min-w-0 flex-1">{t('chat.secretRequest.privacy')}</span>
                <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void send({ declined: true }, 'declined')}>
                    {t('chat.secretRequest.decline')}
                </Button>
            </div>
        </div>
    );
}
