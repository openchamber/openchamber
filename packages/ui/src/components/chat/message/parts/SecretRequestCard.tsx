import React from 'react';

import { dispatchPageWaiting } from '@/components/chat/lib/scroll/timelineScrollIntent';
import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/lib/i18n';
import type { ToolPart } from '@/lib/opencode/model';
import type { RequestedSecret, RequestedSecretRun } from '@/lib/opencode/tools';
import { answerSecretRequest, readSecretRunFields } from '@/lib/secretRequestAnswer';
import { useIsCallWaiting } from '@/sync/global-blocking-requests';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionDirectory } from '@/sync/sync-context';

import ToolPartRow from './ToolPart';

/** A password field with a show/hide toggle that never sends the value anywhere new. */
function SecretInput({ value, onChange, placeholder, ariaLabel, disabled }: {
    value: string;
    onChange: (value: string) => void;
    placeholder: string;
    ariaLabel: string;
    disabled: boolean;
}) {
    const { t } = useI18n();
    const [revealed, setRevealed] = React.useState(false);
    return (
        <div className="relative min-w-0 flex-1">
            <Input
                type={revealed ? 'text' : 'password'}
                value={value}
                onChange={(event) => onChange(event.target.value)}
                placeholder={placeholder}
                aria-label={ariaLabel}
                // Keep password managers from offering to store or fill it.
                autoComplete="off"
                data-1p-ignore
                data-lpignore="true"
                data-bwignore
                disabled={disabled}
                className="w-full pe-9"
            />
            <Button
                type="button"
                variant="ghost"
                size="icon"
                className="absolute inset-e-1 top-1/2 size-7 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label={t(revealed ? 'chat.secretRequest.hideSecret' : 'chat.secretRequest.showSecret')}
                aria-pressed={revealed}
                title={t(revealed ? 'chat.secretRequest.hideSecret' : 'chat.secretRequest.showSecret')}
                disabled={disabled}
                onClick={() => setRevealed((current) => !current)}
            >
                <Icon name={revealed ? 'eye-off' : 'eye'} className="size-4" />
            </Button>
        </div>
    );
}

/** The chat brings a card that waits into view, like a page that waits. */
function useWaitingIntoView(waiting: boolean) {
    const blockRef = React.useRef<HTMLDivElement>(null);
    React.useEffect(() => {
        if (waiting) dispatchPageWaiting(blockRef.current);
    }, [waiting]);
    return blockRef;
}

/**
 * The call's ordinary tool row, for the moments the card asks nothing: while
 * OpenCode asks to approve the command, while the command runs, and right
 * after this client answered. A finished call is that row anyway
 * (`isShownInPlace`), so the card never leaves a look of its own behind.
 */
function SecretCallRow({ part }: { part: ToolPart }) {
    const isMobile = useUIStore((state) => state.isMobile);
    const [expanded, setExpanded] = React.useState(false);
    const toggle = React.useCallback(() => setExpanded((current) => !current), []);
    return <ToolPartRow part={part} isExpanded={expanded} onToggle={toggle} isMobile={isMobile} animateTailText={false} />;
}

/**
 * The card a `secret.request` asks on. The value goes straight to the
 * server, which writes it to a private file; the call, the transcript and the
 * agent's context only ever see the file's path. Once this client answered,
 * the call shows as its tool row.
 */
export function SecretRequestCard({ part, request }: { part: ToolPart; request: RequestedSecret }) {
    const { t } = useI18n();
    const directory = useSessionDirectory(part.sessionID);
    const [value, setValue] = React.useState('');
    const [busy, setBusy] = React.useState(false);
    // This client answered; the call completes a moment later.
    const [sent, setSent] = React.useState(false);

    const send = React.useCallback(async (answer: { value: string } | { declined: true }) => {
        setBusy(true);
        try {
            await answerSecretRequest({ sessionId: part.sessionID, callId: part.callID, ...answer }, directory);
            setValue('');
            setSent(true);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            toast.error(t('chat.secretRequest.saveFailed'), { description: message });
        } finally {
            setBusy(false);
        }
    }, [directory, part.callID, part.sessionID, t]);

    const blockRef = useWaitingIntoView(!sent);
    if (sent) return <SecretCallRow part={part} />;

    return (
        <div ref={blockRef} className="oc-tile my-2 rounded-xl p-4" data-secret-request-status="waiting" data-waiting-page={part.id}>
            <div className="typography-ui-label font-semibold text-foreground">{request.label}</div>
            <p className="mt-1 whitespace-pre-wrap break-words typography-markdown text-muted-foreground">{request.reason}</p>
            <form
                className="mt-3 flex items-center gap-2"
                onSubmit={(event) => {
                    event.preventDefault();
                    if (value.trim() && !busy) void send({ value });
                }}
            >
                <SecretInput
                    value={value}
                    onChange={setValue}
                    placeholder={request.placeholder ?? t('chat.secretRequest.placeholder')}
                    ariaLabel={t('chat.secretRequest.inputLabel')}
                    disabled={busy}
                />
                <Button type="submit" disabled={busy || !value.trim()}>{t('chat.secretRequest.save')}</Button>
            </form>
            <div className="mt-2 flex items-center gap-1.5 typography-meta text-muted-foreground">
                <Icon name="shield-check" className="size-3.5 shrink-0" />
                <span className="min-w-0 flex-1">{t('chat.secretRequest.privacy')}</span>
                <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void send({ declined: true })}>
                    {t('chat.secretRequest.decline')}
                </Button>
            </div>
        </div>
    );
}

type SentRun = 'running' | 'declined';

const SECRET_FIELDS_RETRY_MS = 2_000;

/**
 * The card a `secret.run` call asks on: the command line the user approved,
 * then a field for each secret the server still needs (the ones the chat
 * remembers are left out), each with its own "remember" choice. The values go
 * straight to the server, which runs the command with them in its
 * environment; nothing of them returns to the chat.
 *
 * While the call runs, the card tells its stage from what the server reports
 * live: a shell permission OpenCode asks for this command line, then the card
 * the server announces as waiting, whose fields it reads from the server.
 * OpenCode keeps no progress of a running call that a client opening the chat
 * later could read, so every client asks the server the same way.
 */
export function SecretRunCard({ part, run }: { part: ToolPart; run: RequestedSecretRun }) {
    const { t } = useI18n();
    const directory = useSessionDirectory(part.sessionID);
    const [values, setValues] = React.useState<Record<string, string>>({});
    const [remember, setRemember] = React.useState<Record<string, boolean>>({});
    const [busy, setBusy] = React.useState(false);
    const [sent, setSent] = React.useState<SentRun | null>(null);
    const [card, setCard] = React.useState<{ fields: string[]; reused: string[] } | null>(null);
    const waiting = useIsCallWaiting(part.sessionID, part.callID) && sent === null;

    // A read that fails (a reconnect, a server restarting) is tried again while
    // the card waits, so the card never stays hidden behind one lost request.
    React.useEffect(() => {
        if (!waiting) return;
        let current = true;
        let retry: ReturnType<typeof setTimeout> | undefined;
        const read = () => {
            void readSecretRunFields({ sessionId: part.sessionID, callId: part.callID }, directory)
                .catch(() => null)
                .then((fields) => {
                    if (!current) return;
                    if (fields) setCard(fields);
                    else retry = setTimeout(read, SECRET_FIELDS_RETRY_MS);
                });
        };
        read();
        return () => {
            current = false;
            clearTimeout(retry);
        };
    }, [directory, part.callID, part.sessionID, waiting]);

    const asking = waiting && card !== null && card.fields.length > 0;
    const blockRef = useWaitingIntoView(asking);
    const asked = React.useMemo(
        () => (asking && card ? run.fields.filter((field) => card.fields.includes(field.env)) : []),
        [asking, card, run.fields],
    );
    const complete = asked.length > 0 && asked.every((field) => values[field.env]?.trim());

    const send = React.useCallback(async (answer: { values: Record<string, string>; remember: string[] } | { declined: true }, outcome: SentRun) => {
        setBusy(true);
        try {
            await answerSecretRequest({ sessionId: part.sessionID, callId: part.callID, ...answer }, directory);
            setValues({});
            setSent(outcome);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            toast.error(t('chat.secretRun.sendFailed'), { description: message });
        } finally {
            setBusy(false);
        }
    }, [directory, part.callID, part.sessionID, t]);

    if (!asking) {
        // A card the server announced, whose fields are still on the way.
        if (waiting) return null;
        return <SecretCallRow part={part} />;
    }

    const reusedLabels = run.fields.filter((field) => card?.reused.includes(field.env)).map((field) => field.label);
    return (
        <div ref={blockRef} className="oc-tile my-2 rounded-xl p-4" data-secret-request-status="waiting" data-waiting-page={part.id}>
            <div className="typography-ui-label font-semibold text-foreground">{t('chat.secretRun.title', { program: run.program })}</div>
            <p className="mt-1 whitespace-pre-wrap break-words typography-markdown text-muted-foreground">{run.reason}</p>
            <pre
                className="typography-code oc-tile-inset mt-3 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-lg px-2 py-1.5 font-mono text-foreground"
                aria-label={t('chat.secretRun.commandLabel')}
            >
                {run.command}
            </pre>
            <form
                className="mt-3 flex flex-col gap-3"
                onSubmit={(event) => {
                    event.preventDefault();
                    if (!complete || busy) return;
                    const submitted = Object.fromEntries(asked.map((field) => [field.env, values[field.env] ?? '']));
                    void send({ values: submitted, remember: asked.filter((field) => remember[field.env]).map((field) => field.env) }, 'running');
                }}
            >
                {asked.map((field) => (
                    <div key={field.env} className="flex flex-col gap-1.5">
                        <div className="flex items-baseline justify-between gap-2">
                            <span className="min-w-0 typography-ui-label text-foreground">{field.label}</span>
                            <span className="shrink-0 font-mono typography-meta text-muted-foreground">{field.env}</span>
                        </div>
                        <SecretInput
                            value={values[field.env] ?? ''}
                            onChange={(value) => setValues((current) => ({ ...current, [field.env]: value }))}
                            placeholder={field.placeholder ?? t('chat.secretRequest.placeholder')}
                            ariaLabel={field.label}
                            disabled={busy}
                        />
                        <label className="flex w-fit cursor-pointer items-center gap-1.5 typography-meta text-muted-foreground">
                            <Checkbox
                                ariaLabel={t('chat.secretRun.remember')}
                                checked={remember[field.env] === true}
                                onChange={(checked) => setRemember((current) => ({ ...current, [field.env]: checked }))}
                                disabled={busy}
                            />
                            <span>{t('chat.secretRun.remember')}</span>
                        </label>
                    </div>
                ))}
                {reusedLabels.length > 0 ? (
                    <div className="typography-meta text-muted-foreground">{t('chat.secretRun.reused', { labels: reusedLabels.join(', ') })}</div>
                ) : null}
                <div className="flex items-center gap-1.5 typography-meta text-muted-foreground">
                    <Icon name="shield-check" className="size-3.5 shrink-0" />
                    <span className="min-w-0 flex-1">{t('chat.secretRun.privacy')}</span>
                    <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void send({ declined: true }, 'declined')}>
                        {t('chat.secretRequest.decline')}
                    </Button>
                    <Button type="submit" size="sm" disabled={busy || !complete}>{t('chat.secretRun.submit')}</Button>
                </div>
            </form>
        </div>
    );
}
